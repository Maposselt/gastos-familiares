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
  ],
  // Meses saldados entre ustedes. "netos" guarda cuánto quedó a favor o en
  // contra de cada uno al saldar (por ejemplo "u1=45300|u2=-45300").
  Saldos: ['anio', 'mes', 'netos', 'saldado_por', 'saldado_en'],
  // Gastos personales ya rendidos al trabajo.
  Rendiciones: ['movimiento_id', 'rendido_en']
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
  saldado_en: 'dd/mm/yyyy hh:mm',
  rendido_en: 'dd/mm/yyyy hh:mm',
  netos: '@',
  saldado_por: '@',
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
 * Convierte las fechas de Movimientos guardadas como texto (por ejemplo
 * "15/03/2025") en fechas de verdad, para que las fórmulas las entiendan.
 * El día no cambia: se lee igual que en la app. Solo toca la columna "fecha"
 * y solo las filas que cambian. Se ejecuta a mano desde el editor; es seguro
 * ejecutarla de nuevo.
 */
function convertirFechasTexto() {
  conCandado_(function () {
    const hoja = hoja_('Movimientos');
    const columna = encabezados_(hoja, 'Movimientos').indexOf('fecha') + 1;
    const cantidad = hoja.getLastRow() - 1;
    if (cantidad < 1) {
      return;
    }
    const valores = hoja.getRange(2, columna, cantidad, 1).getValues();

    let convertidas = 0;
    let ilegibles = 0;
    let inicio = -1;
    let tramo = [];
    function escribirTramo() {
      if (tramo.length) {
        hoja.getRange(inicio + 2, columna, tramo.length, 1)
          .setNumberFormat(FORMATOS.fecha)
          .setValues(tramo);
      }
      tramo = [];
      inicio = -1;
    }
    valores.forEach(function (fila, i) {
      const valor = fila[0];
      const esTexto = valor !== '' && Object.prototype.toString.call(valor) !== '[object Date]';
      const fecha = esTexto ? leerFecha_(valor) : null;
      if (fecha) {
        if (inicio < 0) {
          inicio = i;
        }
        tramo.push([fecha]);
        convertidas++;
      } else {
        if (esTexto) {
          ilegibles++;
        }
        escribirTramo();
      }
    });
    escribirTramo();
    Logger.log('Fechas convertidas: ' + convertidas +
      (ilegibles ? '. No se pudieron leer ' + ilegibles + ' (quedaron igual).' : '. Todas se pudieron leer.'));
  });
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

/**
 * Crea la pestaña "Resumen" para el dashboard: totales por mes, tipo y
 * categoría de los gastos confirmados de los últimos 13 meses, SOLO
 * familiares y personales del administrador (los personales de los demás
 * quedan fuera). Se calcula sola con una fórmula; la app no la usa.
 * Queda como primera pestaña para poder leerla sola desde Drive.
 * Se ejecuta a mano desde el editor. Si la pestaña ya existe, solo vuelve a
 * escribir sus fórmulas (A1, H1, M1 y M2); no toca ninguna otra pestaña.
 */
function crearResumenDashboard() {
  const planilla = SpreadsheetApp.getActiveSpreadsheet();
  const admin = leerTabla_('Usuarios').filter(function (u) {
    return normalizar_(u.rol) === 'admin' && esSi_(u.activo);
  })[0];
  if (!admin) {
    throw new Error('No encontré al administrador en la pestaña Usuarios.');
  }

  // Letras de las columnas de Movimientos, según sus encabezados.
  const movimientos = hoja_('Movimientos');
  const columnas = encabezados_(movimientos, 'Movimientos');
  const letra = function (nombre) { return letraColumna_(columnas.indexOf(nombre) + 1); };
  const fecha = letra('fecha');
  const monto = letra('monto');
  const usuario = letra('usuario_id');
  const tipo = letra('tipo');
  const categoria = letra('categoria_id');
  const estado = letra('estado');
  const ultima = letraColumna_(columnas.length);
  const grupo = 'year(' + fecha + '), month(' + fecha + ')+1, ' + tipo + ', ' + categoria;
  // Primer día del mes de hace 12 meses (13 meses contando el actual).
  const desde = '"&YEAR(EDATE(TODAY(),-12))&"-"&TEXT(MONTH(EDATE(TODAY(),-12)),"00")&"-01';
  const consulta = 'select ' + grupo + ', sum(' + monto + '), count(' + monto + ')' +
    ' where ' + estado + " = 'Confirmado' and " + fecha + " >= date '" + desde + "'" +
    ' and (' + tipo + " = 'Familiar' or (" + tipo + " = 'Personal' and " + usuario + " = '" + admin.id + "'))" +
    ' group by ' + grupo +
    ' label year(' + fecha + ") 'anio', month(" + fecha + ")+1 'mes', " + tipo + " 'tipo', " +
    categoria + " 'categoria_id', sum(" + monto + ") 'total', count(" + monto + ") 'cantidad'";

  const existia = Boolean(planilla.getSheetByName('Resumen'));
  const hoja = planilla.getSheetByName('Resumen') || planilla.insertSheet('Resumen', 0);
  const separador = escribirFormula_(hoja, 'A1', '=QUERY(Movimientos!A2:' + ultima + ', "' + consulta + '", 0)');
  escribirFormula_(hoja, 'H1', '=QUERY(Categorias!A1:D, "select A, B, C, D where A is not null", 1)');
  hoja.getRange('M1').setValue('total_control');
  escribirFormula_(hoja, 'M2', '=SUM(E2:E)');
  hoja.setFrozenRows(1);
  Logger.log((existia ? 'Fórmulas de Resumen reescritas' : 'Pestaña Resumen creada') +
    ' (separador: ' + separador + ').');

  // Aviso si hay fechas guardadas como texto: la fórmula no las cuenta.
  const fechas = movimientos.getRange(2, columnas.indexOf('fecha') + 1, Math.max(1, movimientos.getLastRow() - 1), 1).getValues();
  const comoTexto = fechas.filter(function (f) {
    return f[0] !== '' && Object.prototype.toString.call(f[0]) !== '[object Date]';
  }).length;
  Logger.log(comoTexto
    ? 'Ojo: ' + comoTexto + ' fechas están como texto y no se cuentan en el resumen.'
    : 'Todas las fechas se leen bien.');
}

/**
 * Escribe una fórmula con comas. Si Sheets no la entiende (#ERROR!, típico de
 * planillas en español), la reescribe con punto y coma. Devuelve el separador usado.
 */
function escribirFormula_(hoja, celda, formula) {
  const rango = hoja.getRange(celda);
  rango.setFormula(formula);
  SpreadsheetApp.flush();
  if (rango.getDisplayValue() !== '#ERROR!') {
    return 'coma';
  }
  rango.setFormula(conPuntoYComa_(formula));
  SpreadsheetApp.flush();
  if (rango.getDisplayValue() === '#ERROR!') {
    throw new Error('La fórmula de ' + celda + ' sigue con error. Haz clic en la celda para ver el detalle.');
  }
  return 'punto y coma';
}

/** Cambia las comas por punto y coma, salvo las que están dentro de "texto". */
function conPuntoYComa_(formula) {
  let dentroDeTexto = false;
  let resultado = '';
  for (let i = 0; i < formula.length; i++) {
    const c = formula[i];
    if (c === '"') {
      dentroDeTexto = !dentroDeTexto;
    }
    resultado += (!dentroDeTexto && c === ',') ? ';' : c;
  }
  return resultado;
}

/** 1 → A, 14 → N, 27 → AA. */
function letraColumna_(numero) {
  let letras = '';
  while (numero > 0) {
    const resto = (numero - 1) % 26;
    letras = String.fromCharCode(65 + resto) + letras;
    numero = Math.floor((numero - 1) / 26);
  }
  return letras;
}
