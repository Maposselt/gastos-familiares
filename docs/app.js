/**
 * App de gastos familiares (se publica en GitHub Pages).
 *
 * - Nada de los datos se guarda en el navegador: todo vive en memoria y se
 *   pide al backend, que decide qué puede ver cada uno.
 * - Lo que escriben los usuarios se muestra siempre como texto (textContent),
 *   nunca como HTML.
 * - Estos dos valores son públicos por naturaleza (no son claves).
 */
'use strict';

const SEPARADOR_DETALLE = ' — ';
const CLIENT_ID ='1065565340039-h85i836u1mip2j9ohjtfcmc3njhgt5u6.apps.googleusercontent.com';
const URL_BACKEND = 'https://script.google.com/macros/s/AKfycbwvyxaaDEZ_cst7K3kg7etnj4Mn-2jEB4Jh4Qrk79EVViBhNB55gyWflDIzEe65tP-O/exec';

const estado = {
  token: null,
  expira: 0,
  modoGet: false,
  usuario: null,
  usuarios: [],
  categorias: [],
  movimientos: null,
  ingresos: null,
  pantalla: 'nuevo',
  vistaGastos: 'lista'
};

// ---------------------------------------------------------------------------
// Utilidades de pantalla
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(id);
}

/** Crea un elemento. Los textos siempre se insertan como texto, nunca como HTML. */
function el(etiqueta, props, ...hijos) {
  const nodo = document.createElement(etiqueta);
  Object.entries(props || {}).forEach(([clave, valor]) => {
    if (valor === undefined || valor === null || valor === false) {
      return;
    }
    if (clave === 'class') {
      nodo.className = valor;
    } else if (clave === 'text') {
      nodo.textContent = valor;
    } else if (clave.startsWith('on')) {
      nodo.addEventListener(clave.slice(2), valor);
    } else if (clave in nodo && typeof valor !== 'string') {
      nodo[clave] = valor;
    } else {
      nodo.setAttribute(clave, valor === true ? '' : valor);
    }
  });
  hijos.flat().forEach((hijo) => {
    if (hijo !== null && hijo !== undefined && hijo !== false) {
      nodo.append(hijo instanceof Node ? hijo : document.createTextNode(String(hijo)));
    }
  });
  return nodo;
}

function vaciar(nodo, ...hijos) {
  nodo.replaceChildren(...hijos.flat().filter(Boolean));
}

let temporizadorAviso = null;
function avisar(mensaje, esError) {
  const aviso = $('aviso');
  aviso.textContent = mensaje;
  aviso.classList.toggle('error', !!esError);
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.hidden = true; }, esError ? 6000 : 3000);
}

/** Ejecuta una acción mostrando el error si falla y desactivando el botón mientras tanto. */
async function intentar(boton, accion) {
  if (boton) {
    boton.disabled = true;
  }
  try {
    return await accion();
  } catch (error) {
    avisar(error.message || 'Ocurrió un error.', true);
    return undefined;
  } finally {
    if (boton) {
      boton.disabled = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Formatos: montos con punto de miles y fechas DD/MM/YYYY
// ---------------------------------------------------------------------------

function pesos(n) {
  const signo = n < 0 ? '-' : '';
  return signo + '$' + Math.abs(Math.round(n)).toLocaleString('es-CL');
}

function fechaVisible(iso) {
  const [a, m, d] = String(iso).split('-');
  return d + '/' + m + '/' + a;
}

function dosDigitos(n) {
  return String(n).padStart(2, '0');
}

function hoyIso() {
  const d = new Date();
  return d.getFullYear() + '-' + dosDigitos(d.getMonth() + 1) + '-' + dosDigitos(d.getDate());
}

function mesActual() {
  return hoyIso().slice(0, 7);
}

function nombreMes(anioMes) {
  const [a, m] = anioMes.split('-').map(Number);
  const nombre = new Date(a, m - 1, 1).toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  return nombre.charAt(0).toUpperCase() + nombre.slice(1);
}

/**
 * Campo de monto: deja solo dígitos (y un "-" inicial para devoluciones) y
 * muestra los miles con punto mientras se escribe.
 */
function campoMonto(input) {
  input.addEventListener('input', () => {
    const negativo = input.value.trim().startsWith('-');
    const digitos = input.value.replace(/\D/g, '').slice(0, 10);
    input.value = (negativo ? '-' : '') + (digitos ? Number(digitos).toLocaleString('es-CL') : '');
  });
  return input;
}

function leerMonto(input) {
  const digitos = input.value.replace(/\D/g, '');
  const signo = input.value.trim().startsWith('-') ? -1 : 1;
  return digitos ? signo * Number(digitos) : 0;
}

function nombreUsuario(id) {
  const u = estado.usuarios.find((x) => x.id === id);
  return u ? u.nombre : id;
}

function categoriaPorId(id) {
  return estado.categorias.find((c) => c.id === id);
}

function etiquetaCategoria(id) {
  const c = categoriaPorId(id);
  return c ? c.categoria + ' / ' + c.subcategoria : 'Sin categoría';
}

// ---------------------------------------------------------------------------
// Inicio de sesión con Google
// ---------------------------------------------------------------------------

function iniciarGoogle() {
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: alEntrar,
    auto_select: true,
    cancel_on_tap_outside: false
  });
  google.accounts.id.renderButton($('boton-google'), {
    theme: 'outline', size: 'large', text: 'signin_with', locale: 'es'
  });
  google.accounts.id.prompt();
}

/** Lee la hora de vencimiento del comprobante (no se verifica aquí: lo verifica el backend). */
function leerVencimiento(token) {
  try {
    const parte = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(parte)).exp * 1000;
  } catch (e) {
    // Si no se puede leer, se asume la duración normal (1 hora); el backend igual lo verifica.
    return Date.now() + 3600000;
  }
}

async function alEntrar(respuesta) {
  estado.token = respuesta.credential;
  estado.expira = leerVencimiento(respuesta.credential);
  $('mensaje-entrar').textContent = 'Entrando…';
  try {
    const sesion = await llamar('sesion');
    estado.usuario = sesion.usuario;
    estado.usuarios = sesion.usuarios;
    estado.categorias = await llamar('listarCategorias');
    estado.movimientos = null;
    estado.ingresos = null;
    $('nombre-usuario').textContent = estado.usuario.nombre;
    $('sesion').hidden = false;
    $('navegacion').hidden = false;
    $('nav-config').hidden = !estado.usuario.esAdmin;
    prepararIngresos();
    vaciar($('filtro-pago'), el('option', { value: '', text: 'Todos' }),
      estado.usuarios.map((u) => el('option', { value: u.id, text: u.nombre })));
    $('mensaje-entrar').textContent = '';
    if (estado.pantalla === 'config' && !estado.usuario.esAdmin) {
      estado.pantalla = 'nuevo';
    }
    mostrarPantalla(estado.pantalla);
  } catch (error) {
    estado.token = null;
    $('mensaje-entrar').textContent = error.message;
  }
}

/** El comprobante dura una hora. Al vencer se vuelve a pedir, sin perder la pantalla. */
function sesionVencida() {
  estado.token = null;
  mostrarSoloEntrar('Tu sesión expiró. Vuelve a entrar.');
  if (window.google && google.accounts) {
    google.accounts.id.prompt();
  }
}

function mostrarSoloEntrar(mensaje) {
  document.querySelectorAll('.pantalla').forEach((p) => { p.hidden = p.id !== 'pantalla-entrar'; });
  $('navegacion').hidden = true;
  $('mensaje-entrar').textContent = mensaje || '';
}

function salir() {
  if (window.google && google.accounts) {
    google.accounts.id.disableAutoSelect();
  }
  location.reload();
}

// ---------------------------------------------------------------------------
// Comunicación con el backend
// ---------------------------------------------------------------------------

/**
 * Envía { token, accion, datos } al backend. Usa POST de texto simple (el
 * comprobante no viaja en la URL). Solo si POST falla en el primer pedido
 * (que no modifica nada) se cambia a GET con el parámetro "payload".
 */
async function llamar(accion, datos) {
  if (!estado.token || Date.now() > estado.expira - 30000) {
    sesionVencida();
    throw new Error('Tu sesión expiró. Vuelve a entrar.');
  }
  const cuerpo = JSON.stringify({ token: estado.token, accion: accion, datos: datos || {} });
  let respuesta;
  if (!estado.modoGet) {
    try {
      const r = await fetch(URL_BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: cuerpo
      });
      respuesta = await r.json();
    } catch (error) {
      if (accion !== 'sesion') {
        throw new Error('No se pudo conectar. Revisa tu internet e intenta de nuevo.');
      }
      estado.modoGet = true;
    }
  }
  if (estado.modoGet) {
    try {
      const r = await fetch(URL_BACKEND + '?payload=' + encodeURIComponent(cuerpo));
      respuesta = await r.json();
    } catch (error) {
      throw new Error('No se pudo conectar. Revisa tu internet e intenta de nuevo.');
    }
  }
  if (!respuesta.ok) {
    if (/sesi[oó]n/i.test(respuesta.error) && accion !== 'sesion') {
      sesionVencida();
    }
    throw new Error(respuesta.error);
  }
  return respuesta.datos;
}

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------

function mostrarPantalla(nombre) {
  estado.pantalla = nombre;
  document.querySelectorAll('.pantalla').forEach((p) => { p.hidden = p.id !== 'pantalla-' + nombre; });
  document.querySelectorAll('#navegacion button').forEach((b) => {
    if (b.dataset.pantalla === nombre) {
      b.setAttribute('aria-current', 'page');
    } else {
      b.removeAttribute('aria-current');
    }
  });
  if (nombre === 'nuevo') {
    pintarNuevo();
  } else if (nombre === 'gastos') {
    pintarGastos();
  } else if (nombre === 'ingresos') {
    pintarIngresos();
  } else if (nombre === 'config') {
    pintarConfig();
  }
}

// ---------------------------------------------------------------------------
// Formulario de gasto (se usa para registrar y para corregir)
// ---------------------------------------------------------------------------

/**
 * REGLA: el tipo (Familiar o Personal) siempre se elige a mano, gasto por
 * gasto. Recién con el tipo elegido aparecen las categorías de ESE tipo, y si
 * el tipo cambia, la categoría se borra para elegirla de nuevo.
 * La sugerencia del diccionario se muestra desde antes, pero solo se
 * preselecciona una categoría del tipo que el usuario eligió.
 */
function formularioGasto(opciones) {
  const inicial = opciones.inicial || {};
  let tipo = inicial.tipo || '';
  let sugerencia = null;
  let categoriaManual = false;
  let consultaActual = 0;
  let temporizadorSugerencia = null;
  let decision = '';

  // La descripción guardada es "glosa — detalle": aquí se separan para editarlas.
  const [glosaInicial, ...restoDetalle] = String(inicial.descripcion || '').split(SEPARADOR_DETALLE);
  const fecha = campoFecha(el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'DD/MM/AAAA', maxlength: '10',
    'aria-label': 'Fecha', value: fechaVisible(inicial.fecha || hoyIso())
  }));
  const monto = campoMonto(el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Monto', 'aria-label': 'Monto',
    value: inicial.monto ? Number(inicial.monto).toLocaleString('es-CL') : ''
  }));
  const descripcion = el('input', {
    type: 'text', maxlength: '200', autocomplete: 'off', 'aria-label': 'Glosa',
    placeholder: 'Glosa (como sale en la cartola)', value: glosaInicial
  });
  const detalle = el('input', {
    type: 'text', maxlength: '100', autocomplete: 'off', 'aria-label': 'Detalle',
    placeholder: 'Detalle opcional: negocio o motivo', value: restoDetalle.join(SEPARADOR_DETALLE)
  });
  const botonFamiliar = el('button', { type: 'button', 'aria-pressed': 'false', text: opciones.compacto ? 'Familiar' : '👨‍👩‍👧 Familiar' });
  const botonPersonal = el('button', { type: 'button', 'aria-pressed': 'false', text: opciones.compacto ? 'Personal' : '🙋 Personal' });
  const categoria = el('select', { disabled: true, 'aria-label': 'Categoría' });
  const pistaCategoria = el('p', { class: 'nota' });
  const pistaSugerencia = el('p', { class: 'sugerencia', hidden: true });
  const rendir = el('input', { type: 'checkbox', checked: !!inicial.rendir_trabajo });
  const filaRendir = el('label', { class: 'casilla', hidden: true }, rendir, 'Rendir al trabajo');
  const error = el('p', { class: 'error-campo', role: 'alert' });
  const boton = el('button', { type: 'button', class: 'principal', text: opciones.textoBoton || 'Guardar' });

  function pintarCategorias(categoriaElegida) {
    const grupos = new Map();
    estado.categorias
      .filter((c) => c.tipo === tipo && c.activa)
      .forEach((c) => {
        if (!grupos.has(c.categoria)) {
          grupos.set(c.categoria, []);
        }
        grupos.get(c.categoria).push(c);
      });
    vaciar(categoria,
      el('option', { value: '', text: tipo ? 'Elige una categoría' : 'Primero elige el tipo' }),
      Array.from(grupos.entries()).map(([nombre, lista]) =>
        el('optgroup', { label: nombre },
          lista.map((c) => el('option', { value: c.id, text: c.subcategoria })))));
    categoria.disabled = !tipo;
    // Si la categoría anterior no es de este tipo (o está desactivada), queda en blanco.
    categoria.value = categoriaElegida || '';
    actualizarPista();
  }

  function actualizarPista() {
    const c = categoriaPorId(categoria.value);
    if (c && c.tipo === 'Familiar') {
      const quien = c.criterio === '100%' ? ' (todo para ' + nombreUsuario(c.usuario_100) + ')' : '';
      pistaCategoria.textContent = 'Se reparte: ' + c.criterio + quien;
    } else {
      pistaCategoria.textContent = '';
    }
  }

  function elegirTipo(nuevoTipo, categoriaElegida) {
    tipo = nuevoTipo;
    botonFamiliar.setAttribute('aria-pressed', String(tipo === 'Familiar'));
    botonPersonal.setAttribute('aria-pressed', String(tipo === 'Personal'));
    filaRendir.hidden = tipo !== 'Personal';
    categoriaManual = false;
    pintarCategorias(categoriaElegida || '');
    aplicarSugerencia();
    // Si ya estaba marcado OK, cambiar el tipo obliga a revisar la categoría de nuevo.
    if (decision === 'ok' && !categoria.value) {
      marcarDecision('');
    }
  }

  /** Pide al backend la sugerencia del diccionario (gratis, sin IA). */
  async function buscarSugerencia(consulta) {
    const numero = ++consultaActual;
    let resultado = null;
    try {
      const r = await llamar('sugerir', consulta);
      resultado = r.opciones.length ? r : null;
    } catch (e) {
      resultado = null;
    }
    if (numero === consultaActual) {
      sugerencia = resultado;
      aplicarSugerencia();
    }
  }

  function textoOpcion(o) {
    const detalles = sugerencia.detalles && sugerencia.detalles.length
      ? ' · Antes: ' + sugerencia.detalles.join(', ') : '';
    return etiquetaCategoria(o.categoria_id) + ' (' + o.veces + ' de ' + sugerencia.total +
      (sugerencia.total === 1 ? ' vez' : ' veces') + (sugerencia.exacta ? '' : ', glosa parecida') + ')' + detalles;
  }

  function aplicarSugerencia() {
    if (!sugerencia) {
      pistaSugerencia.hidden = true;
      return;
    }
    pistaSugerencia.hidden = false;
    if (!tipo) {
      const mejor = sugerencia.opciones[0];
      pistaSugerencia.textContent = '💡 Sugerencia: ' + mejor.tipo + ' · ' + textoOpcion(mejor) +
        '. Elige el tipo para continuar.';
      return;
    }
    // Solo se considera la lista del tipo elegido.
    const mejorDelTipo = sugerencia.opciones.find((o) => o.tipo === tipo);
    if (!mejorDelTipo) {
      pistaSugerencia.textContent = '💡 No hay sugerencia de categoría para ' + tipo + '.';
      return;
    }
    pistaSugerencia.textContent = '💡 Sugerida para ' + tipo + ': ' + textoOpcion(mejorDelTipo);
    if (!categoriaManual && !categoria.value) {
      categoria.value = mejorDelTipo.categoria_id;
      actualizarPista();
    }
  }

  botonFamiliar.addEventListener('click', () => elegirTipo('Familiar'));
  botonPersonal.addEventListener('click', () => elegirTipo('Personal'));
  categoria.addEventListener('change', () => {
    categoriaManual = true;
    actualizarPista();
    if (decision === 'ok' && !categoria.value) {
      marcarDecision('');
    }
  });
  descripcion.addEventListener('input', () => {
    clearTimeout(temporizadorSugerencia);
    const texto = descripcion.value.trim();
    if (texto.length < 3) {
      consultaActual++;
      sugerencia = null;
      aplicarSugerencia();
      return;
    }
    temporizadorSugerencia = setTimeout(() => buscarSugerencia({ descripcion: texto }), 700);
  });
  elegirTipo(tipo, inicial.categoria_id);
  categoriaManual = !!inicial.categoria_id;
  if (opciones.sugerenciaInicial && opciones.sugerenciaInicial.opciones.length) {
    sugerencia = opciones.sugerenciaInicial;
    aplicarSugerencia();
  } else if (opciones.idMovimiento) {
    buscarSugerencia({ id: opciones.idMovimiento });
  }

  function leerDatos() {
    return {
      fecha: fechaDeCelda(fecha.value.trim()),
      monto: leerMonto(monto),
      descripcion: descripcion.value.trim(),
      detalle: detalle.value.trim(),
      tipo: tipo,
      categoria_id: categoria.value,
      rendir_trabajo: tipo === 'Personal' && rendir.checked
    };
  }

  function faltanDatosBasicos(datos) {
    return !datos.fecha ? 'La fecha no es válida (usa DD/MM/AAAA).'
      : !datos.monto ? 'Falta el monto.'
        : !datos.descripcion ? 'Falta la glosa.' : '';
  }

  function faltanDatosCompletos(datos) {
    return faltanDatosBasicos(datos) ||
      (!datos.tipo ? 'Elige si el gasto es Familiar o Personal.' : !datos.categoria_id ? 'Elige una categoría.' : '');
  }

  boton.addEventListener('click', () => {
    const datos = leerDatos();
    const faltante = faltanDatosCompletos(datos);
    error.textContent = faltante;
    if (!faltante) {
      intentar(boton, () => opciones.alGuardar(datos));
    }
  });

  // Modo "decidir y guardar al final" (importación): cada fila se marca OK,
  // Por revisar o Descartar, y la pantalla guarda todas las decisiones juntas.
  const botonesDecision = {};
  if (opciones.conDecision) {
    [['ok', opciones.textoOk || '✅ OK'], ['porRevisar', '⏸ Por revisar'], ['descartar', '🗑 Descartar']].forEach(([valor, texto]) => {
      botonesDecision[valor] = el('button', {
        type: 'button', class: 'decision decision-' + valor, 'aria-pressed': 'false', text: texto,
        onclick: () => {
          if (decision === valor) {
            marcarDecision('');
            return;
          }
          const datos = leerDatos();
          const faltante = valor === 'ok' ? faltanDatosCompletos(datos) : valor === 'porRevisar' ? faltanDatosBasicos(datos) : '';
          error.textContent = faltante;
          if (!faltante) {
            marcarDecision(valor);
          }
        }
      });
    });
  }

  function marcarDecision(valor) {
    decision = valor;
    Object.entries(botonesDecision).forEach(([v, b]) => b.setAttribute('aria-pressed', String(v === valor)));
    if (opciones.alCambiarDecision) {
      opciones.alCambiarDecision(decision);
    }
  }

  // "Por revisar": se guarda sin tipo ni categoría, para decidir más adelante.
  let botonPendiente = null;
  if (opciones.alDejarPendiente) {
    botonPendiente = el('button', { type: 'button', text: '⏸ Por revisar', title: 'Guardar sin tipo ni categoría para decidir después' });
    botonPendiente.addEventListener('click', () => {
      const datos = leerDatos();
      const faltante = faltanDatosBasicos(datos);
      error.textContent = faltante;
      if (!faltante) {
        intentar(botonPendiente, () => opciones.alDejarPendiente(datos));
      }
    });
  }

  const selectorTipo = el('div', { class: 'selector-tipo', role: 'group', 'aria-label': 'Tipo' }, botonFamiliar, botonPersonal);
  const notaTipo = opciones.sugerenciaTipo
    ? el('p', { class: 'nota', text: 'Según tu marca antigua: ' + opciones.sugerenciaTipo + '. Confírmalo eligiéndolo.' })
    : null;
  const acciones = opciones.conDecision
    ? el('div', { class: 'acciones decisiones', role: 'group', 'aria-label': 'Decisión' }, Object.values(botonesDecision))
    : el('div', { class: 'acciones' }, boton, botonPendiente, opciones.botonesExtra || []);

  if (opciones.compacto) {
    const nodo = el('div', { class: 'fila-compacta' },
      el('div', { class: 'fc-datos' }, fecha, descripcion, monto),
      detalle,
      pistaSugerencia,
      notaTipo,
      el('div', { class: 'fc-clasificar' }, selectorTipo, categoria, filaRendir),
      pistaCategoria,
      error,
      acciones);
    // La pantalla de importación lee la decisión de cada fila al guardar.
    nodo.obtenerDecision = () => {
      const datos = leerDatos();
      const faltante = decision === 'ok' ? faltanDatosCompletos(datos) : decision === 'porRevisar' ? faltanDatosBasicos(datos) : '';
      return { decision: decision, datos: datos, error: faltante };
    };
    nodo.mostrarError = (texto) => { error.textContent = texto; };
    nodo.reiniciarDecision = () => marcarDecision('');
    return nodo;
  }
  return el('div', { class: 'tarjeta' },
    el('label', {}, 'Fecha', fecha),
    el('label', {}, 'Monto', monto),
    el('label', {}, 'Glosa', descripcion),
    el('label', {}, 'Detalle (opcional)', detalle),
    pistaSugerencia,
    el('div', { class: 'etiqueta-campo', text: 'Tipo' }),
    notaTipo,
    selectorTipo,
    el('label', {}, 'Categoría', categoria),
    pistaCategoria,
    filaRendir,
    error,
    acciones);
}

/** Campo de fecha DD/MM/AAAA: agrega las barras mientras se escribe. */
function campoFecha(input) {
  input.addEventListener('input', () => {
    const digitos = input.value.replace(/\D/g, '').slice(0, 8);
    input.value = [digitos.slice(0, 2), digitos.slice(2, 4), digitos.slice(4)].filter(Boolean).join('/');
  });
  return input;
}

/** Aviso cuando un gasto confirmado resuelve otros que estaban "Por revisar". */
function mostrarPendientes(pendientes) {
  if (!pendientes || !pendientes.length) {
    return;
  }
  const dialogo = $('dialogo');
  vaciar(dialogo,
    el('h3', { text: '💡 Encontramos la categoría de ' + pendientes.length + (pendientes.length === 1 ? ' gasto que estaba' : ' gastos que estaban') + ' por revisar' }),
    el('p', { class: 'nota', text: 'Tienen la misma glosa que el gasto que acabas de confirmar. Revisa y confirma cada uno.' }),
    el('ul', { class: 'lista' }, pendientes.map((m) => el('li', { class: 'fila-pendiente' },
      el('span', { text: fechaVisible(m.fecha) + ' · ' + m.descripcion + ' · ' + pesos(m.monto) }),
      el('button', { type: 'button', text: 'Revisar', onclick: () => abrirEdicion(m) })))),
    el('div', { class: 'acciones' },
      el('button', { type: 'button', text: 'Más tarde', onclick: () => dialogo.close() })));
  if (!dialogo.open) {
    dialogo.showModal();
  }
}

// ---------------------------------------------------------------------------
// Pantalla: nuevo gasto
// ---------------------------------------------------------------------------

function pintarNuevo(fechaAnterior) {
  vaciar($('contenedor-nuevo'), formularioGasto({
    inicial: { fecha: fechaAnterior },
    textoBoton: 'Guardar gasto',
    alGuardar: (datos) => guardarNuevo(datos, false),
    alDejarPendiente: (datos) => guardarNuevo(Object.assign({}, datos, { porRevisar: true }), false)
  }));
}

async function guardarNuevo(datos, confirmarDuplicado) {
  const r = await llamar('guardarMovimiento', Object.assign({}, datos, {
    origen: 'manual', confirmarDuplicado: confirmarDuplicado
  }));
  if (r.guardado) {
    estado.movimientos = null;
    avisar(datos.porRevisar ? 'Gasto guardado como "Por revisar".' : 'Gasto guardado.');
    pintarNuevo(datos.fecha);
    mostrarPendientes(r.pendientes);
    return;
  }
  mostrarDuplicados(r.duplicados, {
    guardarIgual: () => guardarNuevo(datos, true),
    descartar: () => pintarNuevo(datos.fecha)
  });
}

/** Alerta de posible duplicado: el usuario decide. Nunca se descarta solo. */
function mostrarDuplicados(alertas, acciones) {
  const dialogo = $('dialogo');
  const botonGuardar = el('button', { type: 'button', class: 'principal', text: 'Guardar igual' });
  botonGuardar.addEventListener('click', () => {
    // Se cierra antes, porque al guardar puede abrirse el aviso de pendientes.
    dialogo.close();
    intentar(null, acciones.guardarIgual);
  });
  vaciar(dialogo,
    el('h3', { text: 'Este gasto se parece a otro ya registrado' }),
    alertas.map((a) => el('div', { class: 'alerta ' + a.nivel },
      el('strong', { text: a.nivel === 'rojo' ? '🔴 Igual: misma fecha, monto y descripción' : '🟡 Parecido: mismo monto y descripción, fecha cercana' }),
      el('div', { text: fechaVisible(a.fecha) + ' · ' + pesos(a.monto) }),
      el('div', { text: a.descripcion }))),
    el('div', { class: 'acciones' },
      botonGuardar,
      el('button', { type: 'button', class: 'peligro', text: 'Descartar', onclick: () => { dialogo.close(); acciones.descartar(); avisar('Gasto descartado.'); } }),
      el('button', { type: 'button', text: 'Volver a editar', onclick: () => dialogo.close() })));
  dialogo.showModal();
}

// ---------------------------------------------------------------------------
// Importar cartola (Excel o CSV). El archivo se lee aquí, en el navegador:
// nunca se sube completo. Solo viajan los gastos que el usuario guarda.
// ---------------------------------------------------------------------------

const MAXIMO_FILAS_IMPORTACION = 200;
const PATRONES_COLUMNA = {
  fecha: /fecha/i,
  descripcion: /descrip|glosa|detalle|comercio|concepto/i,
  monto: /monto|valor|cargo|importe|total/i
};

/** Lee un .xlsx (que es un zip con XML adentro) usando solo funciones del navegador. */
async function abrirZip(buffer) {
  const vista = new DataView(buffer);
  let fin = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (vista.getUint32(i, true) === 0x06054b50) {
      fin = i;
      break;
    }
  }
  if (fin < 0) {
    throw new Error('El archivo no parece un Excel (.xlsx) válido.');
  }
  const decodificador = new TextDecoder();
  const entradas = {};
  let p = vista.getUint32(fin + 16, true);
  for (let n = vista.getUint16(fin + 10, true); n > 0; n--) {
    const largoNombre = vista.getUint16(p + 28, true);
    entradas[decodificador.decode(new Uint8Array(buffer, p + 46, largoNombre))] = {
      metodo: vista.getUint16(p + 10, true),
      tamano: vista.getUint32(p + 20, true),
      inicio: vista.getUint32(p + 42, true)
    };
    p += 46 + largoNombre + vista.getUint16(p + 30, true) + vista.getUint16(p + 32, true);
  }
  return async function leer(nombre) {
    const e = entradas[nombre];
    if (!e) {
      return null;
    }
    const desde = e.inicio + 30 + vista.getUint16(e.inicio + 26, true) + vista.getUint16(e.inicio + 28, true);
    const bytes = new Uint8Array(buffer, desde, e.tamano);
    if (e.metodo === 0) {
      return decodificador.decode(bytes);
    }
    if (e.metodo !== 8) {
      throw new Error('Este Excel usa un formato de compresión no soportado.');
    }
    const flujo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(flujo).text();
  };
}

function leerXml(texto) {
  return new DOMParser().parseFromString(texto, 'application/xml');
}

function indiceColumna(letras) {
  return letras.split('').reduce((n, letra) => n * 26 + letra.charCodeAt(0) - 64, 0) - 1;
}

function letraColumna(indice) {
  let letras = '';
  for (let n = indice + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letras = String.fromCharCode(65 + ((n - 1) % 26)) + letras;
  }
  return letras;
}

/** Devuelve la primera hoja del Excel como lista de filas (arreglos de valores). */
async function leerExcel(buffer) {
  const leer = await abrirZip(buffer);
  const textos = [];
  const compartidos = await leer('xl/sharedStrings.xml');
  if (compartidos) {
    Array.from(leerXml(compartidos).getElementsByTagName('si')).forEach((si) => {
      textos.push(Array.from(si.getElementsByTagName('t'))
        .filter((t) => t.parentNode.nodeName !== 'rPh')
        .map((t) => t.textContent).join(''));
    });
  }
  const libro = leerXml(await leer('xl/workbook.xml'));
  const primeraHoja = libro.getElementsByTagName('sheet')[0];
  const relaciones = leerXml(await leer('xl/_rels/workbook.xml.rels'));
  const relacion = Array.from(relaciones.getElementsByTagName('Relationship'))
    .find((r) => r.getAttribute('Id') === primeraHoja.getAttribute('r:id'));
  const destino = relacion.getAttribute('Target').replace(/^\//, '');
  const hoja = leerXml(await leer(destino.startsWith('xl/') ? destino : 'xl/' + destino));

  return Array.from(hoja.getElementsByTagName('row')).map((fila) => {
    const valores = [];
    Array.from(fila.getElementsByTagName('c')).forEach((c) => {
      const tipo = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let valor = '';
      if (tipo === 'inlineStr') {
        valor = Array.from(c.getElementsByTagName('t')).map((t) => t.textContent).join('');
      } else if (v) {
        valor = tipo === 's' ? textos[Number(v.textContent)] : tipo === 'str' || tipo === 'b' ? v.textContent : Number(v.textContent);
      }
      valores[indiceColumna(c.getAttribute('r').replace(/\d+/g, ''))] = valor;
    });
    return Array.from(valores, (x) => (x === undefined ? '' : x));
  });
}

/** CSV con separador "," ";" o tabulación, en UTF-8 o la codificación de Excel en Windows. */
function leerCsv(buffer) {
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    texto = new TextDecoder('windows-1252').decode(buffer);
  }
  texto = texto.replace(/^﻿/, '');
  const primera = texto.split(/\r?\n/)[0];
  const separador = [';', '\t', ','].reduce((mejor, s) =>
    primera.split(s).length > primera.split(mejor).length ? s : mejor, ',');
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (ch === '"') {
        comillas = false;
      } else {
        campo += ch;
      }
    } else if (ch === '"') {
      comillas = true;
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
  if (campo || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

/** Fecha de una celda: número de serie de Excel, DD/MM/YYYY o YYYY-MM-DD. Devuelve ISO o ''. */
function fechaDeCelda(valor) {
  let a;
  let m;
  let d;
  if (typeof valor === 'number') {
    if (valor < 32874 || valor > 73051) {
      return '';
    }
    const utc = new Date(Math.round((valor - 25569) * 86400000));
    [a, m, d] = [utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate()];
  } else {
    const texto = String(valor || '').trim();
    let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(texto);
    if (r) {
      [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
    } else if ((r = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/.exec(texto))) {
      [a, m, d] = [r[3].length === 2 ? 2000 + Number(r[3]) : Number(r[3]), Number(r[2]), Number(r[1])];
    } else if (/^\d{5}(\.\d+)?$/.test(texto)) {
      return fechaDeCelda(Number(texto));
    } else {
      return '';
    }
  }
  const prueba = new Date(a, m - 1, d);
  if (prueba.getFullYear() !== a || prueba.getMonth() !== m - 1 || prueba.getDate() !== d) {
    return '';
  }
  return a + '-' + dosDigitos(m) + '-' + dosDigitos(d);
}

/** Monto de una celda: número o texto como "$ 12.345" o "-12.345". */
function montoDeCelda(valor) {
  if (typeof valor === 'number') {
    return Math.round(valor);
  }
  const texto = String(valor || '').replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(texto) ? Math.round(Number(texto)) : 0;
}

/** Busca, en las primeras filas, una fila de encabezados con fecha, descripción y monto. */
function detectarColumnas(filas) {
  for (let i = 0; i < Math.min(15, filas.length); i++) {
    const columnas = {};
    filas[i].forEach((valor, j) => {
      const texto = typeof valor === 'string' ? valor.trim() : '';
      Object.keys(PATRONES_COLUMNA).forEach((campo) => {
        if (columnas[campo] === undefined && texto.length < 40 && PATRONES_COLUMNA[campo].test(texto)) {
          columnas[campo] = j;
        }
      });
    });
    if (Object.keys(PATRONES_COLUMNA).every((campo) => columnas[campo] !== undefined)) {
      return { encabezado: i, columnas: columnas };
    }
  }
  return null;
}

async function importarArchivo(archivo) {
  const contenedor = $('contenedor-importacion');
  if (archivo.size > 5 * 1024 * 1024) {
    avisar('El archivo es muy grande (máximo 5 MB).', true);
    return;
  }
  vaciar(contenedor, el('p', { class: 'cargando', text: 'Leyendo ' + archivo.name + '…' }));
  contenedor.hidden = false;
  $('contenedor-nuevo').hidden = true;
  try {
    const buffer = await archivo.arrayBuffer();
    const filas = /\.csv$/i.test(archivo.name) ? leerCsv(buffer) : await leerExcel(buffer);
    const detectado = detectarColumnas(filas) || adivinarColumnas(filas);
    mostrarVistaPrevia(filas, detectado, archivo.name);
  } catch (error) {
    avisar('No pude leer el archivo: ' + error.message, true);
    cerrarImportacion();
  }
}

/**
 * Si el archivo no tiene títulos, deduce las columnas por su contenido:
 * fechas (texto o números de Excel que caen en un rango corto de días),
 * montos (números) y glosa (textos).
 */
function adivinarColumnas(filas) {
  const muestra = filas.slice(0, 40).filter((f) => f.some((v) => v !== ''));
  const cantidad = Math.max(0, ...muestra.map((f) => f.length));
  const puntajes = Array.from({ length: cantidad }, (x, j) => {
    const valores = muestra.map((f) => f[j]).filter((v) => v !== '' && v !== undefined);
    const numeros = valores.filter((v) => typeof v === 'number');
    const rangoCorto = numeros.length > 0 && Math.max(...numeros) - Math.min(...numeros) < 1000;
    return {
      fechas: valores.filter((v) => (typeof v === 'number' ? rangoCorto : true) && fechaDeCelda(v)).length,
      montos: valores.filter((v) => montoDeCelda(v) !== 0).length,
      textos: valores.filter((v) => typeof v === 'string' && /[a-záéíóúñ]{3}/i.test(v) && !fechaDeCelda(v)).length
    };
  });
  const mejor = (campo, excluir) => puntajes
    .map((p, j) => ({ j: j, valor: p[campo] }))
    .filter((p) => excluir.indexOf(p.j) < 0)
    .sort((a, b) => b.valor - a.valor)[0];
  const fecha = mejor('fechas', []);
  const descripcion = mejor('textos', [fecha ? fecha.j : -1]);
  const monto = mejor('montos', [fecha ? fecha.j : -1, descripcion ? descripcion.j : -1]);
  return {
    encabezado: -1,
    columnas: { fecha: fecha ? fecha.j : 0, descripcion: descripcion ? descripcion.j : 0, monto: monto ? monto.j : 0 }
  };
}

/**
 * Convierte las filas en gastos. Si una fila no trae fecha (algunas cartolas
 * la ponen solo en el primer gasto del día), usa la de la fila anterior.
 */
function armarItems(filas, columnas) {
  const items = [];
  let omitidas = 0;
  let fechaAnterior = '';
  filas.forEach((f) => {
    if (!f.some((v) => v !== '')) {
      return;
    }
    const fechaPropia = fechaDeCelda(f[columnas.fecha]);
    const item = {
      fecha: fechaPropia || (f[columnas.fecha] === '' || f[columnas.fecha] === undefined ? fechaAnterior : ''),
      monto: montoDeCelda(f[columnas.monto]),
      descripcion: String(f[columnas.descripcion] === undefined ? '' : f[columnas.descripcion]).trim().slice(0, 200)
    };
    if (fechaPropia) {
      fechaAnterior = fechaPropia;
    }
    if (item.fecha && item.monto && item.descripcion) {
      items.push(item);
    } else {
      omitidas++;
    }
  });
  return { items: items, omitidas: omitidas };
}

/** Muestra cómo quedarán las primeras filas, con las columnas elegidas, antes de continuar. */
function mostrarVistaPrevia(filas, detectado, nombreArchivo) {
  const cantidad = Math.max(0, ...filas.slice(0, 40).map((f) => f.length));
  const ejemplo = filas.find((f, i) => i > detectado.encabezado && f.filter((v) => v !== '').length >= 2) || [];
  const selectores = {};
  const campos = Object.entries({ fecha: 'Fecha', descripcion: 'Glosa', monto: 'Monto' }).map(([campo, titulo]) => {
    selectores[campo] = el('select', {},
      Array.from({ length: cantidad }, (x, j) => el('option', {
        value: String(j),
        text: 'Columna ' + letraColumna(j) + (ejemplo[j] !== undefined && ejemplo[j] !== '' ? ' (ej.: ' + String(ejemplo[j]).slice(0, 25) + ')' : '')
      })));
    selectores[campo].value = String(detectado.columnas[campo]);
    selectores[campo].addEventListener('change', actualizar);
    return el('label', {}, titulo, selectores[campo]);
  });
  const conTitulos = el('input', { type: 'checkbox', checked: detectado.encabezado >= 0 });
  conTitulos.addEventListener('change', actualizar);
  const previa = el('div', { class: 'tabla-contenedor' });
  const resumen = el('p', { class: 'nota' });
  const boton = el('button', { type: 'button', class: 'principal', text: 'Continuar' });
  let resultado = { items: [], omitidas: 0 };

  function columnasElegidas() {
    const columnas = {};
    Object.keys(selectores).forEach((campo) => { columnas[campo] = Number(selectores[campo].value); });
    return columnas;
  }
  function filasDeDatos() {
    const desde = conTitulos.checked ? Math.max(detectado.encabezado, 0) + 1 : 0;
    return filas.slice(desde);
  }
  function actualizar() {
    resultado = armarItems(filasDeDatos(), columnasElegidas());
    resumen.textContent = resultado.items.length + ' gastos listos para revisar' +
      (resultado.omitidas ? ' · ' + resultado.omitidas + ' filas sin fecha, glosa o monto válidos se omitirán' : '') + '.';
    vaciar(previa, el('table', { class: 'tabla tabla-gastos' },
      el('thead', {}, el('tr', {}, el('th', { text: 'Fecha' }), el('th', { text: 'Glosa' }), el('th', { text: 'Monto' }))),
      el('tbody', {}, resultado.items.slice(0, 5).map((i) => el('tr', {},
        el('td', { text: fechaVisible(i.fecha) }), el('td', { text: i.descripcion }), el('td', { text: pesos(i.monto) }))))));
    boton.disabled = !resultado.items.length;
  }
  boton.addEventListener('click', () => intentar(boton, () => prepararRevision(resultado, nombreArchivo)));
  actualizar();

  vaciar($('contenedor-importacion'), el('div', { class: 'tarjeta' },
    el('h3', { text: '📄 ' + nombreArchivo }),
    el('p', { class: 'nota', text: 'Revisa que las primeras filas se vean bien. Si no, cambia las columnas.' }),
    el('div', { class: 'columnas-importacion' }, campos),
    el('label', { class: 'casilla' }, conTitulos, 'La primera fila son títulos'),
    el('h3', { text: 'Vista previa' }),
    previa,
    resumen,
    el('div', { class: 'acciones' }, boton,
      el('button', { type: 'button', text: 'Cancelar', onclick: cerrarImportacion }))));
}

/** Revisa duplicados y busca sugerencias para todos los gastos de una vez. */
async function prepararRevision(resultado, nombreArchivo) {
  const items = resultado.items.slice();
  const omitidas = resultado.omitidas;
  let recortadas = 0;
  if (items.length > MAXIMO_FILAS_IMPORTACION) {
    recortadas = items.length - MAXIMO_FILAS_IMPORTACION;
    items.length = MAXIMO_FILAS_IMPORTACION;
  }
  if (!items.length) {
    throw new Error('No encontré gastos con fecha, descripción y monto válidos.');
  }

  vaciar($('contenedor-importacion'), el('p', { class: 'cargando', text: 'Revisando ' + items.length + ' gastos…' }));
  const [duplicados, sugerencias] = await Promise.all([
    llamar('revisarDuplicados', { items: items }),
    llamar('sugerirVarios', { descripciones: items.map((i) => i.descripcion) })
  ]);
  pintarRevision(items, duplicados, sugerencias, {
    nombreArchivo: nombreArchivo, omitidas: omitidas, recortadas: recortadas
  });
}

function textoAlerta(a) {
  return a.enEstaCarga !== undefined
    ? (a.nivel === 'rojo' ? '🔴' : '🟡') + ' Se repite en el gasto ' + (a.enEstaCarga + 1) + ' de este archivo'
    : (a.nivel === 'rojo' ? '🔴 Ya registrado: ' : '🟡 Parecido a: ') + fechaVisible(a.fecha) + ' · ' + a.descripcion + ' · ' + pesos(a.monto);
}

/**
 * Una fila por gasto, con su propia decisión: OK, Por revisar o Descartar.
 * REGLA: cada gasto se confirma por separado, con su propio tipo; no hay forma
 * de asignar el tipo o la decisión a varios a la vez. El botón final solo
 * ejecuta lo que ya se decidió en cada fila.
 */
function pintarRevision(items, duplicados, sugerencias, info) {
  const contador = el('p', { class: 'contador' });
  const botonGuardar = el('button', { type: 'button', class: 'principal', text: 'Guardar decisiones' });
  const resumenDecisiones = el('span', { class: 'resumen-decisiones' });

  const filas = items.map((item, i) => {
    const fila = { item: item, terminada: false, alertas: (duplicados[i] && duplicados[i].alertas) || [] };
    fila.caja = el('li', { class: 'fila-importacion' });
    fila.avisos = el('div', {}, fila.alertas.map((a) => el('div', { class: 'alerta compacta ' + a.nivel, text: textoAlerta(a) })));
    fila.formulario = formularioGasto({
      compacto: true,
      conDecision: true,
      // Con una alerta visible, marcar OK significa "guardar igual".
      textoOk: fila.alertas.length ? '✅ OK (guardar igual)' : '✅ OK',
      inicial: item,
      sugerenciaInicial: sugerencias[i],
      alCambiarDecision: actualizarBarra
    });
    vaciar(fila.caja, el('div', { class: 'numero-importacion', text: (i + 1) + ' de ' + items.length }), fila.avisos, fila.formulario);
    return fila;
  });

  function terminar(fila, texto) {
    fila.terminada = true;
    fila.caja.classList.add('terminada');
    vaciar(fila.caja, el('p', { class: 'nota', text: texto + ': ' + fechaVisible(fila.item.fecha) + ' · ' + fila.item.descripcion + ' · ' + pesos(fila.item.monto) }));
  }

  function actualizarBarra() {
    const conteo = { ok: 0, porRevisar: 0, descartar: 0, '': 0 };
    const pendientes = filas.filter((f) => !f.terminada);
    pendientes.forEach((f) => { conteo[f.formulario.obtenerDecision().decision]++; });
    const listos = items.length - pendientes.length;
    contador.textContent = 'Listos ' + listos + ' de ' + items.length + (pendientes.length ? '' : ' ✅ ¡Terminado!');
    resumenDecisiones.textContent = conteo.ok + ' OK · ' + conteo.porRevisar + ' por revisar · ' +
      conteo.descartar + ' descartar · ' + conteo[''] + ' sin decidir';
    botonGuardar.disabled = !(conteo.ok + conteo.porRevisar + conteo.descartar);
  }

  async function guardarDecisiones() {
    const aEnviar = [];
    filas.filter((f) => !f.terminada).forEach((f) => {
      const d = f.formulario.obtenerDecision();
      if (!d.decision) {
        return;
      }
      if (d.error) {
        f.formulario.mostrarError(d.error);
        return;
      }
      if (d.decision === 'descartar') {
        terminar(f, '🗑️ Descartado');
        return;
      }
      aEnviar.push({ fila: f, datos: Object.assign({}, d.datos, {
        origen: 'excel', porRevisar: d.decision === 'porRevisar', confirmarDuplicado: f.alertas.length > 0
      }) });
    });
    if (aEnviar.length) {
      const r = await llamar('guardarVarios', { decisiones: aEnviar.map((x) => x.datos) });
      let guardados = 0;
      r.resultados.forEach((resultado, j) => {
        const { fila, datos } = aEnviar[j];
        if (resultado.guardado) {
          guardados++;
          terminar(fila, datos.porRevisar ? '⏸ Por revisar' : '✅ Guardado');
        } else if (resultado.duplicados) {
          // Duplicado que no se veía antes (por ejemplo, con otro gasto de esta carga): se muestra y se vuelve a decidir.
          fila.alertas = resultado.duplicados;
          vaciar(fila.avisos, resultado.duplicados.map((a) => el('div', { class: 'alerta compacta ' + a.nivel, text: textoAlerta(a) })));
          fila.formulario.reiniciarDecision();
          fila.formulario.mostrarError('Se parece a otro gasto. Revísalo y vuelve a marcar OK para guardarlo igual.');
        } else {
          fila.formulario.mostrarError(resultado.error);
        }
      });
      estado.movimientos = null;
      avisar(guardados + (guardados === 1 ? ' gasto guardado.' : ' gastos guardados.'));
      mostrarPendientes(r.pendientes);
    }
    actualizarBarra();
  }
  botonGuardar.addEventListener('click', () => intentar(botonGuardar, guardarDecisiones));
  const tarjetas = filas.map((f) => f.caja);

  const avisos = [];
  if (info.omitidas) {
    avisos.push(info.omitidas + ' filas sin fecha, descripción o monto válidos no se incluyeron.');
  }
  if (info.recortadas) {
    avisos.push('Solo se incluyeron los primeros ' + MAXIMO_FILAS_IMPORTACION + ' gastos; ' + info.recortadas + ' quedaron fuera. Impórtalos en otro archivo.');
  }
  actualizarBarra();
  vaciar($('contenedor-importacion'),
    el('div', { class: 'cabecera-importacion' },
      el('h3', { text: '📄 ' + info.nombreArchivo }),
      contador,
      el('p', { class: 'nota', text: 'En cada gasto elige Familiar o Personal, revisa la categoría y marca OK, Por revisar o Descartar. Al final toca "Guardar decisiones".' }),
      avisos.map((a) => el('p', { class: 'nota', text: a })),
      el('button', { type: 'button', text: 'Cerrar importación', onclick: () => {
        if (filas.every((f) => f.terminada) || confirm('Quedan gastos sin guardar. ¿Cerrar igual? Podrás importar el archivo de nuevo: lo ya guardado aparecerá como duplicado.')) {
          cerrarImportacion();
        }
      } })),
    el('ul', { class: 'lista lista-importacion' }, tarjetas),
    el('div', { class: 'barra-decisiones' }, resumenDecisiones, botonGuardar));
}

function cerrarImportacion() {
  vaciar($('contenedor-importacion'));
  $('contenedor-importacion').hidden = true;
  $('contenedor-nuevo').hidden = false;
  $('archivo-cartola').value = '';
}

// ---------------------------------------------------------------------------
// Pantalla: gastos
// ---------------------------------------------------------------------------

async function cargarMovimientos() {
  if (!estado.movimientos) {
    estado.movimientos = await llamar('listarMovimientos', { desde: '2000-01-01' });
  }
  return estado.movimientos;
}

async function pintarGastos() {
  const lista = $('lista-gastos');
  if (!$('filtro-mes').value) {
    $('filtro-mes').value = mesActual();
  }
  if (!estado.movimientos) {
    vaciar(lista, el('p', { class: 'cargando', text: 'Cargando gastos…' }));
    vaciar($('totales-mes'));
    vaciar($('por-revisar'));
  }
  const movimientos = await intentar(null, cargarMovimientos);
  if (!movimientos || estado.pantalla !== 'gastos') {
    return;
  }

  const propiosPorRevisar = movimientos
    .filter((m) => m.estado === 'Por revisar' && m.usuario_id === estado.usuario.id)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  vaciar($('por-revisar'), propiosPorRevisar.length
    ? el('details', { class: 'revisar' },
      el('summary', { text: 'Tienes ' + propiosPorRevisar.length + ' gastos por revisar' }),
      el('p', { class: 'nota', text: 'Toca uno para elegir su tipo y categoría.' }),
      tablaGastos(propiosPorRevisar))
    : null);

  const mes = $('filtro-mes').value;
  const tipo = $('filtro-tipo').value;
  const verAnulados = $('filtro-anulados').checked;
  const delMes = movimientos.filter((m) => m.fecha.startsWith(mes));
  const vigentes = delMes.filter((m) => m.estado === 'Confirmado');

  const totalFamiliar = vigentes.filter((m) => m.tipo === 'Familiar').reduce((s, m) => s + m.monto, 0);
  const miParte = vigentes.filter((m) => m.tipo === 'Familiar').reduce((s, m) =>
    s + m.repartos.filter((r) => r.usuario_id === estado.usuario.id).reduce((t, r) => t + r.monto, 0), 0);
  const personales = vigentes.filter((m) => m.tipo === 'Personal' && m.usuario_id === estado.usuario.id);
  const totalPersonal = personales.reduce((s, m) => s + m.monto, 0);
  const totalRendir = personales.filter((m) => m.rendir_trabajo).reduce((s, m) => s + m.monto, 0);

  vaciar($('totales-mes'),
    tarjetaTotal('Familiar del mes', totalFamiliar),
    tarjetaTotal('Mi parte familiar', miParte),
    tarjetaTotal('Mis personales', totalPersonal),
    totalRendir ? tarjetaTotal('Por rendir al trabajo', totalRendir) : null);

  document.querySelectorAll('.selector-vista button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.vista === estado.vistaGastos));
  });
  const pago = $('filtro-pago').value;
  const delTipo = delMes.filter((m) => (!tipo || m.tipo === tipo) && (!pago || m.usuario_id === pago));
  if (estado.vistaGastos === 'resumen') {
    vaciar(lista, resumenPorCategoria(delTipo.filter((m) => m.estado === 'Confirmado'), mes));
    return;
  }
  const visibles = delTipo
    .filter((m) => verAnulados || m.estado !== 'Anulado')
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  vaciar(lista, visibles.length
    ? tablaGastos(visibles)
    : el('p', { class: 'nota', text: 'No hay gastos en ' + nombreMes(mes) + '.' }));
}

function tarjetaTotal(titulo, monto) {
  return el('div', { class: 'total' }, el('span', { text: titulo }), el('strong', { text: pesos(monto) }));
}

/** Tabla compacta: Fecha · Glosa · Categoría · Pagó · Monto. Los gastos propios se abren para editar. */
function tablaGastos(movimientos) {
  return el('div', { class: 'tabla-contenedor' }, el('table', { class: 'tabla tabla-gastos' },
    el('thead', {}, el('tr', {},
      el('th', { text: 'Fecha' }), el('th', { text: 'Glosa' }), el('th', { text: 'Categoría' }),
      el('th', { text: 'Pagó' }), el('th', { text: 'Monto' }))),
    el('tbody', {}, movimientos.map(filaGasto))));
}

function filaGasto(m) {
  const propio = m.usuario_id === estado.usuario.id;
  const clases = [m.tipo === 'Familiar' ? 'familiar' : '', m.estado === 'Anulado' ? 'anulado' : '', propio ? 'editable' : '']
    .filter(Boolean).join(' ');
  const fila = el('tr', { class: clases },
    el('td', { text: fechaVisible(m.fecha).slice(0, 5) }),
    el('td', { class: 'celda-glosa' },
      m.descripcion,
      m.estado !== 'Confirmado' ? el('span', { class: 'etiqueta', text: m.estado }) : null,
      m.rendir_trabajo ? el('span', { class: 'etiqueta', text: 'Rendir' }) : null),
    el('td', { text: m.categoria_id ? etiquetaCategoria(m.categoria_id) : '—' }),
    el('td', { text: nombreUsuario(m.usuario_id) }),
    el('td', { class: 'celda-monto', text: pesos(m.monto) }));
  if (propio) {
    fila.tabIndex = 0;
    fila.setAttribute('aria-label', 'Editar ' + m.descripcion);
    fila.addEventListener('click', () => abrirEdicion(m));
    fila.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        abrirEdicion(m);
      }
    });
  }
  return fila;
}

/**
 * Total del mes por categoría y subcategoría. Al tocar una fila se
 * despliegan (o se esconden) los gastos que la componen.
 */
function resumenPorCategoria(movimientos, mes) {
  if (!movimientos.length) {
    return el('p', { class: 'nota', text: 'No hay gastos confirmados en ' + nombreMes(mes) + '.' });
  }
  return ['Familiar', 'Personal'].map((tipo) => {
    const delTipo = movimientos.filter((m) => m.tipo === tipo);
    if (!delTipo.length) {
      return null;
    }
    const grupos = new Map();
    delTipo.forEach((m) => {
      const c = categoriaPorId(m.categoria_id) || { categoria: 'Sin categoría', subcategoria: '—', orden: 0 };
      if (!grupos.has(c.categoria)) {
        grupos.set(c.categoria, new Map());
      }
      const subcategorias = grupos.get(c.categoria);
      if (!subcategorias.has(c.subcategoria)) {
        subcategorias.set(c.subcategoria, { orden: c.orden, gastos: [] });
      }
      subcategorias.get(c.subcategoria).gastos.push(m);
    });

    const suma = (lista) => lista.reduce((s, m) => s + m.monto, 0);
    const filas = [];
    Array.from(grupos.keys()).sort((a, b) => a.localeCompare(b, 'es')).forEach((nombre) => {
      const subcategorias = Array.from(grupos.get(nombre).entries()).sort((a, b) => a[1].orden - b[1].orden);
      const todos = subcategorias.flatMap(([, s]) => s.gastos);
      const detallesCategoria = [];
      const filaCategoria = filaDesplegable(
        [el('td', { text: nombre }), el('td', { text: '' }), el('td', { class: 'celda-monto', text: String(todos.length) }), el('td', { class: 'celda-monto', text: pesos(suma(todos)) })],
        'fila-categoria-resumen', detallesCategoria);
      filas.push(filaCategoria);
      subcategorias.forEach(([sub, s]) => {
        const detalle = s.gastos.sort((a, b) => b.fecha.localeCompare(a.fecha)).map((m) => el('tr', { class: 'fila-detalle', hidden: true },
          el('td', {}), el('td', { text: fechaVisible(m.fecha).slice(0, 5) + ' · ' + m.descripcion + (tipo === 'Familiar' ? ' · pagó ' + nombreUsuario(m.usuario_id) : '') }),
          el('td', {}), el('td', { class: 'celda-monto', text: pesos(m.monto) })));
        detallesCategoria.push(...detalle);
        filas.push(filaDesplegable(
          [el('td', {}), el('td', { text: sub }), el('td', { class: 'celda-monto', text: String(s.gastos.length) }), el('td', { class: 'celda-monto', text: pesos(suma(s.gastos)) })],
          'fila-subcategoria-resumen', detalle));
        filas.push(...detalle);
      });
    });
    filas.push(el('tr', { class: 'fila-total' },
      el('td', { text: 'Total ' + tipo.toLowerCase() }), el('td', {}),
      el('td', { class: 'celda-monto', text: String(delTipo.length) }), el('td', { class: 'celda-monto', text: pesos(suma(delTipo)) })));

    return el('div', { class: 'tarjeta' },
      el('h3', { text: tipo === 'Familiar' ? '👨‍👩‍👧 Familiares' : '🙋 Personales' }),
      el('div', { class: 'tabla-contenedor' }, el('table', { class: 'tabla tabla-resumen' },
        el('thead', {}, el('tr', {},
          el('th', { text: 'Categoría' }), el('th', { text: 'Subcategoría' }),
          el('th', { text: 'N°' }), el('th', { text: 'Total' }))),
        el('tbody', {}, filas))));
  });
}

/** Fila que al tocarla muestra u oculta sus filas de detalle. */
function filaDesplegable(celdas, clase, detalle) {
  const fila = el('tr', { class: clase + ' desplegable', tabindex: '0', 'aria-expanded': 'false' }, celdas);
  function alternar() {
    const abrir = fila.getAttribute('aria-expanded') !== 'true';
    fila.setAttribute('aria-expanded', String(abrir));
    detalle.forEach((d) => { d.hidden = !abrir; });
  }
  fila.addEventListener('click', alternar);
  fila.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      alternar();
    }
  });
  return fila;
}

/** Corregir, confirmar, anular o restaurar un gasto propio. */
function abrirEdicion(m) {
  const dialogo = $('dialogo');
  const porRevisar = m.estado === 'Por revisar';
  const anulado = m.estado === 'Anulado';
  const extras = [];
  if (!anulado) {
    const botonAnular = el('button', { type: 'button', class: 'peligro', text: 'Anular gasto' });
    botonAnular.addEventListener('click', () => {
      if (!confirm('¿Anular este gasto? Dejará de contar en los totales. Podrás restaurarlo después.')) {
        return;
      }
      intentar(botonAnular, async () => {
        await llamar('actualizarMovimiento', { id: m.id, estado: 'Anulado' });
        terminarEdicion('Gasto anulado.');
      });
    });
    extras.push(botonAnular);
  }
  extras.push(el('button', { type: 'button', text: 'Cancelar', onclick: () => dialogo.close() }));

  vaciar(dialogo,
    el('h3', { text: porRevisar ? 'Revisar gasto' : anulado ? 'Restaurar gasto anulado' : 'Editar gasto' }),
    formularioGasto({
      inicial: porRevisar ? Object.assign({}, m, { tipo: '', categoria_id: '' }) : m,
      sugerenciaTipo: porRevisar ? m.tipo : '',
      idMovimiento: m.id,
      textoBoton: anulado ? 'Restaurar' : porRevisar ? 'Confirmar' : 'Guardar cambios',
      botonesExtra: extras,
      alGuardar: async (datos) => {
        const r = await llamar('actualizarMovimiento', Object.assign({ id: m.id }, datos));
        terminarEdicion(anulado ? 'Gasto restaurado.' : 'Cambios guardados.');
        mostrarPendientes(r.pendientes);
      }
    }));
  // Puede abrirse desde el aviso de pendientes, con el diálogo ya abierto.
  if (!dialogo.open) {
    dialogo.showModal();
  }
}

function terminarEdicion(mensaje) {
  $('dialogo').close();
  estado.movimientos = null;
  avisar(mensaje);
  if (estado.pantalla === 'gastos') {
    pintarGastos();
  }
}

// ---------------------------------------------------------------------------
// Pantalla: ingresos
// ---------------------------------------------------------------------------

/** El administrador puede registrar o corregir el ingreso de cualquiera; el resto, solo el suyo. */
function prepararIngresos() {
  const esAdmin = estado.usuario.esAdmin;
  $('fila-ingreso-usuario').hidden = !esAdmin;
  $('titulo-ingreso').textContent = esAdmin ? 'Registrar o corregir un ingreso' : 'Registrar mi ingreso';
  vaciar($('ingreso-usuario'), estado.usuarios.map((u) => el('option', { value: u.id, text: u.nombre })));
  $('ingreso-usuario').value = estado.usuario.id;
}

function puedeEditarIngreso(usuarioId) {
  return estado.usuario.esAdmin || usuarioId === estado.usuario.id;
}

/** Carga en el formulario un mes de la tabla para corregirlo. */
function editarIngreso(mes, usuarioId, monto) {
  $('ingreso-mes').value = mes;
  $('ingreso-usuario').value = usuarioId;
  $('ingreso-monto').value = monto ? monto.toLocaleString('es-CL') : '';
  $('titulo-ingreso').scrollIntoView({ behavior: 'smooth' });
  $('ingreso-monto').focus();
}

async function pintarIngresos() {
  if (!$('ingreso-mes').value) {
    $('ingreso-mes').value = mesActual();
  }
  const tabla = $('tabla-ingresos');
  if (!estado.ingresos) {
    vaciar(tabla, el('caption', { class: 'cargando', text: 'Cargando ingresos…' }));
    estado.ingresos = await intentar(null, () => llamar('listarIngresos'));
  }
  if (!estado.ingresos || estado.pantalla !== 'ingresos') {
    return;
  }

  const porMes = new Map();
  estado.ingresos.forEach((i) => {
    const clave = i.anio + '-' + dosDigitos(i.mes);
    if (!porMes.has(clave)) {
      porMes.set(clave, {});
    }
    porMes.get(clave)[i.usuario_id] = (porMes.get(clave)[i.usuario_id] || 0) + i.monto;
  });
  const meses = Array.from(porMes.keys()).sort().reverse().slice(0, 12);
  const primero = estado.usuarios[0];

  vaciar(tabla,
    el('caption', { class: 'nota', text: 'Últimos 12 meses con ingresos' }),
    el('thead', {}, el('tr', {},
      el('th', { text: 'Mes' }),
      estado.usuarios.map((u) => el('th', { text: u.nombre })),
      el('th', { text: '% ' + (primero ? primero.nombre : '') }))),
    el('tbody', {}, meses.map((mes) => {
      const fila = porMes.get(mes);
      const total = estado.usuarios.reduce((s, u) => s + (fila[u.id] || 0), 0);
      const completo = estado.usuarios.every((u) => fila[u.id] > 0);
      return el('tr', {},
        el('td', { text: nombreMes(mes) }),
        estado.usuarios.map((u) => el('td', {},
          fila[u.id] ? pesos(fila[u.id]) : '—',
          puedeEditarIngreso(u.id)
            ? el('button', {
              type: 'button', class: 'enlace', text: '✏️',
              'aria-label': 'Corregir ingreso de ' + u.nombre + ' en ' + nombreMes(mes),
              onclick: () => editarIngreso(mes, u.id, fila[u.id])
            })
            : null)),
        el('td', { text: completo && primero ? (100 * fila[primero.id] / total).toFixed(1).replace('.', ',') + '%' : '—' }));
    })));
}

function guardarIngreso() {
  const boton = $('boton-ingreso');
  const mes = $('ingreso-mes').value;
  const monto = leerMonto($('ingreso-monto'));
  if (!mes || !monto) {
    avisar('Indica el mes y el monto.', true);
    return;
  }
  intentar(boton, async () => {
    const [anio, numeroMes] = mes.split('-').map(Number);
    await llamar('guardarIngreso', {
      anio: anio, mes: numeroMes, monto: monto, usuario_id: $('ingreso-usuario').value || estado.usuario.id
    });
    $('ingreso-monto').value = '';
    estado.ingresos = null;
    avisar('Ingreso guardado.');
    pintarIngresos();
  });
}

// ---------------------------------------------------------------------------
// Pantalla: configuración de categorías (solo administrador)
// ---------------------------------------------------------------------------

/** Una tabla por tipo; el nombre de la categoría se muestra una vez por grupo. */
function pintarConfig() {
  const verDesactivadas = $('filtro-desactivadas').checked;
  vaciar($('lista-categorias'), ['Familiar', 'Personal'].map((tipo) => {
    const familiar = tipo === 'Familiar';
    const grupos = new Map();
    estado.categorias
      .filter((c) => c.tipo === tipo && (verDesactivadas || c.activa))
      .forEach((c) => {
        if (!grupos.has(c.categoria)) {
          grupos.set(c.categoria, []);
        }
        grupos.get(c.categoria).push(c);
      });

    const filas = [];
    grupos.forEach((lista, nombre) => {
      lista.forEach((c, i) => {
        filas.push(el('tr', { class: (i === 0 ? 'inicio-grupo' : '') + (c.activa ? '' : ' inactiva') },
          el('td', { class: 'celda-categoria', text: i === 0 ? nombre : '' }),
          el('td', { text: c.subcategoria }),
          familiar
            ? el('td', {}, el('span', {
              class: 'criterio criterio-' + c.criterio.replace(/\W/g, ''),
              text: c.criterio + (c.criterio === '100%' ? ' ' + nombreUsuario(c.usuario_100) : '')
            }))
            : null,
          el('td', { text: c.activa ? '🟢 Activa' : '⚪ Desactivada' }),
          el('td', {}, el('button', {
            type: 'button', class: 'enlace', text: '✏️',
            'aria-label': 'Editar ' + nombre + ' / ' + c.subcategoria,
            onclick: () => abrirCategoria(c)
          }))));
      });
    });

    return el('div', { class: 'tarjeta' },
      el('h3', { text: familiar ? '👨‍👩‍👧 Familiares' : '🙋 Personales' }),
      el('div', { class: 'tabla-contenedor' },
        el('table', { class: 'tabla tabla-categorias' },
          el('thead', {}, el('tr', {},
            el('th', { text: 'Categoría' }),
            el('th', { text: 'Subcategoría' }),
            familiar ? el('th', { text: 'Criterio' }) : null,
            el('th', { text: 'Estado' }),
            el('th', { 'aria-label': 'Editar' }))),
          el('tbody', {}, filas))));
  }));
}

/** Formulario para crear (sin categoría) o editar una categoría. */
function abrirCategoria(c) {
  const dialogo = $('dialogo');
  const tipo = el('select', { disabled: !!c },
    el('option', { value: 'Familiar', text: 'Familiar' }),
    el('option', { value: 'Personal', text: 'Personal' }));
  tipo.value = c ? c.tipo : 'Familiar';
  const listaNombres = el('datalist', { id: 'nombres-categoria' });
  const nombre = el('input', { type: 'text', maxlength: '60', list: 'nombres-categoria', value: c ? c.categoria : '' });
  const subcategoria = el('input', { type: 'text', maxlength: '60', value: c ? c.subcategoria : '' });
  const criterio = el('select', {},
    ['Proporcional', '50/50', '100%'].map((v) => el('option', { value: v, text: v })));
  criterio.value = c && c.criterio ? c.criterio : 'Proporcional';
  const usuario100 = el('select', {}, estado.usuarios.map((u) => el('option', { value: u.id, text: u.nombre })));
  if (c && c.usuario_100) {
    usuario100.value = c.usuario_100;
  }
  const orden = el('input', { type: 'number', min: '1', step: '1', value: c ? String(c.orden) : '' });
  const activa = el('input', { type: 'checkbox', checked: c ? c.activa : true });
  const filaCriterio = el('label', {}, 'Criterio de reparto', criterio);
  const filaUsuario = el('label', {}, 'Se asigna el 100% a', usuario100);
  const boton = el('button', { type: 'button', class: 'principal', text: 'Guardar categoría' });

  function actualizar() {
    filaCriterio.hidden = tipo.value !== 'Familiar';
    filaUsuario.hidden = tipo.value !== 'Familiar' || criterio.value !== '100%';
    const nombres = new Set(estado.categorias.filter((x) => x.tipo === tipo.value).map((x) => x.categoria));
    vaciar(listaNombres, Array.from(nombres).map((n) => el('option', { value: n })));
  }
  tipo.addEventListener('change', actualizar);
  criterio.addEventListener('change', actualizar);
  actualizar();

  boton.addEventListener('click', () => intentar(boton, async () => {
    await llamar('guardarCategoria', {
      id: c ? c.id : undefined,
      tipo: tipo.value,
      categoria: nombre.value.trim(),
      subcategoria: subcategoria.value.trim(),
      criterio: tipo.value === 'Familiar' ? criterio.value : '',
      usuario_100: usuario100.value,
      orden: Number(orden.value) || undefined,
      activa: activa.checked
    });
    estado.categorias = await llamar('listarCategorias');
    dialogo.close();
    avisar('Categoría guardada.');
    pintarConfig();
  }));

  vaciar(dialogo,
    el('h3', { text: c ? 'Editar categoría' : 'Nueva categoría' }),
    el('label', {}, 'Tipo', tipo),
    c ? el('p', { class: 'nota', text: 'El tipo no se puede cambiar, para no desordenar los gastos ya guardados.' }) : null,
    el('label', {}, 'Categoría', nombre),
    listaNombres,
    el('label', {}, 'Subcategoría', subcategoria),
    filaCriterio,
    filaUsuario,
    el('label', {}, 'Orden dentro de la categoría (opcional)', orden),
    el('label', { class: 'casilla' }, activa, 'Activa'),
    el('p', { class: 'nota', text: 'Las categorías no se borran: se desactivan, porque el historial las usa.' }),
    el('div', { class: 'acciones' }, boton,
      el('button', { type: 'button', text: 'Cancelar', onclick: () => dialogo.close() })));
  dialogo.showModal();
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function iniciar() {
  document.querySelectorAll('#navegacion button').forEach((b) => {
    b.addEventListener('click', () => mostrarPantalla(b.dataset.pantalla));
  });
  $('boton-salir').addEventListener('click', salir);
  ['filtro-mes', 'filtro-tipo', 'filtro-pago', 'filtro-anulados'].forEach((id) => $(id).addEventListener('change', pintarGastos));
  document.querySelectorAll('.selector-vista button').forEach((b) => {
    b.addEventListener('click', () => {
      estado.vistaGastos = b.dataset.vista;
      pintarGastos();
    });
  });
  campoMonto($('ingreso-monto'));
  $('boton-ingreso').addEventListener('click', guardarIngreso);
  $('boton-nueva-categoria').addEventListener('click', () => abrirCategoria(null));
  $('boton-importar').addEventListener('click', () => $('archivo-cartola').click());
  $('archivo-cartola').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      importarArchivo(e.target.files[0]);
    }
  });
  $('filtro-desactivadas').addEventListener('change', pintarConfig);

  if (window.google && google.accounts && google.accounts.id) {
    iniciarGoogle();
  } else {
    window.onGoogleLibraryLoad = iniciarGoogle;
  }
}

iniciar();
