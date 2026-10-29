/**
 * Puerta de entrada de la app web.
 *
 * La app envía un JSON con: { token, accion, datos }.
 *   - doPost: el JSON va en el cuerpo, como texto simple (evita el bloqueo CORS).
 *   - doGet:  alternativa, el JSON va en el parámetro "payload" de la URL.
 * La respuesta siempre es { ok: true, datos } o { ok: false, error }.
 */

const LARGO_MAXIMO_PEDIDO = 200000;

function doPost(e) {
  return atender_(e && e.postData ? e.postData.contents : '');
}

function doGet(e) {
  return atender_(e && e.parameter ? e.parameter.payload : '');
}

/** Acciones que la app puede pedir. Cada una recibe (usuario, datos). */
function acciones_() {
  return {
    sesion: function (usuario) {
      return {
        usuario: { id: usuario.id, nombre: usuario.nombre, esAdmin: usuario.esAdmin },
        usuarios: usuariosActivos_()
      };
    },
    sugerir: sugerir_,
    listarMovimientos: listarMovimientos_,
    revisarDuplicados: revisarDuplicados_,
    guardarMovimiento: guardarMovimiento_,
    actualizarMovimiento: actualizarMovimiento_,
    listarCategorias: listarCategorias_,
    guardarCategoria: guardarCategoria_,
    listarIngresos: listarIngresos_,
    guardarIngreso: guardarIngreso_
  };
}

function atender_(texto) {
  let respuesta;
  try {
    if (!texto || texto.length > LARGO_MAXIMO_PEDIDO) {
      throw errorPublico_('Pedido vacío o demasiado grande.');
    }
    let pedido;
    try {
      pedido = JSON.parse(texto);
    } catch (e) {
      throw errorPublico_('Pedido con formato inválido.');
    }
    revisarIntentosFallidos_();
    let usuario;
    try {
      usuario = autenticar_(pedido.token);
    } catch (e) {
      registrarIntentoFallido_();
      throw e;
    }
    revisarLimite_(usuario.id);

    const acciones = acciones_();
    if (typeof pedido.accion !== 'string' || !Object.prototype.hasOwnProperty.call(acciones, pedido.accion)) {
      throw errorPublico_('Acción desconocida.');
    }
    const datos = pedido.datos && typeof pedido.datos === 'object' ? pedido.datos : {};
    respuesta = { ok: true, datos: acciones[pedido.accion](usuario, datos) };
  } catch (error) {
    // Al registro solo va el mensaje técnico: nunca el token ni el correo.
    if (!error.publico) {
      console.error(error && error.stack ? error.stack : String(error));
    }
    respuesta = { ok: false, error: error.publico ? error.message : 'Ocurrió un error. Intenta de nuevo.' };
  }
  return ContentService.createTextOutput(JSON.stringify(respuesta))
    .setMimeType(ContentService.MimeType.JSON);
}
