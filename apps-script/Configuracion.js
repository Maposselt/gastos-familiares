/**
 * Estructura de la planilla: nombre de cada pestaña y sus columnas, en orden.
 * Aquí solo se define la FORMA de los datos. Los datos en sí (categorías,
 * usuarios, correos) nunca se escriben en el código.
 */
const ESTRUCTURA = {
  Movimientos: [
    'id', 'fecha', 'monto', 'descripcion', 'usuario_id', 'tipo', 'categoria_id',
    'rendir_trabajo', 'estado', 'origen', 'huella', 'duplicado_revisado',
    'creado_en', 'modificado_en'
  ],
  Repartos: ['movimiento_id', 'usuario_id', 'porcentaje', 'monto'],
  Ingresos: ['id', 'usuario_id', 'anio', 'mes', 'monto', 'creado_en'],
  Categorias: [
    'id', 'tipo', 'categoria', 'subcategoria', 'criterio', 'usuario_100',
    'activa', 'orden'
  ],
  Usuarios: ['id', 'nombre_visible', 'rol', 'activo'],
  Diccionario: [
    'glosa_normalizada', 'tipo', 'categoria_id', 'veces', 'porcentaje',
    'total_registros', 'actualizado_en'
  ],
  UsoIA: [
    'fecha_hora', 'usuario_id', 'tipo_entrada', 'tokens_entrada',
    'tokens_salida', 'costo_usd'
  ]
};

/**
 * Formato de cada columna según su nombre. Con la configuración regional de
 * Chile, '#,##0' muestra los miles con punto (1.044.789).
 * '@' significa "texto": evita que Sheets convierta los códigos en números.
 */
const FORMATOS = {
  id: '@',
  movimiento_id: '@',
  usuario_id: '@',
  categoria_id: '@',
  usuario_100: '@',
  huella: '@',
  glosa_normalizada: '@',
  fecha: 'dd/mm/yyyy',
  fecha_hora: 'dd/mm/yyyy hh:mm',
  creado_en: 'dd/mm/yyyy hh:mm',
  modificado_en: 'dd/mm/yyyy hh:mm',
  actualizado_en: 'dd/mm/yyyy hh:mm',
  monto: '#,##0',
  porcentaje: '0.0%',
  costo_usd: '0.0000'
};

/**
 * Prepara la planilla: crea las pestañas que falten con sus encabezados y
 * formatos. Se ejecuta a mano una vez desde el editor de Apps Script.
 * Es seguro ejecutarla de nuevo: no toca las pestañas que ya existen.
 */
function configurarPlanilla() {
  const planilla = SpreadsheetApp.getActiveSpreadsheet();
  planilla.setSpreadsheetTimeZone('America/Santiago');
  planilla.setSpreadsheetLocale('es_CL');

  const creadas = [];
  Object.keys(ESTRUCTURA).forEach(function (nombre) {
    if (crearPestanaSiNoExiste_(planilla, nombre, ESTRUCTURA[nombre])) {
      creadas.push(nombre);
    }
  });
  eliminarHojasInicialesVacias_(planilla);

  Logger.log(creadas.length
    ? 'Pestañas creadas: ' + creadas.join(', ')
    : 'No se creó nada: todas las pestañas ya existían.');
}

/**
 * Crea una pestaña con su fila de encabezados. Devuelve true si la creó y
 * false si ya existía (en ese caso no la modifica).
 * El "_" al final del nombre hace que la función sea privada: no aparece en
 * el menú de ejecución ni se puede llamar desde afuera del script.
 */
function crearPestanaSiNoExiste_(planilla, nombre, columnas) {
  if (planilla.getSheetByName(nombre)) {
    return false;
  }
  const hoja = planilla.insertSheet(nombre);
  hoja.getRange(1, 1, 1, columnas.length)
    .setValues([columnas])
    .setFontWeight('bold')
    .setBackground('#e8eef7');
  hoja.setFrozenRows(1);

  const filasDeDatos = hoja.getMaxRows() - 1;
  columnas.forEach(function (columna, i) {
    if (FORMATOS[columna]) {
      hoja.getRange(2, i + 1, filasDeDatos, 1).setNumberFormat(FORMATOS[columna]);
    }
  });
  hoja.autoResizeColumns(1, columnas.length);
  return true;
}

/**
 * Renumera el orden de las subcategorías como 1, 2, 3… dentro de cada
 * categoría, respetando el orden que tenían. Se ejecuta a mano una vez desde
 * el editor. Es seguro ejecutarla de nuevo: solo reordena la columna "orden".
 */
function renumerarOrdenCategorias() {
  const categorias = leerTabla_('Categorias');
  const grupos = {};
  categorias.forEach(function (c) {
    const clave = c.tipo + '|' + normalizar_(c.categoria);
    (grupos[clave] = grupos[clave] || []).push(c);
  });
  let cambios = 0;
  Object.keys(grupos).forEach(function (clave) {
    grupos[clave]
      .sort(function (a, b) { return (Number(a.orden) || 0) - (Number(b.orden) || 0); })
      .forEach(function (c, i) {
        if (Number(c.orden) !== i + 1) {
          c.orden = i + 1;
          actualizarFila_('Categorias', c);
          cambios++;
        }
      });
  });
  Logger.log('Subcategorías renumeradas: ' + cambios + ' de ' + categorias.length);
}

/**
 * Quita el prefijo "Histórico: " de las descripciones de los totales mensuales
 * importados del Excel. Se ejecuta a mano una vez desde el editor. Solo toca
 * las celdas que empiezan con ese prefijo; es seguro ejecutarla de nuevo.
 */
function quitarPrefijoHistorico() {
  const prefijo = 'Histórico: ';
  const hoja = hoja_('Movimientos');
  const columna = encabezados_(hoja, 'Movimientos').indexOf('descripcion') + 1;
  const cantidad = hoja.getLastRow() - 1;
  if (cantidad < 1) {
    return;
  }
  const valores = hoja.getRange(2, columna, cantidad, 1).getValues();

  // Se escriben solo los tramos de filas seguidas que cambian, nunca la columna completa.
  let cambios = 0;
  let inicio = -1;
  let tramo = [];
  function escribirTramo() {
    if (tramo.length) {
      hoja.getRange(inicio + 2, columna, tramo.length, 1).setValues(tramo);
    }
    tramo = [];
    inicio = -1;
  }
  valores.forEach(function (fila, i) {
    const texto = String(fila[0]);
    if (texto.indexOf(prefijo) === 0) {
      if (inicio < 0) {
        inicio = i;
      }
      tramo.push([texto.slice(prefijo.length)]);
      cambios++;
    } else {
      escribirTramo();
    }
  });
  escribirTramo();
  Logger.log('Descripciones corregidas: ' + cambios);
}

/**
 * Borra las hojas vacías que Google crea por defecto ("Hoja 1" o "Sheet1"),
 * pero solo si no son parte de la estructura y no tienen ningún dato.
 */
function eliminarHojasInicialesVacias_(planilla) {
  planilla.getSheets().forEach(function (hoja) {
    const esNuestra = Object.prototype.hasOwnProperty.call(ESTRUCTURA, hoja.getName());
    if (!esNuestra && hoja.getLastRow() === 0 && planilla.getSheets().length > 1) {
      planilla.deleteSheet(hoja);
    }
  });
}
