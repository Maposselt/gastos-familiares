/**
 * Quién está pidiendo y qué puede ver.
 *
 * Se entra con usuario (el nombre visible de la pestaña Usuarios, por ejemplo
 * "Max") y clave. Datos que se guardan en Script Properties (nunca en el código):
 *   CLAVE_INICIAL_<id>  Clave puesta a mano por el administrador, por ejemplo
 *                       CLAVE_INICIAL_u2. Al entrar con ella se cifra y se borra.
 *                       Sirve también para reponer una clave olvidada.
 *   CLAVE_<id>          Clave cifrada ("sal$huella"). Nunca se guarda la clave real.
 *   SESION_<huella>     Sesión abierta en un dispositivo: {"u":"u1","vence":...}.
 *                       Se guarda la huella del comprobante, no el comprobante.
 */

const PEDIDOS_POR_MINUTO = 60;
const INTENTOS_FALLIDOS_POR_MINUTO = 30;
const LARGO_MINIMO_CLAVE = 6;
const LARGO_MAXIMO_CLAVE = 100;
const INTENTOS_POR_USUARIO = 5;
const SEGUNDOS_BLOQUEO = 180;
const DIAS_SESION = 30;
const VUELTAS_CIFRADO = 1000;
const MS_POR_DIA = 86400000;

/**
 * Revisa usuario y clave. Si calzan, abre una sesión de 30 días y devuelve su
 * comprobante. Tras 5 claves incorrectas, ese usuario queda bloqueado 3 minutos.
 */
function entrar_(datos) {
  const nombre = normalizar_(textoSeguro_(datos.usuario, 40));
  const clave = typeof datos.clave === 'string' ? datos.clave : '';
  if (!nombre || !clave || clave.length > LARGO_MAXIMO_CLAVE) {
    throw errorPublico_('Usuario o clave incorrectos.');
  }
  revisarBloqueo_(nombre);
  const usuario = leerTabla_('Usuarios').filter(function (u) {
    return esSi_(u.activo) && normalizar_(u.nombre_visible) === nombre;
  })[0];
  if (!usuario || !claveCorrecta_(String(usuario.id), clave)) {
    registrarFalloClave_(nombre);
    throw errorPublico_('Usuario o clave incorrectos.');
  }
  CacheService.getScriptCache().remove(claveBloqueo_(nombre));
  return { token: abrirSesion_(String(usuario.id)) };
}

/**
 * Verifica el comprobante de sesión que envía la app y devuelve el usuario de
 * la pestaña Usuarios. Si la sesión venció o no existe, lanza un error.
 */
function autenticar_(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw errorPublico_('Debes iniciar sesión.');
  }
  const propiedades = PropertiesService.getScriptProperties();
  const claveSesion = 'SESION_' + huellaTexto_(token);
  const texto = propiedades.getProperty(claveSesion);
  let sesion = null;
  try {
    sesion = texto ? JSON.parse(texto) : null;
  } catch (e) {
    sesion = null;
  }
  const ahora = Date.now();
  if (!sesion || !(Number(sesion.vence) > ahora)) {
    if (texto) {
      propiedades.deleteProperty(claveSesion);
    }
    throw errorPublico_('Tu sesión expiró. Vuelve a entrar.');
  }

  const usuario = leerTabla_('Usuarios').filter(function (u) { return u.id === sesion.u; })[0];
  if (!usuario || !esSi_(usuario.activo)) {
    propiedades.deleteProperty(claveSesion);
    throw errorPublico_('Tu sesión ya no es válida. Vuelve a entrar.');
  }
  // Mientras se use, la sesión se renueva: vence 30 días después del último uso (como máximo, cada 15 días se reescribe).
  if (Number(sesion.vence) - ahora < DIAS_SESION * MS_POR_DIA / 2) {
    sesion.vence = ahora + DIAS_SESION * MS_POR_DIA;
    propiedades.setProperty(claveSesion, JSON.stringify(sesion));
  }
  return {
    id: String(usuario.id),
    nombre: String(usuario.nombre_visible),
    esAdmin: normalizar_(usuario.rol) === 'admin',
    sesion: claveSesion
  };
}

/** Cierra la sesión de este dispositivo. */
function salir_(usuario) {
  PropertiesService.getScriptProperties().deleteProperty(usuario.sesion);
  return { cerrada: true };
}

/**
 * Cambia la clave propia. Pide la clave actual, y cierra las sesiones de los
 * demás dispositivos (este sigue abierto).
 */
function cambiarClave_(usuario, datos) {
  const actual = typeof datos.actual === 'string' ? datos.actual : '';
  const nueva = typeof datos.nueva === 'string' ? datos.nueva : '';
  if (nueva.length < LARGO_MINIMO_CLAVE || nueva.length > LARGO_MAXIMO_CLAVE) {
    throw errorPublico_('La clave nueva debe tener entre ' + LARGO_MINIMO_CLAVE + ' y ' + LARGO_MAXIMO_CLAVE + ' caracteres.');
  }
  const nombre = normalizar_(usuario.nombre);
  revisarBloqueo_(nombre);
  if (!actual || actual.length > LARGO_MAXIMO_CLAVE || !claveCorrecta_(usuario.id, actual)) {
    registrarFalloClave_(nombre);
    throw errorPublico_('La clave actual no es correcta.');
  }
  guardarClave_(usuario.id, nueva);
  cerrarSesiones_(usuario.id, usuario.sesion);
  return { cambiada: true };
}

/**
 * Compara la clave con la cifrada. Si existe una clave inicial puesta por el
 * administrador y calza, se cifra, se guarda y se borra la inicial; además se
 * cierran las sesiones anteriores de ese usuario.
 */
function claveCorrecta_(usuarioId, clave) {
  const propiedades = PropertiesService.getScriptProperties();
  const inicial = propiedades.getProperty('CLAVE_INICIAL_' + usuarioId);
  if (inicial && inicial.length >= LARGO_MINIMO_CLAVE && textosIguales_(clave, inicial)) {
    guardarClave_(usuarioId, clave);
    propiedades.deleteProperty('CLAVE_INICIAL_' + usuarioId);
    cerrarSesiones_(usuarioId, null);
    return true;
  }
  const guardada = String(propiedades.getProperty('CLAVE_' + usuarioId) || '');
  const partes = guardada.split('$');
  if (partes.length !== 2) {
    return false;
  }
  return textosIguales_(cifrarClave_(clave, partes[0]), partes[1]);
}

function guardarClave_(usuarioId, clave) {
  const sal = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('CLAVE_' + usuarioId, sal + '$' + cifrarClave_(clave, sal));
}

/** Cifrado de una sola vía (HMAC-SHA256 repetido): no se puede volver a la clave. */
function cifrarClave_(clave, sal) {
  const llave = Utilities.newBlob(sal).getBytes();
  let resultado = Utilities.computeHmacSha256Signature(Utilities.newBlob(clave).getBytes(), llave);
  for (let i = 1; i < VUELTAS_CIFRADO; i++) {
    resultado = Utilities.computeHmacSha256Signature(resultado, llave);
  }
  return Utilities.base64Encode(resultado);
}

/** Compara dos textos tardando lo mismo sin importar dónde difieren. */
function textosIguales_(a, b) {
  a = String(a);
  b = String(b);
  let diferencia = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diferencia |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diferencia === 0;
}

function huellaTexto_(texto) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, texto, Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

/** Abre una sesión nueva y borra las vencidas. Devuelve el comprobante (solo lo conoce el dispositivo). */
function abrirSesion_(usuarioId) {
  const token = (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const propiedades = PropertiesService.getScriptProperties();
  limpiarSesiones_(function (sesion) { return !(Number(sesion.vence) > Date.now()); });
  propiedades.setProperty('SESION_' + huellaTexto_(token),
    JSON.stringify({ u: usuarioId, vence: Date.now() + DIAS_SESION * MS_POR_DIA }));
  return token;
}

/** Cierra todas las sesiones de un usuario, salvo la indicada. */
function cerrarSesiones_(usuarioId, excepto) {
  limpiarSesiones_(function (sesion, clave) { return sesion.u === usuarioId && clave !== excepto; });
}

function limpiarSesiones_(debeBorrarse) {
  const propiedades = PropertiesService.getScriptProperties();
  const todas = propiedades.getProperties();
  Object.keys(todas).forEach(function (clave) {
    if (clave.indexOf('SESION_') !== 0) {
      return;
    }
    let sesion = null;
    try {
      sesion = JSON.parse(todas[clave]);
    } catch (e) {
      sesion = null;
    }
    if (!sesion || debeBorrarse(sesion, clave)) {
      propiedades.deleteProperty(clave);
    }
  });
}

function revisarBloqueo_(nombre) {
  if (Number(CacheService.getScriptCache().get(claveBloqueo_(nombre)) || 0) >= INTENTOS_POR_USUARIO) {
    throw errorPublico_('Demasiados intentos con clave incorrecta. Espera 3 minutos e intenta de nuevo.');
  }
}

/** Cuenta una clave incorrecta. El bloqueo dura 3 minutos desde el último intento. */
function registrarFalloClave_(nombre) {
  const cache = CacheService.getScriptCache();
  const clave = claveBloqueo_(nombre);
  cache.put(clave, String(Number(cache.get(clave) || 0) + 1), SEGUNDOS_BLOQUEO);
}

function claveBloqueo_(nombre) {
  return 'bloqueo_' + huellaTexto_(nombre);
}

/** Limita la cantidad de pedidos por usuario y minuto. */
function revisarLimite_(usuarioId) {
  const cache = CacheService.getScriptCache();
  const clave = 'lim_' + usuarioId + '_' + Math.floor(Date.now() / 60000);
  const cantidad = Number(cache.get(clave) || 0) + 1;
  cache.put(clave, String(cantidad), 120);
  if (cantidad > PEDIDOS_POR_MINUTO) {
    throw errorPublico_('Demasiados pedidos seguidos. Espera un minuto.');
  }
}

/**
 * Si en el último minuto llegaron demasiados pedidos con sesión o clave
 * inválida, se rechaza todo por un minuto, sin importar el usuario.
 */
function revisarIntentosFallidos_() {
  const cantidad = Number(CacheService.getScriptCache().get(claveIntentosFallidos_()) || 0);
  if (cantidad >= INTENTOS_FALLIDOS_POR_MINUTO) {
    throw errorPublico_('Demasiados intentos fallidos. Espera un minuto.');
  }
}

function registrarIntentoFallido_() {
  const cache = CacheService.getScriptCache();
  const clave = claveIntentosFallidos_();
  cache.put(clave, String(Number(cache.get(clave) || 0) + 1), 120);
}

function claveIntentosFallidos_() {
  return 'fallos_' + Math.floor(Date.now() / 60000);
}

function exigirAdmin_(usuario) {
  if (!usuario.esAdmin) {
    throw errorPublico_('Solo el administrador puede hacer esto.');
  }
}

/** Regla de visibilidad: los gastos familiares los ven todos; los personales, solo su dueño. */
function puedeVer_(usuario, movimiento) {
  return movimiento.usuario_id === usuario.id ||
    (movimiento.tipo === 'Familiar' && movimiento.estado !== 'Por revisar');
}

/**
 * Quién puede corregir o anular un gasto: su dueño (quien pagó) y, si es
 * familiar, también quien lo cargó a su nombre.
 */
function puedeEditar_(usuario, movimiento) {
  return movimiento.usuario_id === usuario.id ||
    (movimiento.cargado_por === usuario.id && movimiento.tipo === 'Familiar');
}

/** Usuarios activos (id y nombre), sin claves. */
function usuariosActivos_() {
  return leerTabla_('Usuarios')
    .filter(function (u) { return esSi_(u.activo); })
    .map(function (u) { return { id: String(u.id), nombre: String(u.nombre_visible) }; });
}
