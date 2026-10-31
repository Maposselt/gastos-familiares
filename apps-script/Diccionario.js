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
  return sugerirDesde_(diccionarioVigente_(), texto);
}

/** Sugerencias para varias descripciones a la vez (por ejemplo, una cartola). */
function sugerirVarios_(usuario, datos) {
  const descripciones = Array.isArray(datos.descripciones) ? datos.descripciones : [];
  if (!descripciones.length || descripciones.length > MAXIMO_REVISION) {
    throw errorPublico_('Envía entre 1 y ' + MAXIMO_REVISION + ' descripciones.');
  }
  const filas = diccionarioVigente_();
  return descripciones.map(function (texto) { return sugerirDesde_(filas, texto); });
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

function sugerirDesde_(filas, texto) {
  const glosa = normalizarGlosa_(textoSeguro_(texto, 200));
  if (!glosa) {
    return { exacta: false, opciones: [] };
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

  return { exacta: exacta, total: total, opciones: opciones };
}

/**
 * Suma un gasto confirmado al diccionario y recalcula el % de cada categoría
 * para esa glosa. Debe llamarse con el candado tomado.
 */
function aprenderGlosa_(texto, tipo, categoriaId) {
  const glosa = normalizarGlosa_(texto);
  if (!glosa) {
    return;
  }
  const filas = leerTabla_('Diccionario').filter(function (d) {
    return String(d.glosa_normalizada) === glosa;
  });
  let fila = filas.filter(function (d) { return d.tipo === tipo && d.categoria_id === categoriaId; })[0];
  const nueva = !fila;
  if (nueva) {
    fila = { glosa_normalizada: glosa, tipo: tipo, categoria_id: categoriaId, veces: 0 };
    filas.push(fila);
  }
  fila.veces = Number(fila.veces) + 1;

  const total = filas.reduce(function (suma, d) { return suma + Number(d.veces); }, 0);
  const ahora = new Date();
  filas.forEach(function (d) {
    d.total_registros = total;
    d.porcentaje = Number(d.veces) / total;
    d.actualizado_en = ahora;
    if (d !== fila || !nueva) {
      actualizarFila_('Diccionario', d);
    }
  });
  if (nueva) {
    agregarFilas_('Diccionario', [fila]);
  }
}

/** Glosa original de un gasto: la guardada en su huella, o su descripción. */
function glosaDe_(movimiento) {
  const partes = String(movimiento.huella || '').split('|');
  return partes.length >= 3 ? partes.slice(2).join('|') : String(movimiento.descripcion);
}
