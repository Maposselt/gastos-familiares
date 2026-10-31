/**
 * Diccionario glosa → tipo y categoría, construido con el historial y con
 * cada gasto confirmado. Las sugerencias no usan IA: son gratis.
 */

const LARGO_MINIMO_BUSQUEDA_PARCIAL = 4;

/**
 * Sugerencias para una glosa, ordenadas de la más a la menos frecuente.
 * Recibe la descripción escrita, o el id de un gasto ya guardado (en ese caso
 * se usa la glosa original del banco, sin el detalle agregado).
 * Primero busca la glosa exacta; si no hay, glosas que empiecen igual.
 */
function sugerir_(usuario, datos) {
  let texto = datos.descripcion;
  if (datos.id) {
    const movimiento = leerTabla_('Movimientos').filter(function (m) { return m.id === datos.id; })[0];
    if (!movimiento || !puedeVer_(usuario, movimiento)) {
      return { exacta: false, opciones: [] };
    }
    texto = glosaDe_(movimiento);
  }
  return sugerirDesde_(diccionarioVigente_(), texto, detallesPorGlosa_(usuario));
}

/** Sugerencias para varias descripciones a la vez (por ejemplo, una cartola). */
function sugerirVarios_(usuario, datos) {
  const descripciones = Array.isArray(datos.descripciones) ? datos.descripciones : [];
  if (!descripciones.length || descripciones.length > MAXIMO_REVISION) {
    throw errorPublico_('Envía entre 1 y ' + MAXIMO_REVISION + ' descripciones.');
  }
  const filas = diccionarioVigente_();
  const detalles = detallesPorGlosa_(usuario);
  return descripciones.map(function (texto) { return sugerirDesde_(filas, texto, detalles); });
}

/**
 * Detalles que se agregaron antes a cada glosa ("glosa — detalle"), solo de
 * los gastos que este usuario puede ver. Las variantes que solo cambian en
 * tildes o mayúsculas cuentan como el mismo detalle.
 * Devuelve { glosa: { detalleNormalizado: { texto, veces } } }.
 */
function detallesPorGlosa_(usuario) {
  const resultado = {};
  leerTabla_('Movimientos').forEach(function (m) {
    const partes = String(m.descripcion).split(SEPARADOR_DETALLE);
    const detalle = partes.slice(1).join(SEPARADOR_DETALLE).trim();
    const clave = normalizar_(detalle);
    if (!clave || m.estado === 'Anulado' || !puedeVer_(usuario, m)) {
      return;
    }
    const glosa = normalizarGlosa_(glosaDe_(m));
    resultado[glosa] = resultado[glosa] || {};
    resultado[glosa][clave] = resultado[glosa][clave] || { texto: detalle, veces: 0 };
    resultado[glosa][clave].veces++;
  });
  return resultado;
}

/** Los 3 detalles más usados entre las glosas encontradas. */
function detallesFrecuentes_(detalles, glosas) {
  const conteo = {};
  glosas.forEach(function (g) {
    Object.keys(detalles[g] || {}).forEach(function (clave) {
      const d = detalles[g][clave];
      conteo[clave] = conteo[clave] || { texto: d.texto, veces: 0 };
      conteo[clave].veces += d.veces;
    });
  });
  return Object.keys(conteo)
    .sort(function (a, b) { return conteo[b].veces - conteo[a].veces; })
    .slice(0, 3)
    .map(function (clave) { return conteo[clave].texto; });
}

/** Filas del diccionario cuya categoría sigue activa y es del mismo tipo. */
function diccionarioVigente_() {
  const vigentes = {};
  leerTabla_('Categorias').forEach(function (c) {
    if (esSi_(c.activa)) {
      vigentes[c.id] = c.tipo;
    }
  });
  return leerTabla_('Diccionario').filter(function (d) {
    return vigentes[d.categoria_id] === d.tipo;
  });
}

function sugerirDesde_(filas, texto, detalles) {
  const glosa = normalizarGlosa_(textoSeguro_(texto, 200));
  if (!glosa) {
    return { exacta: false, opciones: [], detalles: [] };
  }

  let coincidencias = filas.filter(function (d) { return String(d.glosa_normalizada) === glosa; });
  const exacta = coincidencias.length > 0;
  if (!exacta && glosa.length >= LARGO_MINIMO_BUSQUEDA_PARCIAL) {
    coincidencias = filas.filter(function (d) {
      const g = String(d.glosa_normalizada);
      return g.indexOf(glosa + ' ') === 0 || glosa.indexOf(g + ' ') === 0;
    });
  }

  const porCategoria = {};
  let total = 0;
  coincidencias.forEach(function (d) {
    const clave = d.tipo + '|' + d.categoria_id;
    porCategoria[clave] = (porCategoria[clave] || 0) + Number(d.veces);
    total += Number(d.veces);
  });
  const opciones = Object.keys(porCategoria).map(function (clave) {
    const partes = clave.split('|');
    return {
      tipo: partes[0],
      categoria_id: partes[1],
      veces: porCategoria[clave],
      porcentaje: porCategoria[clave] / total
    };
  }).sort(function (a, b) { return b.veces - a.veces; });

  const glosasEncontradas = [glosa].concat(coincidencias.map(function (d) { return String(d.glosa_normalizada); }));
  return {
    exacta: exacta,
    total: total,
    opciones: opciones,
    detalles: detalles ? detallesFrecuentes_(detalles, glosasEncontradas.filter(function (g, i, lista) { return lista.indexOf(g) === i; })) : []
  };
}

/**
 * Suma un gasto confirmado al diccionario y recalcula el % de cada categoría
 * para esa glosa. Debe llamarse con el candado tomado.
 */
function aprenderGlosa_(texto, tipo, categoriaId) {
  const filas = leerTabla_('Diccionario');
  sumarAlDiccionario_(filas, texto, tipo, categoriaId);
  escribirDiccionario_(filas);
}

/**
 * Suma una vez la glosa con su categoría en la lista del diccionario (en
 * memoria) y marca las filas que cambiaron. No escribe en la planilla.
 */
function sumarAlDiccionario_(filas, texto, tipo, categoriaId) {
  const glosa = normalizarGlosa_(texto);
  if (!glosa) {
    return;
  }
  const deLaGlosa = filas.filter(function (d) { return String(d.glosa_normalizada) === glosa; });
  let fila = deLaGlosa.filter(function (d) { return d.tipo === tipo && d.categoria_id === categoriaId; })[0];
  if (!fila) {
    fila = { glosa_normalizada: glosa, tipo: tipo, categoria_id: categoriaId, veces: 0 };
    filas.push(fila);
    deLaGlosa.push(fila);
  }
  fila.veces = Number(fila.veces) + 1;

  const total = deLaGlosa.reduce(function (suma, d) { return suma + Number(d.veces); }, 0);
  const ahora = new Date();
  deLaGlosa.forEach(function (d) {
    d.total_registros = total;
    d.porcentaje = Number(d.veces) / total;
    d.actualizado_en = ahora;
    d._cambio = true;
  });
}

/** Escribe las filas del diccionario que cambiaron: actualiza las existentes y agrega las nuevas. */
function escribirDiccionario_(filas) {
  const nuevas = [];
  filas.forEach(function (d) {
    if (!d._cambio) {
      return;
    }
    if (d._fila) {
      actualizarFila_('Diccionario', d);
    } else {
      nuevas.push(d);
    }
  });
  agregarFilas_('Diccionario', nuevas);
}

/** Glosa original de un gasto: la guardada en su huella, o su descripción. */
function glosaDe_(movimiento) {
  const partes = String(movimiento.huella || '').split('|');
  return partes.length >= 3 ? partes.slice(2).join('|') : String(movimiento.descripcion);
}
