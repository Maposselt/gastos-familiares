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

  Object.keys(ESTRUCTURA).forEach(function (nombre) {
    paso('Pestaña ' + nombre, function () { return leerTabla_(nombre).length + ' filas'; });
  });

  // Solo dice si cada usuario tiene clave; nunca muestra la clave.
  paso('Usuarios y claves', function () {
    return leerTabla_('Usuarios').map(function (u) {
      const id = String(u.id);
      const inicial = String(propiedades['CLAVE_INICIAL_' + id] || '');
      const estadoClave = inicial
        ? (inicial.length < LARGO_MINIMO_CLAVE ? 'clave inicial MUY CORTA (mínimo ' + LARGO_MINIMO_CLAVE + ')' : 'clave inicial lista para el primer ingreso')
        : propiedades['CLAVE_' + id] ? 'clave cifrada guardada' : 'SIN CLAVE (crea CLAVE_INICIAL_' + id + ')';
      return id + ' "' + u.nombre_visible + '" → rol "' + u.rol + '", ' +
        (esSi_(u.activo) ? 'activo' : 'NO activo') + ', ' + estadoClave;
    }).join('; ');
  });

  paso('Sesiones abiertas', function () {
    return Object.keys(propiedades).filter(function (k) { return k.indexOf('SESION_') === 0; }).length + ' dispositivos';
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
