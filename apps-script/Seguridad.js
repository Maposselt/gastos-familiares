/**
 * Quién está pidiendo y qué puede ver.
 *
 * Datos que se guardan en Script Properties (nunca en el código):
 *   CLIENT_ID        ID de cliente de Google de la app web.
 *   USUARIO_<id>     Correo autorizado para ese usuario, por ejemplo USUARIO_u1.
 */

const PEDIDOS_POR_MINUTO = 60;
const INTENTOS_FALLIDOS_POR_MINUTO = 30;

/**
 * Verifica con Google el comprobante (ID token) que envía la app y devuelve
 * el usuario de la pestaña Usuarios. Si algo no calza, lanza un error.
 */
function autenticar_(token) {
  if (typeof token !== 'string' || !token || token.length > 4096) {
    throw errorPublico_('Debes iniciar sesión.');
  }
  const correo = correoDelToken_(token);

  const propiedades = PropertiesService.getScriptProperties().getProperties();
  const usuarioId = Object.keys(propiedades)
    .filter(function (clave) { return clave.indexOf('USUARIO_') === 0; })
    .filter(function (clave) { return String(propiedades[clave]).trim().toLowerCase() === correo; })
    .map(function (clave) { return clave.slice('USUARIO_'.length); })[0];
  if (!usuarioId) {
    throw errorPublico_('Tu cuenta no tiene acceso a esta app.');
  }

  const usuario = leerTabla_('Usuarios').filter(function (u) { return u.id === usuarioId; })[0];
  if (!usuario || !esSi_(usuario.activo)) {
    throw errorPublico_('Tu cuenta no tiene acceso a esta app.');
  }
  return {
    id: usuario.id,
    nombre: String(usuario.nombre_visible),
    esAdmin: normalizar_(usuario.rol) === 'admin'
  };
}

/**
 * Pregunta a Google si el comprobante es válido y es para ESTA app. El
 * resultado se guarda unos minutos en caché para no preguntar en cada pedido.
 */
function correoDelToken_(token) {
  const cache = CacheService.getScriptCache();
  const huellaToken = Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const claveCache = 'tok_' + huellaToken;
  const enCache = cache.get(claveCache);
  if (enCache) {
    return enCache;
  }

  const clientId = PropertiesService.getScriptProperties().getProperty('CLIENT_ID');
  if (!clientId) {
    throw new Error('Falta CLIENT_ID en Script Properties.');
  }
  const respuesta = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (respuesta.getResponseCode() !== 200) {
    throw errorPublico_('Tu sesión expiró. Vuelve a iniciar sesión.');
  }
  const datos = JSON.parse(respuesta.getContentText());
  const segundosRestantes = Number(datos.exp) - Math.floor(Date.now() / 1000);
  const emisorValido = datos.iss === 'accounts.google.com' || datos.iss === 'https://accounts.google.com';
  if (datos.aud !== clientId || !emisorValido || String(datos.email_verified) !== 'true' ||
      !datos.email || !(segundosRestantes > 0)) {
    throw errorPublico_('Tu sesión no es válida. Vuelve a iniciar sesión.');
  }

  const correo = String(datos.email).toLowerCase();
  cache.put(claveCache, correo, Math.min(300, segundosRestantes));
  return correo;
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
 * Si en el último minuto llegaron demasiados pedidos con comprobante
 * inválido, se rechaza todo sin consultar a Google. Así nadie puede agotar
 * la cuota diaria de consultas enviando comprobantes falsos.
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

/** Usuarios activos (id y nombre), sin correos. */
function usuariosActivos_() {
  return leerTabla_('Usuarios')
    .filter(function (u) { return esSi_(u.activo); })
    .map(function (u) { return { id: String(u.id), nombre: String(u.nombre_visible) }; });
}
