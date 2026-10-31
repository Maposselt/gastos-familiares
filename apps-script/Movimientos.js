/**
 * Gastos: listar, revisar duplicados, guardar y corregir.
 * Cada gasto se guarda de a uno y con su tipo confirmado (Familiar o Personal).
 */

const TIPOS = ['Familiar', 'Personal'];
const ORIGENES = ['manual', 'glosa', 'foto', 'excel'];
const MESES_POR_DEFECTO = 12;
const MAXIMO_REVISION = 200;
const SEPARADOR_DETALLE = ' — ';

/**
 * Devuelve los gastos que el usuario puede ver, entre las fechas pedidas
 * (por defecto, los últimos 12 meses), con el reparto de los familiares.
 */
function listarMovimientos_(usuario, datos) {
  const hoy = new Date();
  const desde = (datos.desde && leerFecha_(datos.desde)) ||
    new Date(hoy.getFullYear(), hoy.getMonth() - (MESES_POR_DEFECTO - 1), 1);
  const hasta = datos.hasta ? leerFecha_(datos.hasta) : null;

  const visibles = leerTabla_('Movimientos').filter(function (m) {
    const fecha = leerFecha_(m.fecha);
    return fecha && fecha >= desde && (!hasta || fecha <= hasta) && puedeVer_(usuario, m);
  });

  const familiares = {};
  visibles.forEach(function (m) {
    if (m.tipo === 'Familiar') {
      familiares[m.id] = [];
    }
  });
  leerTabla_('Repartos').forEach(function (r) {
    if (familiares[r.movimiento_id]) {
      familiares[r.movimiento_id].push({
        usuario_id: String(r.usuario_id), porcentaje: Number(r.porcentaje), monto: Number(r.monto)
      });
    }
  });

  return visibles.map(function (m) { return publicarMovimiento_(m, familiares[m.id]); });
}

/** Lo que la app recibe de un gasto (sin la huella interna). */
function publicarMovimiento_(m, repartos) {
  return {
    id: String(m.id),
    fecha: fechaIso_(leerFecha_(m.fecha)),
    monto: Number(m.monto),
    descripcion: String(m.descripcion),
    usuario_id: String(m.usuario_id),
    tipo: String(m.tipo),
    categoria_id: String(m.categoria_id),
    rendir_trabajo: esSi_(m.rendir_trabajo),
    estado: String(m.estado),
    origen: String(m.origen),
    repartos: repartos || []
  };
}

/**
 * Gastos propios "Por revisar" con la misma glosa que uno recién confirmado:
 * ahora el diccionario ya sabe cómo clasificarlos. Cada uno se sigue
 * confirmando por separado.
 */
function pendientesConGlosa_(usuario, glosa, excluirId) {
  const buscada = normalizarGlosa_(glosa);
  if (!buscada) {
    return [];
  }
  return leerTabla_('Movimientos')
    .filter(function (m) {
      return m.estado === 'Por revisar' && m.usuario_id === usuario.id && m.id !== excluirId &&
        normalizarGlosa_(glosaDe_(m)) === buscada;
    })
    .map(function (m) { return publicarMovimiento_(m); });
}

/**
 * Revisa una lista de gastos ANTES de guardarlos (por ejemplo, una importación)
 * y devuelve las alertas de duplicado de cada uno. No guarda nada.
 */
function revisarDuplicados_(usuario, datos) {
  const items = Array.isArray(datos.items) ? datos.items : [];
  if (!items.length || items.length > MAXIMO_REVISION) {
    throw errorPublico_('Envía entre 1 y ' + MAXIMO_REVISION + ' gastos para revisar.');
  }
  const existentes = huellasExistentes_();
  const candidatos = items.map(function (item) {
    const fecha = leerFecha_(item.fecha);
    const monto = leerMonto_(item.monto);
    const glosa = normalizar_(item.descripcion);
    return fecha && monto && glosa ? { fecha: fecha, monto: monto, glosa: glosa } : null;
  });

  return candidatos.map(function (candidato, i) {
    if (!candidato) {
      return { error: 'Fecha, monto o descripción no válidos.' };
    }
    const alertas = buscarDuplicados_(usuario, candidato, existentes);
    candidatos.forEach(function (otro, j) {
      const nivel = j !== i && otro ? nivelDuplicado_(candidato, otro) : null;
      if (nivel) {
        alertas.push({ nivel: nivel, enEstaCarga: j });
      }
    });
    return { alertas: alertas };
  });
}

/**
 * Guarda UN gasto. Si se parece a otro ya guardado, no lo guarda y devuelve
 * las alertas, salvo que venga confirmarDuplicado = true ("Guardar igual").
 * Con porRevisar = true se guarda sin tipo ni categoría, para decidir después.
 */
function guardarMovimiento_(usuario, datos) {
  const porRevisar = datos.porRevisar === true;
  const v = porRevisar ? validarDatosBasicos_(datos) : validarMovimiento_(datos);
  return conCandado_(function () {
    const candidato = { fecha: v.fecha, monto: v.monto, glosa: normalizar_(v.glosa) };
    const alertas = buscarDuplicados_(usuario, candidato, huellasExistentes_());
    if (alertas.length && datos.confirmarDuplicado !== true) {
      return { guardado: false, duplicados: alertas };
    }

    const movimiento = {
      id: 'm-' + Utilities.getUuid(),
      fecha: v.fecha,
      monto: v.monto,
      descripcion: v.descripcion,
      usuario_id: usuario.id,
      tipo: porRevisar ? '' : v.tipo,
      categoria_id: porRevisar ? '' : v.categoria.id,
      rendir_trabajo: !porRevisar && v.rendir ? 'Sí' : 'No',
      estado: porRevisar ? 'Por revisar' : 'Confirmado',
      origen: v.origen,
      huella: huella_(v.fecha, v.monto, v.glosa),
      duplicado_revisado: alertas.length ? 'Sí' : '',
      creado_en: new Date(),
      modificado_en: ''
    };
    agregarFilas_('Movimientos', [movimiento]);
    if (porRevisar) {
      return { guardado: true, id: movimiento.id, pendientes: [] };
    }
    if (v.tipo === 'Familiar') {
      agregarFilas_('Repartos', calcularReparto_(movimiento.id, v.categoria, v.fecha, v.monto));
    }
    aprenderGlosa_(v.glosa, v.tipo, v.categoria.id);
    return { guardado: true, id: movimiento.id, pendientes: pendientesConGlosa_(usuario, v.glosa, movimiento.id) };
  });
}

/**
 * Corrige o confirma un gasto propio (por ejemplo, uno "Por revisar"), o lo
 * anula. Nunca se borra la fila: un gasto anulado queda con estado Anulado.
 */
function actualizarMovimiento_(usuario, datos) {
  return conCandado_(function () {
    const movimiento = leerTabla_('Movimientos').filter(function (m) { return m.id === datos.id; })[0];
    if (!movimiento || movimiento.usuario_id !== usuario.id) {
      throw errorPublico_('No encontré ese gasto, o no es tuyo.');
    }
    const repartosAnteriores = leerTabla_('Repartos')
      .filter(function (r) { return r.movimiento_id === movimiento.id; })
      .map(function (r) { return r._fila; });

    if (datos.estado === 'Anulado') {
      movimiento.estado = 'Anulado';
      movimiento.modificado_en = new Date();
      actualizarFila_('Movimientos', movimiento);
      borrarFilas_('Repartos', repartosAnteriores);
      return { actualizado: true };
    }

    function valor(campo) {
      return Object.prototype.hasOwnProperty.call(datos, campo) ? datos[campo] : movimiento[campo];
    }
    // Si no llega la glosa por separado, se separa la descripción guardada ("glosa — detalle").
    const partesDescripcion = String(movimiento.descripcion).split(SEPARADOR_DETALLE);
    const v = validarMovimiento_({
      fecha: valor('fecha'),
      monto: valor('monto'),
      descripcion: Object.prototype.hasOwnProperty.call(datos, 'descripcion') ? datos.descripcion : partesDescripcion[0],
      detalle: Object.prototype.hasOwnProperty.call(datos, 'detalle') ? datos.detalle : partesDescripcion.slice(1).join(SEPARADOR_DETALLE),
      tipo: valor('tipo'),
      categoria_id: valor('categoria_id'),
      rendir_trabajo: Object.prototype.hasOwnProperty.call(datos, 'rendir_trabajo')
        ? datos.rendir_trabajo === true : esSi_(movimiento.rendir_trabajo),
      origen: movimiento.origen
    });

    // La huella usa solo la glosa del banco: cambiar el detalle no la altera.
    const fechaAnterior = leerFecha_(movimiento.fecha);
    const cambioHuella = !fechaAnterior || fechaIso_(fechaAnterior) !== fechaIso_(v.fecha) ||
      Number(movimiento.monto) !== v.monto || normalizar_(glosaDe_(movimiento)) !== normalizar_(v.glosa);
    const cambioClasificacion = movimiento.tipo !== v.tipo ||
      movimiento.categoria_id !== v.categoria.id || movimiento.estado !== 'Confirmado';
    const cambioReparto = cambioHuella || cambioClasificacion;

    movimiento.fecha = v.fecha;
    movimiento.monto = v.monto;
    movimiento.descripcion = v.descripcion;
    movimiento.tipo = v.tipo;
    movimiento.categoria_id = v.categoria.id;
    movimiento.rendir_trabajo = v.rendir ? 'Sí' : 'No';
    movimiento.estado = 'Confirmado';
    movimiento.modificado_en = new Date();
    if (cambioHuella) {
      movimiento.huella = huella_(v.fecha, v.monto, v.glosa);
    }
    actualizarFila_('Movimientos', movimiento);

    if (cambioReparto) {
      borrarFilas_('Repartos', repartosAnteriores);
      if (v.tipo === 'Familiar') {
        agregarFilas_('Repartos', calcularReparto_(movimiento.id, v.categoria, v.fecha, v.monto));
      }
    }
    if (!cambioClasificacion) {
      return { actualizado: true, pendientes: [] };
    }
    aprenderGlosa_(glosaDe_(movimiento), v.tipo, v.categoria.id);
    return { actualizado: true, pendientes: pendientesConGlosa_(usuario, glosaDe_(movimiento), movimiento.id) };
  });
}

/**
 * Fecha, monto, glosa del banco y detalle opcional. La descripción que se
 * guarda es "glosa — detalle", igual que en el historial.
 */
function validarDatosBasicos_(datos) {
  const fecha = leerFecha_(datos.fecha);
  if (!fecha) {
    throw errorPublico_('La fecha no es válida.');
  }
  const monto = leerMonto_(datos.monto);
  if (!monto) {
    throw errorPublico_('El monto no es válido.');
  }
  const glosa = textoSeguro_(datos.descripcion, 200);
  if (!glosa) {
    throw errorPublico_('Falta la glosa.');
  }
  const detalle = textoSeguro_(datos.detalle, 100);
  return {
    fecha: fecha,
    monto: monto,
    glosa: glosa,
    descripcion: detalle ? glosa + SEPARADOR_DETALLE + detalle : glosa,
    origen: ORIGENES.indexOf(datos.origen) >= 0 ? datos.origen : 'manual'
  };
}

/** Valida un gasto completo (con tipo y categoría) y devuelve los valores limpios. */
function validarMovimiento_(datos) {
  const v = validarDatosBasicos_(datos);
  if (TIPOS.indexOf(datos.tipo) < 0) {
    throw errorPublico_('Debes confirmar si el gasto es Familiar o Personal.');
  }
  const categoria = leerTabla_('Categorias').filter(function (c) { return c.id === datos.categoria_id; })[0];
  if (!categoria || !esSi_(categoria.activa) || categoria.tipo !== datos.tipo) {
    throw errorPublico_('Elige una categoría vigente del tipo ' + datos.tipo + '.');
  }
  v.tipo = datos.tipo;
  v.categoria = categoria;
  v.rendir = datos.tipo === 'Personal' && datos.rendir_trabajo === true;
  return v;
}

// ---------------------------------------------------------------------------
// Duplicados
// ---------------------------------------------------------------------------

/** Gastos guardados (no anulados) con su huella separada en partes. */
function huellasExistentes_() {
  return leerTabla_('Movimientos')
    .filter(function (m) { return m.estado !== 'Anulado'; })
    .map(function (m) {
      const partes = String(m.huella || '').split('|');
      const fecha = partes.length >= 3 ? leerFecha_(partes[0]) : leerFecha_(m.fecha);
      return {
        movimiento: m,
        fecha: fecha,
        monto: partes.length >= 3 ? Number(partes[1]) : Number(m.monto),
        glosa: partes.length >= 3 ? partes.slice(2).join('|') : normalizar_(m.descripcion)
      };
    })
    .filter(function (h) { return h.fecha; });
}

/** Rojo: misma fecha, monto y glosa. Amarillo: mismo monto y glosa con hasta 2 días de diferencia. */
function nivelDuplicado_(a, b) {
  if (!a.glosa || a.glosa !== b.glosa || a.monto !== b.monto) {
    return null;
  }
  const dias = Math.round(Math.abs(a.fecha.getTime() - b.fecha.getTime()) / 86400000);
  if (dias === 0) {
    return 'rojo';
  }
  return dias <= 2 ? 'amarillo' : null;
}

/**
 * Busca en los gastos de ambos usuarios. Si el parecido es con un gasto
 * personal de la otra persona, se avisa sin mostrar su detalle.
 */
function buscarDuplicados_(usuario, candidato, existentes) {
  const alertas = [];
  existentes.forEach(function (h) {
    const nivel = nivelDuplicado_(candidato, h);
    if (!nivel) {
      return;
    }
    if (puedeVer_(usuario, h.movimiento)) {
      alertas.push({
        nivel: nivel,
        id: String(h.movimiento.id),
        fecha: fechaIso_(h.fecha),
        monto: h.monto,
        descripcion: String(h.movimiento.descripcion)
      });
    } else {
      alertas.push({ nivel: nivel, fecha: fechaIso_(h.fecha), monto: h.monto, descripcion: 'Gasto personal de otra persona' });
    }
  });
  return alertas;
}

// ---------------------------------------------------------------------------
// Reparto de gastos familiares
// ---------------------------------------------------------------------------

/**
 * Calcula cuánto le toca a cada usuario según el criterio de la categoría:
 * Proporcional (a los ingresos del mes), 50/50 o 100% a un usuario.
 */
function calcularReparto_(movimientoId, categoria, fecha, monto) {
  const usuarios = usuariosActivos_();
  const criterio = normalizar_(categoria.criterio);
  let proporciones = null;

  if (criterio === '100') {
    if (!usuarios.some(function (u) { return u.id === categoria.usuario_100; })) {
      throw errorPublico_('La categoría está configurada al 100% para un usuario que no existe.');
    }
    proporciones = usuarios.map(function (u) { return u.id === categoria.usuario_100 ? 1 : 0; });
  } else if (criterio === 'proporcional') {
    proporciones = proporcionesPorIngreso_(usuarios, fecha);
  }
  if (!proporciones) {
    proporciones = usuarios.map(function () { return 1 / usuarios.length; });
  }

  let asignado = 0;
  return usuarios.map(function (u, i) {
    const parte = i === usuarios.length - 1 ? monto - asignado : Math.round(monto * proporciones[i]);
    asignado += parte;
    return { movimiento_id: movimientoId, usuario_id: u.id, porcentaje: proporciones[i], monto: parte };
  });
}

/**
 * Proporción de cada usuario según los ingresos del mes del gasto. Si ese mes
 * aún no tiene los ingresos de todos, usa el último mes anterior que sí los tenga.
 * Devuelve null si no hay ningún mes completo.
 */
function proporcionesPorIngreso_(usuarios, fecha) {
  const porMes = {};
  leerTabla_('Ingresos').forEach(function (i) {
    const clave = Number(i.anio) * 12 + Number(i.mes) - 1;
    porMes[clave] = porMes[clave] || {};
    porMes[clave][i.usuario_id] = (porMes[clave][i.usuario_id] || 0) + Number(i.monto);
  });
  const objetivo = fecha.getFullYear() * 12 + fecha.getMonth();
  const mesesCompletos = Object.keys(porMes).map(Number)
    .filter(function (clave) {
      return clave <= objetivo && usuarios.every(function (u) { return porMes[clave][u.id] > 0; });
    })
    .sort(function (a, b) { return b - a; });
  if (!mesesCompletos.length) {
    return null;
  }
  const ingresos = porMes[mesesCompletos[0]];
  const total = usuarios.reduce(function (suma, u) { return suma + ingresos[u.id]; }, 0);
  return usuarios.map(function (u) { return ingresos[u.id] / total; });
}
