/**
 * Balance entre ustedes y rendición de gastos al trabajo.
 *
 * Por cada gasto familiar confirmado, quien lo registró es quien lo pagó, y
 * la "parte" de cada uno sale de la pestaña Repartos. Lo que pagó cada uno
 * menos su parte es su "neto": positivo = le deben; negativo = debe.
 * Un mes "saldado" queda en cero; si después cambia, solo cuenta la diferencia.
 *
 * El mes desde el que se cuenta se guarda en Script Properties (INICIO_SALDOS).
 */

const PROPIEDAD_INICIO_SALDOS = 'INICIO_SALDOS';

function inicioSaldos_() {
  const valor = PropertiesService.getScriptProperties().getProperty(PROPIEDAD_INICIO_SALDOS);
  return /^\d{4}-\d{2}$/.test(String(valor || '')) ? valor : null;
}

/** "2026-11" válido (mes 1 a 12), o null. */
function leerAnioMes_(valor) {
  const texto = String(valor || '');
  if (!/^\d{4}-\d{2}$/.test(texto)) {
    return null;
  }
  const mes = Number(texto.slice(5));
  const anio = Number(texto.slice(0, 4));
  return mes >= 1 && mes <= 12 && anio >= 2000 && anio <= 2100 ? texto : null;
}

function claveMes_(fecha) {
  return fechaIso_(fecha).slice(0, 7);
}

/** Solo el administrador elige desde qué mes se cuenta el balance. */
function guardarInicioSaldos_(usuario, datos) {
  exigirAdmin_(usuario);
  const mes = leerAnioMes_(datos.mes);
  if (!mes) {
    throw errorPublico_('El mes no es válido.');
  }
  PropertiesService.getScriptProperties().setProperty(PROPIEDAD_INICIO_SALDOS, mes);
  return { inicio: mes };
}

/**
 * Pagado, parte y neto de cada usuario por mes, desde el mes de inicio.
 * Devuelve { 'AAAA-MM': { pagado: {id: $}, parte: {id: $} } }.
 */
function balancePorMes_(usuarios, inicio) {
  const meses = {};
  function delMes(clave) {
    if (!meses[clave]) {
      meses[clave] = { pagado: {}, parte: {} };
      usuarios.forEach(function (u) {
        meses[clave].pagado[u.id] = 0;
        meses[clave].parte[u.id] = 0;
      });
    }
    return meses[clave];
  }

  const familiares = {};
  leerTabla_('Movimientos').forEach(function (m) {
    const fecha = leerFecha_(m.fecha);
    if (m.tipo !== 'Familiar' || m.estado !== 'Confirmado' || !fecha) {
      return;
    }
    const clave = claveMes_(fecha);
    if (clave < inicio) {
      return;
    }
    familiares[m.id] = clave;
    const mes = delMes(clave);
    mes.pagado[m.usuario_id] = (mes.pagado[m.usuario_id] || 0) + Number(m.monto);
  });
  leerTabla_('Repartos').forEach(function (r) {
    const clave = familiares[r.movimiento_id];
    if (clave) {
      const mes = delMes(clave);
      mes.parte[r.usuario_id] = (mes.parte[r.usuario_id] || 0) + Number(r.monto);
    }
  });
  return meses;
}

function netosDe_(mes) {
  const netos = {};
  Object.keys(mes.pagado).concat(Object.keys(mes.parte)).forEach(function (id) {
    netos[id] = Math.round((mes.pagado[id] || 0) - (mes.parte[id] || 0));
  });
  return netos;
}

function netosATexto_(netos) {
  return Object.keys(netos).sort().map(function (id) { return id + '=' + netos[id]; }).join('|');
}

function textoANetos_(texto) {
  const netos = {};
  String(texto || '').split('|').forEach(function (par) {
    const partes = par.split('=');
    if (partes.length === 2 && partes[0]) {
      netos[partes[0]] = Number(partes[1]) || 0;
    }
  });
  return netos;
}

/** Balance de todos los meses desde el inicio, saldo acumulado y mis gastos por rendir. */
function resumenBalance_(usuario) {
  const inicio = inicioSaldos_();
  const usuarios = usuariosActivos_();
  const resultado = { inicio: inicio, meses: [], acumulado: {}, rendicion: rendicionDe_(usuario) };
  usuarios.forEach(function (u) { resultado.acumulado[u.id] = 0; });
  if (!inicio) {
    return resultado;
  }

  const porMes = balancePorMes_(usuarios, inicio);
  const saldados = {};
  leerTabla_('Saldos').forEach(function (s) {
    saldados[Number(s.anio) + '-' + String(Number(s.mes)).padStart(2, '0')] = s;
  });
  const nombres = {};
  usuarios.forEach(function (u) { nombres[u.id] = u.nombre; });

  // Se muestran todos los meses desde el inicio hasta hoy (o hasta el último con gastos).
  const hoy = claveMes_(new Date());
  const ultimo = Object.keys(porMes).concat([hoy]).sort().pop();
  let clave = inicio;
  while (clave <= ultimo) {
    const mes = porMes[clave] || { pagado: {}, parte: {} };
    const netos = netosDe_(mes);
    const saldo = saldados[clave];
    const netosSaldados = saldo ? textoANetos_(saldo.netos) : {};
    const ids = Object.keys(netos).concat(Object.keys(netosSaldados))
      .filter(function (id, i, lista) { return lista.indexOf(id) === i; });
    // Lo que todavía se debe de ese mes: todo si no está saldado; si lo está, solo lo que cambió después.
    const pendiente = {};
    ids.forEach(function (id) {
      pendiente[id] = (netos[id] || 0) - (netosSaldados[id] || 0);
      resultado.acumulado[id] = (resultado.acumulado[id] || 0) + pendiente[id];
    });
    resultado.meses.push({
      mes: clave,
      pagado: mes.pagado,
      parte: mes.parte,
      netos: netos,
      saldado: saldo ? {
        por: nombres[saldo.saldado_por] || String(saldo.saldado_por),
        en: fechaIso_(leerFecha_(saldo.saldado_en) || new Date(0)),
        cambio: ids.some(function (id) { return pendiente[id] !== 0; })
      } : null
    });
    clave = siguienteMes_(clave);
  }
  resultado.meses.reverse();
  return resultado;
}

function siguienteMes_(clave) {
  const anio = Number(clave.slice(0, 4));
  const mes = Number(clave.slice(5));
  return mes === 12 ? (anio + 1) + '-01' : anio + '-' + String(mes + 1).padStart(2, '0');
}

/**
 * Marca (o desmarca) un mes como saldado. Guarda los netos de ese momento,
 * para avisar si el mes cambia después. Cualquiera de los dos puede hacerlo.
 */
function marcarSaldado_(usuario, datos) {
  const inicio = inicioSaldos_();
  const clave = leerAnioMes_(datos.mes);
  if (!inicio) {
    throw errorPublico_('Primero el administrador debe elegir el mes de inicio en Config.');
  }
  if (!clave || clave < inicio || clave > claveMes_(new Date())) {
    throw errorPublico_('Ese mes no se puede saldar.');
  }
  return conCandado_(function () {
    const anio = Number(clave.slice(0, 4));
    const mes = Number(clave.slice(5));
    const existentes = leerTabla_('Saldos').filter(function (s) {
      return Number(s.anio) === anio && Number(s.mes) === mes;
    });
    // Al volver a saldar un mes que cambió, se reemplaza el registro anterior.
    borrarFilas_('Saldos', existentes.map(function (s) { return s._fila; }));
    if (datos.saldado === true) {
      const porMes = balancePorMes_(usuariosActivos_(), clave);
      agregarFilas_('Saldos', [{
        anio: anio, mes: mes,
        netos: netosATexto_(netosDe_(porMes[clave] || { pagado: {}, parte: {} })),
        saldado_por: usuario.id,
        saldado_en: new Date()
      }]);
    }
    return { guardado: true };
  });
}

/** Mis gastos personales confirmados marcados "Rendir al trabajo", con su estado de rendición. */
function rendicionDe_(usuario) {
  const rendidos = {};
  leerTabla_('Rendiciones').forEach(function (r) { rendidos[r.movimiento_id] = r.rendido_en; });
  return leerTabla_('Movimientos')
    .filter(function (m) {
      return m.usuario_id === usuario.id && m.tipo === 'Personal' && m.estado === 'Confirmado' &&
        esSi_(m.rendir_trabajo) && leerFecha_(m.fecha);
    })
    .map(function (m) {
      const gasto = publicarMovimiento_(m);
      const fecha = rendidos[m.id] ? leerFecha_(rendidos[m.id]) : null;
      gasto.rendido = Object.prototype.hasOwnProperty.call(rendidos, m.id);
      gasto.rendido_en = fecha ? fechaIso_(fecha) : '';
      return gasto;
    })
    .sort(function (a, b) { return b.fecha.localeCompare(a.fecha); });
}

/** Marca (o desmarca) un gasto propio como rendido al trabajo. */
function marcarRendido_(usuario, datos) {
  return conCandado_(function () {
    const movimiento = leerTabla_('Movimientos').filter(function (m) { return m.id === datos.id; })[0];
    if (!movimiento || movimiento.usuario_id !== usuario.id || movimiento.tipo !== 'Personal' ||
        movimiento.estado !== 'Confirmado' || !esSi_(movimiento.rendir_trabajo)) {
      throw errorPublico_('No encontré ese gasto por rendir, o no es tuyo.');
    }
    const existentes = leerTabla_('Rendiciones').filter(function (r) { return r.movimiento_id === movimiento.id; });
    borrarFilas_('Rendiciones', existentes.map(function (r) { return r._fila; }));
    if (datos.rendido === true) {
      agregarFilas_('Rendiciones', [{ movimiento_id: movimiento.id, rendido_en: new Date() }]);
    }
    return { guardado: true };
  });
}
