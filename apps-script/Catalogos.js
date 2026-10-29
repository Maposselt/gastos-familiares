/**
 * Categorías (las administra solo el admin) e ingresos mensuales.
 */

const CRITERIOS_FAMILIARES = ['Proporcional', '50/50', '100%'];

/** Todas las categorías, incluidas las desactivadas (el historial las usa). */
function listarCategorias_() {
  return leerTabla_('Categorias')
    .map(function (c) {
      return {
        id: String(c.id),
        tipo: String(c.tipo),
        categoria: String(c.categoria),
        subcategoria: String(c.subcategoria),
        criterio: String(c.criterio),
        usuario_100: String(c.usuario_100),
        activa: esSi_(c.activa),
        orden: Number(c.orden) || 0
      };
    })
    .sort(function (a, b) { return a.orden - b.orden; });
}

/**
 * Crea una categoría nueva (sin id) o modifica una existente (con id).
 * Las categorías no se borran: se desactivan con activa = false.
 * El tipo de una categoría existente no se puede cambiar, para no dejar
 * gastos guardados con una categoría del tipo equivocado.
 */
function guardarCategoria_(usuario, datos) {
  exigirAdmin_(usuario);
  return conCandado_(function () {
    const categorias = leerTabla_('Categorias');
    const existente = datos.id
      ? categorias.filter(function (c) { return c.id === datos.id; })[0]
      : null;
    if (datos.id && !existente) {
      throw errorPublico_('No encontré esa categoría.');
    }

    const tipo = existente ? existente.tipo : datos.tipo;
    if (TIPOS.indexOf(tipo) < 0) {
      throw errorPublico_('El tipo debe ser Familiar o Personal.');
    }
    const nombre = textoSeguro_(datos.categoria, 60);
    const subcategoria = textoSeguro_(datos.subcategoria, 60);
    if (!nombre || !subcategoria) {
      throw errorPublico_('Faltan la categoría o la subcategoría.');
    }
    const repetida = categorias.some(function (c) {
      return c.id !== datos.id && c.tipo === tipo &&
        normalizar_(c.categoria) === normalizar_(nombre) &&
        normalizar_(c.subcategoria) === normalizar_(subcategoria);
    });
    if (repetida) {
      throw errorPublico_('Ya existe esa categoría y subcategoría para el tipo ' + tipo + '.');
    }

    let criterio = '';
    let usuario100 = '';
    if (tipo === 'Familiar') {
      criterio = datos.criterio;
      if (CRITERIOS_FAMILIARES.indexOf(criterio) < 0) {
        throw errorPublico_('El criterio debe ser Proporcional, 50/50 o 100%.');
      }
      if (criterio === '100%') {
        usuario100 = String(datos.usuario_100 || '');
        if (!usuariosActivos_().some(function (u) { return u.id === usuario100; })) {
          throw errorPublico_('Elige a quién se le asigna el 100%.');
        }
      }
    }

    const ordenMaximo = categorias.reduce(function (max, c) { return Math.max(max, Number(c.orden) || 0); }, 0);
    const fila = existente || { id: siguienteIdCategoria_(categorias), tipo: tipo };
    fila.categoria = nombre;
    fila.subcategoria = subcategoria;
    fila.criterio = criterio;
    fila.usuario_100 = usuario100;
    fila.activa = datos.activa === false ? 'No' : 'Sí';
    fila.orden = Number(datos.orden) > 0 ? Math.round(Number(datos.orden)) : (existente ? existente.orden : ordenMaximo + 1);

    if (existente) {
      actualizarFila_('Categorias', fila);
    } else {
      agregarFilas_('Categorias', [fila]);
    }
    return { id: fila.id };
  });
}

function siguienteIdCategoria_(categorias) {
  const mayor = categorias.reduce(function (max, c) {
    const m = /^c-(\d+)$/.exec(String(c.id));
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return 'c-' + String(mayor + 1).padStart(3, '0');
}

/** Ingresos de ambos usuarios (se necesitan para entender el reparto proporcional). */
function listarIngresos_(usuario, datos) {
  const anio = Number(datos.anio) || null;
  return leerTabla_('Ingresos')
    .filter(function (i) { return !anio || Number(i.anio) === anio; })
    .map(function (i) {
      return { usuario_id: String(i.usuario_id), anio: Number(i.anio), mes: Number(i.mes), monto: Number(i.monto) };
    });
}

/** Cada usuario registra solo su propio ingreso. Si el mes ya existe, se reemplaza. */
function guardarIngreso_(usuario, datos) {
  const anio = Number(datos.anio);
  const mes = Number(datos.mes);
  const monto = leerMonto_(datos.monto);
  if (!(anio >= 2000 && anio <= 2100 && Math.floor(anio) === anio)) {
    throw errorPublico_('El año no es válido.');
  }
  if (!(mes >= 1 && mes <= 12 && Math.floor(mes) === mes)) {
    throw errorPublico_('El mes no es válido.');
  }
  if (!monto || monto < 0) {
    throw errorPublico_('El monto no es válido.');
  }
  return conCandado_(function () {
    const existente = leerTabla_('Ingresos').filter(function (i) {
      return i.usuario_id === usuario.id && Number(i.anio) === anio && Number(i.mes) === mes;
    })[0];
    if (existente) {
      existente.monto = monto;
      actualizarFila_('Ingresos', existente);
    } else {
      agregarFilas_('Ingresos', [{
        id: 'i-' + Utilities.getUuid(), usuario_id: usuario.id, anio: anio, mes: mes,
        monto: monto, creado_en: new Date()
      }]);
    }
    return { guardado: true };
  });
}
