/**
 * Funciones de apoyo: fechas, montos, textos y huellas para duplicados.
 */

/**
 * Convierte una fecha en cualquiera de los formatos aceptados a un Date a
 * medianoche (hora de Chile). Devuelve null si no es una fecha válida.
 * Acepta: fecha nativa de Sheets, DD/MM/YYYY (también con - o .),
 * ISO YYYY-MM-DD y número de serie de Excel.
 */
function leerFecha_(valor) {
  if (Object.prototype.toString.call(valor) === '[object Date]') {
    return isNaN(valor.getTime()) ? null : fechaValida_(valor.getFullYear(), valor.getMonth() + 1, valor.getDate());
  }
  if (typeof valor === 'number') {
    return fechaDesdeSerial_(valor);
  }
  const texto = String(valor || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(texto);
  if (m) {
    return fechaValida_(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(texto);
  if (m) {
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return fechaValida_(anio, Number(m[2]), Number(m[1]));
  }
  if (/^\d+(\.\d+)?$/.test(texto)) {
    return fechaDesdeSerial_(Number(texto));
  }
  return null;
}

/** Excel cuenta los días desde el 30/12/1899. Se aceptan años 1990 a 2100. */
function fechaDesdeSerial_(serial) {
  if (serial < 32874 || serial > 73051) {
    return null;
  }
  const utc = new Date(Math.round((serial - 25569) * 86400000));
  return fechaValida_(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/** Crea la fecha y confirma que exista (por ejemplo, rechaza 31/02). */
function fechaValida_(anio, mes, dia) {
  if (anio < 1990 || anio > 2100) {
    return null;
  }
  const fecha = new Date(anio, mes - 1, dia);
  if (fecha.getFullYear() !== anio || fecha.getMonth() !== mes - 1 || fecha.getDate() !== dia) {
    return null;
  }
  return fecha;
}

function fechaIso_(fecha) {
  return Utilities.formatDate(fecha, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Lee un monto en pesos. Acepta números o textos como "12.345", "$ 12.345"
 * o "12.345,50" (el punto separa miles). Devuelve un entero o null.
 */
function leerMonto_(valor) {
  let numero = valor;
  if (typeof valor !== 'number') {
    const texto = String(valor || '').replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
    numero = /^-?\d+(\.\d+)?$/.test(texto) ? Number(texto) : NaN;
  }
  if (!isFinite(numero) || numero === 0 || Math.abs(numero) >= 1e10) {
    return null;
  }
  return Math.round(numero);
}

/**
 * Limpia un texto que escribió un usuario antes de guardarlo en la planilla.
 * Si empieza con = + - @ se le antepone un apóstrofo para que Sheets no lo
 * interprete como fórmula.
 */
function textoSeguro_(valor, largoMaximo) {
  const texto = String(valor === undefined || valor === null ? '' : valor)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, largoMaximo);
  return /^[=+\-@]/.test(texto) ? "'" + texto : texto;
}

/**
 * Texto en minúsculas, sin tildes y sin signos. Es la misma regla que usa
 * herramientas/convertir-historial.js; si se cambia, hay que cambiar ambas.
 */
function normalizar_(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Huella para detectar duplicados: fecha|monto|glosa normalizada. */
function huella_(fecha, monto, glosa) {
  return fechaIso_(fecha) + '|' + monto + '|' + normalizar_(glosa);
}

function esSi_(valor) {
  return valor === true || normalizar_(valor) === 'si';
}

/** Error cuyo mensaje sí se puede mostrar al usuario. */
function errorPublico_(mensaje) {
  const error = new Error(mensaje);
  error.publico = true;
  return error;
}
