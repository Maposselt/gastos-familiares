/**
 * Convierte el historial del Excel antiguo en archivos CSV listos para
 * importar a la planilla (pestañas Movimientos, Repartos, Ingresos y
 * Diccionario).
 *
 * Uso:   node herramientas/convertir-historial.js "<ruta al Excel>"
 *
 * - El Excel solo se LEE: el archivo nunca se abre en modo escritura.
 * - Solo usa herramientas que vienen con Node (fs, path, zlib).
 * - Este código no contiene datos: nombres, categorías y reglas se leen desde
 *   archivos de la carpeta datos/, que Git ignora.
 *     datos/usuarios-historial.csv  nombre en el Excel → id de usuario
 *     datos/mapeo-quien.csv         qué hacer según la columna "Quien"
 *     datos/mapeo-historial.csv     categoría antigua → categoría nueva
 *     datos/categorias.csv          categorías vigentes (para validar)
 * - Los CSV generados quedan en datos/ y se sobrescriben en cada ejecución.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CARPETA_DATOS = path.join(__dirname, '..', 'datos');

const HOJA_FAMILIAR = 'Cuentas Familiares';
const HOJA_PERSONAL = 'Resumen Personal';

// Columnas del Excel antiguo (letras de columna).
const COL_FAMILIAR = {
  anio: 'A', mes: 'B', pagadoPor: 'C', cuenta: 'D', monto: 'E',
  criterio: 'G', porcentaje1: 'H', porcentaje2: 'I'
};
const COL_INGRESOS = { anio: 'O', mes: 'P', quien: 'Q', valor: 'R' };
const COL_PERSONAL = {
  fecha: 'C', descripcion: 'D', valor: 'E', categoria: 'I', detalle: 'J',
  quien: 'K'
};

// Mismo orden de columnas que ESTRUCTURA en apps-script/Configuracion.js.
const COLUMNAS = {
  Movimientos: [
    'id', 'fecha', 'monto', 'descripcion', 'usuario_id', 'tipo', 'categoria_id',
    'rendir_trabajo', 'estado', 'origen', 'huella', 'duplicado_revisado',
    'creado_en', 'modificado_en'
  ],
  Repartos: ['movimiento_id', 'usuario_id', 'porcentaje', 'monto'],
  Ingresos: ['id', 'usuario_id', 'anio', 'mes', 'monto', 'creado_en'],
  Diccionario: [
    'glosa_normalizada', 'tipo', 'categoria_id', 'veces', 'porcentaje',
    'total_registros', 'actualizado_en'
  ]
};

const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'
];

const VACIO = '(vacío)';

// ---------------------------------------------------------------------------
// Lectura del Excel (.xlsx = archivo zip con XML adentro)
// ---------------------------------------------------------------------------

/** Devuelve una función que entrega el texto de un archivo dentro del zip. */
function abrirZip_(buffer) {
  let fin = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) {
    throw new Error('El archivo no parece un Excel (.xlsx) válido.');
  }
  const cantidad = buffer.readUInt16LE(fin + 10);
  let p = buffer.readUInt32LE(fin + 16);
  const entradas = {};
  for (let n = 0; n < cantidad; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('El índice interno del Excel está dañado.');
    }
    const largoNombre = buffer.readUInt16LE(p + 28);
    const nombre = buffer.toString('utf8', p + 46, p + 46 + largoNombre);
    entradas[nombre] = {
      metodo: buffer.readUInt16LE(p + 10),
      tamano: buffer.readUInt32LE(p + 20),
      inicio: buffer.readUInt32LE(p + 42)
    };
    p += 46 + largoNombre + buffer.readUInt16LE(p + 30) + buffer.readUInt16LE(p + 32);
  }

  return function leer(nombre) {
    const e = entradas[nombre];
    if (!e) {
      return null;
    }
    const datosDesde = e.inicio + 30 + buffer.readUInt16LE(e.inicio + 26) +
      buffer.readUInt16LE(e.inicio + 28);
    const datos = buffer.subarray(datosDesde, datosDesde + e.tamano);
    if (e.metodo === 0) {
      return datos.toString('utf8');
    }
    if (e.metodo === 8) {
      return zlib.inflateRawSync(datos).toString('utf8');
    }
    throw new Error('Formato de compresión no soportado en ' + nombre);
  };
}

function decodificarXml_(texto) {
  return texto.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, function (m, e) {
    if (e[0] === '#') {
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
  });
}

function atributos_(texto) {
  const resultado = {};
  const re = /([\w:]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(texto))) {
    resultado[m[1]] = decodificarXml_(m[2]);
  }
  return resultado;
}

/** Textos compartidos: Excel guarda cada texto una vez y las celdas lo referencian. */
function leerTextos_(xml) {
  const textos = [];
  if (!xml) {
    return textos;
  }
  const reSi = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = reSi.exec(xml))) {
    const sinFonetica = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let texto = '';
    const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = reT.exec(sinFonetica))) {
      texto += decodificarXml_(t[1]);
    }
    textos.push(texto);
  }
  return textos;
}

/** Busca el archivo XML de una hoja a partir de su nombre visible. */
function rutaDeHoja_(leer, nombreHoja) {
  const libro = leer('xl/workbook.xml');
  const relaciones = leer('xl/_rels/workbook.xml.rels');
  const reHoja = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = reHoja.exec(libro))) {
    const a = atributos_(m[1]);
    if (a.name !== nombreHoja) {
      continue;
    }
    const reRel = /<Relationship\b([^>]*)\/?>/g;
    let r;
    while ((r = reRel.exec(relaciones))) {
      const ra = atributos_(r[1]);
      if (ra.Id === a['r:id']) {
        const destino = ra.Target.replace(/^\//, '');
        return destino.startsWith('xl/') ? destino : 'xl/' + destino;
      }
    }
  }
  throw new Error('No encontré la hoja "' + nombreHoja + '" en el Excel.');
}

/** Devuelve las filas de una hoja como [{ fila: n, A: valor, B: valor, ... }]. */
function leerHoja_(leer, nombreHoja, textos) {
  const xml = leer(rutaDeHoja_(leer, nombreHoja));
  const filas = [];
  const reFila = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let m;
  while ((m = reFila.exec(xml))) {
    const fila = { fila: Number(atributos_(m[1]).r) };
    const reCelda = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = reCelda.exec(m[2]))) {
      const a = atributos_(c[1]);
      const contenido = c[2] || '';
      const columna = a.r.replace(/\d+/g, '');
      const v = /<v>([\s\S]*?)<\/v>/.exec(contenido);
      let valor = null;
      if (a.t === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(contenido);
        valor = t ? decodificarXml_(t[1]) : '';
      } else if (v) {
        if (a.t === 's') {
          valor = textos[Number(v[1])];
        } else if (a.t === 'str' || a.t === 'e') {
          valor = decodificarXml_(v[1]);
        } else if (a.t === 'b') {
          valor = v[1] === '1';
        } else {
          valor = Number(v[1]);
        }
      }
      if (valor !== null && valor !== '') {
        fila[columna] = valor;
      }
    }
    filas.push(fila);
  }
  return filas;
}

// ---------------------------------------------------------------------------
// Archivos CSV
// ---------------------------------------------------------------------------

/**
 * Lee un CSV de la carpeta datos/. Acepta "," o ";" como separador y
 * codificación UTF-8 o la de Excel en Windows, para que se pueda editar en Excel.
 */
function leerCsv_(nombreArchivo) {
  const ruta = path.join(CARPETA_DATOS, nombreArchivo);
  if (!fs.existsSync(ruta)) {
    throw new Error('Falta el archivo datos/' + nombreArchivo);
  }
  const bytes = fs.readFileSync(ruta);
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    texto = bytes.toString('latin1');
  }
  texto = texto.replace(/^﻿/, '');
  const primeraLinea = texto.split(/\r?\n/)[0];
  const separador = (primeraLinea.split(';').length > primeraLinea.split(',').length) ? ';' : ',';

  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (entreComillas) {
      if (ch === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (ch === '"') {
        entreComillas = false;
      } else {
        campo += ch;
      }
    } else if (ch === '"') {
      entreComillas = true;
    } else if (ch === separador) {
      fila.push(campo);
      campo = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') {
        i++;
      }
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += ch;
    }
  }
  if (campo !== '' || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }

  const encabezados = filas.shift().map(function (h) { return h.trim().toLowerCase(); });
  return filas
    .filter(function (f) { return f.some(function (v) { return v.trim() !== ''; }); })
    .map(function (f) {
      const objeto = {};
      encabezados.forEach(function (h, i) { objeto[h] = (f[i] || '').trim(); });
      return objeto;
    });
}

function escribirCsv_(nombreArchivo, columnas, filas) {
  const lineas = [columnas.join(',')];
  filas.forEach(function (f) {
    lineas.push(columnas.map(function (c) {
      const v = f[c] === undefined || f[c] === null ? '' : String(f[c]);
      return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(','));
  });
  fs.writeFileSync(path.join(CARPETA_DATOS, nombreArchivo), lineas.join('\r\n') + '\r\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/**
 * Texto en minúsculas, sin tildes y sin signos. El backend debe usar esta
 * misma regla al calcular la huella de los gastos nuevos.
 */
function normalizar_(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Para el diccionario además se quitan los números (sucursales, folios). */
function normalizarGlosa_(texto) {
  return normalizar_(texto).replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

function dosDigitos_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Excel guarda las fechas como número de días desde 1899-12-30. */
function fechaDesdeSerial_(serial) {
  return new Date(Math.round((serial - 25569) * 86400000));
}

function fechaTexto_(fecha) {
  return dosDigitos_(fecha.getUTCDate()) + '/' + dosDigitos_(fecha.getUTCMonth() + 1) + '/' + fecha.getUTCFullYear();
}

function fechaIso_(fecha) {
  return fecha.getUTCFullYear() + '-' + dosDigitos_(fecha.getUTCMonth() + 1) + '-' + dosDigitos_(fecha.getUTCDate());
}

function ahoraTexto_() {
  const d = new Date();
  return dosDigitos_(d.getDate()) + '/' + dosDigitos_(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' ' + dosDigitos_(d.getHours()) + ':' + dosDigitos_(d.getMinutes());
}

/** Decimal con coma, para que Sheets en español lo lea como número. */
function decimalTexto_(numero) {
  return numero.toFixed(6).replace('.', ',');
}

function numeroMes_(nombre) {
  const i = MESES.indexOf(normalizar_(nombre));
  return i < 0 ? null : i + 1;
}

function pesos_(n) {
  return Math.round(n).toLocaleString('es-CL');
}

function esSi_(texto) {
  return normalizar_(texto) === 'si';
}

function contar_(mapa, clave, cantidad) {
  mapa.set(clave, (mapa.get(clave) || 0) + (cantidad === undefined ? 1 : cantidad));
}

// ---------------------------------------------------------------------------
// Configuración desde datos/
// ---------------------------------------------------------------------------

function cargarConfiguracion_() {
  const categorias = new Map();
  leerCsv_('categorias.csv').forEach(function (c) { categorias.set(c.id, c); });

  const usuarios = new Map();
  let duenoPersonal = null;
  leerCsv_('usuarios-historial.csv').forEach(function (u) {
    usuarios.set(normalizar_(u.nombre_en_excel), u.usuario_id);
    if (esSi_(u.dueno_resumen_personal)) {
      duenoPersonal = u.usuario_id;
    }
  });
  if (!duenoPersonal) {
    throw new Error('En datos/usuarios-historial.csv nadie está marcado como dueño del resumen personal.');
  }

  const quien = new Map();
  leerCsv_('mapeo-quien.csv').forEach(function (q) {
    quien.set(q.quien === VACIO ? VACIO : normalizar_(q.quien), {
      tratamiento: normalizar_(q.tratamiento),
      tipo: q.tipo,
      rendir: esSi_(q.rendir_trabajo)
    });
  });

  // Reglas agrupadas por tipo + categoría antigua. Las que tienen
  // "detalle_contiene" se revisan primero; la que lo deja vacío es la general.
  const reglas = new Map();
  const errores = [];
  leerCsv_('mapeo-historial.csv').forEach(function (r, i) {
    const linea = 'datos/mapeo-historial.csv, fila ' + (i + 2);
    if (r.categoria_id) {
      const cat = categorias.get(r.categoria_id);
      if (!cat) {
        errores.push(linea + ': la categoría ' + r.categoria_id + ' no existe.');
      } else if (cat.tipo !== r.tipo) {
        errores.push(linea + ': ' + r.categoria_id + ' es ' + cat.tipo + ', pero la regla es ' + r.tipo + '.');
      }
    }
    const clave = r.tipo + '|' + normalizar_(r.categoria_antigua);
    if (!reglas.has(clave)) {
      reglas.set(clave, { especificas: [], general: undefined });
    }
    const grupo = reglas.get(clave);
    const regla = { categoriaId: r.categoria_id, rendir: esSi_(r.rendir_trabajo) };
    if (r.detalle_contiene) {
      regla.palabras = r.detalle_contiene.split('|').map(normalizar_).filter(Boolean);
      grupo.especificas.push(regla);
    } else {
      grupo.general = regla;
    }
  });
  if (errores.length) {
    throw new Error('Hay errores en el mapeo:\n  ' + errores.join('\n  '));
  }

  return { categorias, usuarios, duenoPersonal, quien, reglas };
}

/**
 * Busca la categoría nueva. Devuelve undefined si no hay ninguna regla, o una
 * regla cuyo categoriaId puede venir vacío (= queda "Por revisar").
 */
function buscarRegla_(config, tipo, categoriaAntigua, detalle) {
  const grupo = config.reglas.get(tipo + '|' + normalizar_(categoriaAntigua));
  if (!grupo) {
    return undefined;
  }
  const detalleNormal = normalizar_(detalle);
  const especifica = grupo.especificas.find(function (r) {
    return r.palabras.some(function (p) { return detalleNormal.includes(p); });
  });
  return especifica || grupo.general;
}

function usuarioDe_(config, nombre, donde) {
  const id = config.usuarios.get(normalizar_(nombre));
  if (!id) {
    throw new Error('"' + nombre + '" (' + donde + ') no está en datos/usuarios-historial.csv');
  }
  return id;
}

// ---------------------------------------------------------------------------
// Conversión
// ---------------------------------------------------------------------------

function principal_() {
  const rutaExcel = process.argv[2];
  if (!rutaExcel) {
    throw new Error('Indica la ruta del Excel: node herramientas/convertir-historial.js "<ruta>"');
  }
  const config = cargarConfiguracion_();

  // readFileSync abre el archivo solo para lectura.
  const leer = abrirZip_(fs.readFileSync(rutaExcel));
  const textos = leerTextos_(leer('xl/sharedStrings.xml'));
  const filasFamiliar = leerHoja_(leer, HOJA_FAMILIAR, textos);
  const filasPersonal = leerHoja_(leer, HOJA_PERSONAL, textos);

  const creadoEn = ahoraTexto_();
  const movimientos = [];
  const repartos = [];
  const ingresos = [];
  const avisos = new Map();
  const resumenMes = new Map();
  let correlativo = 0;

  function agregarMovimiento(fecha, monto, descripcion, glosa, usuarioId, tipo, categoriaId, rendir, estado) {
    correlativo++;
    const mov = {
      id: 'h-' + String(correlativo).padStart(5, '0'),
      fecha: fechaTexto_(fecha),
      monto: monto,
      descripcion: descripcion,
      usuario_id: usuarioId,
      tipo: tipo,
      categoria_id: categoriaId,
      rendir_trabajo: rendir ? 'Sí' : 'No',
      estado: estado,
      origen: 'historial',
      huella: fechaIso_(fecha) + '|' + monto + '|' + normalizar_(glosa),
      duplicado_revisado: '',
      creado_en: creadoEn,
      modificado_en: ''
    };
    movimientos.push(mov);

    const mes = fechaIso_(fecha).slice(0, 7);
    if (!resumenMes.has(mes)) {
      resumenMes.set(mes, { familiar: 0, personal: 0, revisar: 0 });
    }
    const r = resumenMes.get(mes);
    if (estado === 'Por revisar') {
      r.revisar++;
    } else if (tipo === 'Familiar') {
      r.familiar += monto;
    } else {
      r.personal += monto;
    }
    return mov;
  }

  // 1. Ingresos mensuales (tabla a la derecha de la hoja familiar).
  const encabezado = filasFamiliar.find(function (f) { return f.fila === 1; }) || {};
  const ingresoPorMes = new Map();
  filasFamiliar.forEach(function (f) {
    if (f.fila === 1 || typeof f[COL_INGRESOS.valor] !== 'number') {
      return;
    }
    const usuarioId = usuarioDe_(config, f[COL_INGRESOS.quien], 'ingresos, fila ' + f.fila);
    const anio = Number(f[COL_INGRESOS.anio]);
    const mes = numeroMes_(f[COL_INGRESOS.mes]);
    if (!mes) {
      contar_(avisos, 'Ingreso con mes desconocido en fila ' + f.fila);
      return;
    }
    const monto = Math.round(f[COL_INGRESOS.valor]);
    ingresos.push({
      id: 'i-' + String(ingresos.length + 1).padStart(4, '0'),
      usuario_id: usuarioId, anio: anio, mes: mes, monto: monto, creado_en: creadoEn
    });
    contar_(ingresoPorMes, anio + '-' + mes + '|' + usuarioId, monto);
    contar_(ingresoPorMes, anio + '-' + mes + '|total', monto);
  });

  // 2. Gastos familiares: una fila por cuenta y mes, con su reparto original.
  //    Los encabezados de las columnas de porcentaje son los nombres de cada uno.
  const usuarioPct1 = usuarioDe_(config, encabezado[COL_FAMILIAR.porcentaje1], 'encabezado ' + COL_FAMILIAR.porcentaje1);
  const usuarioPct2 = usuarioDe_(config, encabezado[COL_FAMILIAR.porcentaje2], 'encabezado ' + COL_FAMILIAR.porcentaje2);
  filasFamiliar.forEach(function (f) {
    if (f.fila === 1 || !f[COL_FAMILIAR.cuenta] || typeof f[COL_FAMILIAR.monto] !== 'number') {
      return;
    }
    const anio = Number(f[COL_FAMILIAR.anio]);
    const mes = numeroMes_(f[COL_FAMILIAR.mes]);
    if (!mes) {
      contar_(avisos, 'Gasto familiar con mes desconocido en fila ' + f.fila);
      return;
    }
    const cuenta = f[COL_FAMILIAR.cuenta];
    const regla = buscarRegla_(config, 'Familiar', cuenta, '');
    const categoriaId = regla ? regla.categoriaId : '';
    if (!categoriaId) {
      contar_(avisos, 'Cuenta familiar sin categoría nueva: ' + cuenta);
    }
    const monto = Math.round(f[COL_FAMILIAR.monto]);
    const mov = agregarMovimiento(
      new Date(Date.UTC(anio, mes, 0)), monto,
      'Histórico: ' + cuenta + ' ' + f[COL_FAMILIAR.mes] + ' ' + anio, cuenta,
      usuarioDe_(config, f[COL_FAMILIAR.pagadoPor], 'familiar, fila ' + f.fila),
      'Familiar', categoriaId, false, categoriaId ? 'Confirmado' : 'Por revisar');

    // Las primeras filas del Excel no tienen el % calculado: se reconstruye
    // con la misma regla (mitad y mitad, o según los ingresos del mes).
    let pct1 = f[COL_FAMILIAR.porcentaje1];
    if (typeof pct1 !== 'number') {
      if (normalizar_(f[COL_FAMILIAR.criterio]) === 'proporcional') {
        const total = ingresoPorMes.get(anio + '-' + mes + '|total');
        if (!total) {
          contar_(avisos, 'Sin ingresos para calcular el reparto de ' + f[COL_FAMILIAR.mes] + ' ' + anio);
          return;
        }
        pct1 = (ingresoPorMes.get(anio + '-' + mes + '|' + usuarioPct1) || 0) / total;
      } else {
        pct1 = 0.5;
      }
      contar_(avisos, 'Reparto reconstruido (el Excel no tenía el %)');
    }
    const parte1 = Math.round(monto * pct1);
    repartos.push({ movimiento_id: mov.id, usuario_id: usuarioPct1, porcentaje: decimalTexto_(pct1), monto: parte1 });
    repartos.push({ movimiento_id: mov.id, usuario_id: usuarioPct2, porcentaje: decimalTexto_(1 - pct1), monto: monto - parte1 });
  });

  // 3. Movimientos personales: la columna "Quien" decide qué se hace con cada uno.
  const diccionario = new Map();
  function sumarAlDiccionario(glosa, categoriaId) {
    const clave = normalizarGlosa_(glosa);
    if (!clave || !categoriaId) {
      return;
    }
    contar_(diccionario, clave + '|' + config.categorias.get(categoriaId).tipo + '|' + categoriaId);
  }

  const tratamientos = new Map();
  filasPersonal.forEach(function (f) {
    if (f.fila === 1) {
      return;
    }
    if (typeof f[COL_PERSONAL.fecha] !== 'number' || typeof f[COL_PERSONAL.valor] !== 'number' || f[COL_PERSONAL.valor] === 0) {
      contar_(avisos, 'Fila personal sin fecha o sin monto (se omite)');
      return;
    }
    const quienTexto = f[COL_PERSONAL.quien] || '';
    const quien = config.quien.get(quienTexto ? normalizar_(quienTexto) : VACIO);
    if (!quien) {
      contar_(avisos, 'Valor de "Quien" sin regla en mapeo-quien.csv: ' + quienTexto);
    }
    const tratamiento = quien ? quien.tratamiento : 'por revisar';
    const categoriaAntigua = f[COL_PERSONAL.categoria] || '';
    const detalle = f[COL_PERSONAL.detalle] || '';
    const glosa = f[COL_PERSONAL.descripcion] || '';

    // Si "Quien" no dice el tipo, se prueba primero como personal y luego familiar.
    const tipos = quien && quien.tipo ? [quien.tipo] : ['Personal', 'Familiar'];
    let regla;
    let tipo = quien ? quien.tipo : '';
    for (let i = 0; i < tipos.length && !(regla && regla.categoriaId); i++) {
      regla = buscarRegla_(config, tipos[i], categoriaAntigua, detalle);
    }
    const categoriaId = regla ? regla.categoriaId : '';
    if (categoriaId && !tipo) {
      tipo = config.categorias.get(categoriaId).tipo;
    }

    if (tratamiento === 'solo diccionario') {
      sumarAlDiccionario(glosa, categoriaId);
      contar_(tratamientos, 'Solo diccionario');
      return;
    }

    if (tratamiento === 'movimiento' && !regla) {
      contar_(avisos, 'Categoría personal sin regla (queda Por revisar): ' + categoriaAntigua);
    }
    const confirmado = tratamiento === 'movimiento' && !!categoriaId;
    const rendir = (quien && quien.rendir) || (regla && regla.rendir);
    const detalleUtil = detalle && !/^(s\/i|¿\?|\?)$/i.test(detalle) ? ' — ' + detalle : '';
    agregarMovimiento(
      fechaDesdeSerial_(f[COL_PERSONAL.fecha]), Math.round(f[COL_PERSONAL.valor]),
      glosa + detalleUtil, glosa, config.duenoPersonal,
      tipo, confirmado ? categoriaId : '', rendir, confirmado ? 'Confirmado' : 'Por revisar');
    if (confirmado) {
      sumarAlDiccionario(glosa, categoriaId);
    }
    contar_(tratamientos, confirmado ? (rendir ? 'Personal + rendir al trabajo' : 'Personal') : 'Por revisar');
  });

  // 4. Duplicados exactos (misma fecha, monto y glosa). En el historial ya
  //    fueron revisados por ti, así que se marcan como revisados.
  const porHuella = new Map();
  movimientos.forEach(function (m) { contar_(porHuella, m.huella); });
  let duplicados = 0;
  movimientos.forEach(function (m) {
    if (porHuella.get(m.huella) > 1) {
      m.duplicado_revisado = 'Sí';
      duplicados++;
    }
  });

  // 5. Diccionario: % de veces que cada glosa tuvo cada categoría.
  const totalesGlosa = new Map();
  diccionario.forEach(function (veces, clave) { contar_(totalesGlosa, clave.split('|')[0], veces); });
  const filasDiccionario = [];
  diccionario.forEach(function (veces, clave) {
    const partes = clave.split('|');
    const total = totalesGlosa.get(partes[0]);
    filasDiccionario.push({
      glosa_normalizada: partes[0], tipo: partes[1], categoria_id: partes[2],
      veces: veces, porcentaje: decimalTexto_(veces / total), total_registros: total,
      actualizado_en: creadoEn
    });
  });
  filasDiccionario.sort(function (a, b) {
    return a.glosa_normalizada.localeCompare(b.glosa_normalizada) || b.veces - a.veces;
  });

  escribirCsv_('movimientos.csv', COLUMNAS.Movimientos, movimientos);
  escribirCsv_('repartos.csv', COLUMNAS.Repartos, repartos);
  escribirCsv_('ingresos.csv', COLUMNAS.Ingresos, ingresos);
  escribirCsv_('diccionario.csv', COLUMNAS.Diccionario, filasDiccionario);

  // Resumen para comparar con el Excel.
  console.log('\nTOTALES POR MES (montos confirmados)');
  console.log('Mes       Familiar        Personal     Por revisar');
  Array.from(resumenMes.keys()).sort().forEach(function (mes) {
    const r = resumenMes.get(mes);
    console.log(mes + '  ' + pesos_(r.familiar).padStart(12) + '  ' + pesos_(r.personal).padStart(12) +
      '  ' + String(r.revisar).padStart(8));
  });

  console.log('\nRESUMEN');
  console.log('  Movimientos:        ' + movimientos.length);
  console.log('    Familiares:       ' + movimientos.filter(function (m) { return m.tipo === 'Familiar'; }).length);
  tratamientos.forEach(function (n, t) { console.log('    ' + (t + ':').padEnd(18) + n); });
  console.log('  Repartos:           ' + repartos.length);
  console.log('  Ingresos:           ' + ingresos.length);
  console.log('  Diccionario:        ' + filasDiccionario.length + ' combinaciones glosa/categoría');
  console.log('  Duplicados exactos: ' + duplicados + ' (marcados como revisados)');

  if (avisos.size) {
    console.log('\nAVISOS');
    avisos.forEach(function (n, aviso) { console.log('  ' + aviso + ' (' + n + ')'); });
  }
  console.log('\nArchivos generados en la carpeta datos/: movimientos.csv, repartos.csv, ingresos.csv, diccionario.csv');
}

try {
  principal_();
} catch (e) {
  console.error('\nERROR: ' + e.message);
  process.exitCode = 1;
}
