/**
 * Revisión manual del backend. Se ejecuta a mano desde el editor cuando la
 * app falla. Solo lee: no modifica nada. Nunca muestra correos ni claves.
 */
function diagnosticar() {
  const resultados = [];
  function paso(nombre, funcion) {
    try {
      resultados.push('✅ ' + nombre + ': ' + funcion());
    } catch (error) {
      resultados.push('❌ ' + nombre + ': ' + (error && error.stack ? error.stack : String(error)));
    }
  }

  const propiedades = PropertiesService.getScriptProperties().getProperties();
  const clavesUsuario = Object.keys(propiedades).filter(function (k) { return k.indexOf('USUARIO_') === 0; });

  paso('CLIENT_ID', function () {
    const id = String(propiedades.CLIENT_ID || '');
    if (!id) {
      throw new Error('falta la propiedad CLIENT_ID');
    }
    if (id !== id.trim()) {
      throw new Error('tiene espacios al inicio o al final');
    }
    if (!/\.apps\.googleusercontent\.com$/.test(id)) {
      throw new Error('no termina en .apps.googleusercontent.com');
    }
    return 'existe y tiene el formato correcto';
  });

  paso('Correos autorizados', function () {
    if (!clavesUsuario.length) {
      throw new Error('no hay propiedades USUARIO_…');
    }
    return clavesUsuario.map(function (k) {
      const valor = String(propiedades[k]);
      const problemas = [];
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(valor.trim())) {
        problemas.push('no parece un correo');
      }
      if (valor !== valor.trim()) {
        problemas.push('tiene espacios de más');
      }
      return k + (problemas.length ? ' (' + problemas.join(', ') + ')' : ' (formato OK)');
    }).join('; ');
  });

  Object.keys(ESTRUCTURA).forEach(function (nombre) {
    paso('Pestaña ' + nombre, function () { return leerTabla_(nombre).length + ' filas'; });
  });

  paso('Usuarios', function () {
    const usuarios = leerTabla_('Usuarios');
    return clavesUsuario.map(function (k) {
      const id = k.slice('USUARIO_'.length);
      const u = usuarios.filter(function (x) { return x.id === id; })[0];
      if (!u) {
        return id + ' NO está en la pestaña Usuarios';
      }
      return id + ' → rol "' + u.rol + '", activo "' + u.activo + '"' + (esSi_(u.activo) ? '' : ' (NO activo)');
    }).join('; ');
  });

  paso('Conexión con Google', function () {
    const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=prueba', { muteHttpExceptions: true });
    return 'OK (respuesta ' + r.getResponseCode() + ', se espera 400 con un comprobante de prueba)';
  });

  paso('Caché y candado', function () {
    CacheService.getScriptCache().get('prueba');
    const candado = LockService.getScriptLock();
    candado.tryLock(1000);
    candado.releaseLock();
    return 'OK';
  });

  const admin = leerTabla_('Usuarios').filter(function (u) { return normalizar_(u.rol) === 'admin'; })[0];
  const usuarioPrueba = admin ? { id: String(admin.id), nombre: String(admin.nombre_visible), esAdmin: true } : null;

  paso('Usuarios activos', function () { return usuariosActivos_().length + ' usuarios'; });
  paso('Listar categorías', function () { return listarCategorias_().length + ' categorías'; });
  paso('Listar gastos', function () {
    if (!usuarioPrueba) {
      throw new Error('no hay ningún usuario con rol admin');
    }
    return listarMovimientos_(usuarioPrueba, { desde: '2000-01-01' }).length + ' gastos visibles para ' + usuarioPrueba.id;
  });
  paso('Listar ingresos', function () { return listarIngresos_(usuarioPrueba, {}).length + ' ingresos'; });
  paso('Sugerir', function () {
    return sugerir_(usuarioPrueba, { descripcion: 'starbucks' }).opciones.length + ' sugerencias para "starbucks"';
  });

  Logger.log('\n' + resultados.join('\n'));
}
