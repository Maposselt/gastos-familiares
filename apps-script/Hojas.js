/**
 * Lectura y escritura de las pestañas. Cada fila se maneja como un objeto
 * cuyas propiedades son los nombres de las columnas (ver ESTRUCTURA).
 */

function hoja_(nombre) {
  const hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!hoja) {
    throw new Error('Falta la pestaña ' + nombre);
  }
  return hoja;
}

/** Encabezados de la pestaña, verificando que estén todas las columnas esperadas. */
function encabezados_(hoja, nombre) {
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String);
  const faltantes = ESTRUCTURA[nombre].filter(function (c) { return encabezados.indexOf(c) < 0; });
  if (faltantes.length) {
    throw new Error('A la pestaña ' + nombre + ' le faltan columnas: ' + faltantes.join(', '));
  }
  return encabezados;
}

/** Devuelve todas las filas con datos. Cada objeto incluye _fila (número de fila). */
function leerTabla_(nombre) {
  const hoja = hoja_(nombre);
  const encabezados = encabezados_(hoja, nombre);
  if (hoja.getLastRow() < 2) {
    return [];
  }
  const valores = hoja.getRange(2, 1, hoja.getLastRow() - 1, encabezados.length).getValues();
  const filas = [];
  valores.forEach(function (valoresFila, i) {
    if (valoresFila.every(function (v) { return v === ''; })) {
      return;
    }
    const objeto = { _fila: i + 2 };
    encabezados.forEach(function (h, j) { objeto[h] = valoresFila[j]; });
    filas.push(objeto);
  });
  return filas;
}

function agregarFilas_(nombre, objetos) {
  if (!objetos.length) {
    return;
  }
  const hoja = hoja_(nombre);
  const encabezados = encabezados_(hoja, nombre);
  const filas = objetos.map(function (o) {
    return encabezados.map(function (h) { return o[h] === undefined ? '' : o[h]; });
  });
  hoja.getRange(hoja.getLastRow() + 1, 1, filas.length, encabezados.length).setValues(filas);
}

/** Reemplaza una fila completa con los valores del objeto (debe traer _fila). */
function actualizarFila_(nombre, objeto) {
  const hoja = hoja_(nombre);
  const encabezados = encabezados_(hoja, nombre);
  const fila = encabezados.map(function (h) { return objeto[h] === undefined ? '' : objeto[h]; });
  hoja.getRange(objeto._fila, 1, 1, encabezados.length).setValues([fila]);
}

/** Borra filas por número, de abajo hacia arriba para no desordenar los números. */
function borrarFilas_(nombre, numerosDeFila) {
  const hoja = hoja_(nombre);
  numerosDeFila.slice().sort(function (a, b) { return b - a; }).forEach(function (n) {
    hoja.deleteRow(n);
  });
}

/**
 * Ejecuta una función con el candado del script tomado, para que dos personas
 * guardando al mismo tiempo no se pisen.
 */
function conCandado_(funcion) {
  const candado = LockService.getScriptLock();
  if (!candado.tryLock(20000)) {
    throw errorPublico_('La planilla está ocupada. Intenta de nuevo en unos segundos.');
  }
  try {
    return funcion();
  } finally {
    candado.releaseLock();
  }
}
