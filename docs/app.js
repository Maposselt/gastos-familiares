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

const CLIENT_ID = '1065565340039-h85i836u1mip2j9ohjtfcmc3njhgt5u6.apps.googleusercontent.com';
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
  pantalla: 'nuevo'
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

  const fecha = el('input', { type: 'date', value: inicial.fecha || hoyIso(), max: '2100-12-31' });
  const monto = campoMonto(el('input', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: '0',
    value: inicial.monto ? Number(inicial.monto).toLocaleString('es-CL') : ''
  }));
  const descripcion = el('input', { type: 'text', maxlength: '200', autocomplete: 'off', value: inicial.descripcion || '' });
  const botonFamiliar = el('button', { type: 'button', 'aria-pressed': 'false', text: '👨‍👩‍👧 Familiar' });
  const botonPersonal = el('button', { type: 'button', 'aria-pressed': 'false', text: '🙋 Personal' });
  const categoria = el('select', { disabled: true });
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
    return etiquetaCategoria(o.categoria_id) + ' (' + o.veces + ' de ' + sugerencia.total +
      (sugerencia.total === 1 ? ' vez' : ' veces') + (sugerencia.exacta ? '' : ', glosa parecida') + ')';
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
  if (opciones.idMovimiento) {
    buscarSugerencia({ id: opciones.idMovimiento });
  }

  boton.addEventListener('click', () => {
    error.textContent = '';
    const datos = {
      fecha: fecha.value,
      monto: leerMonto(monto),
      descripcion: descripcion.value.trim(),
      tipo: tipo,
      categoria_id: categoria.value,
      rendir_trabajo: tipo === 'Personal' && rendir.checked
    };
    const faltante = !datos.fecha ? 'Falta la fecha.'
      : !datos.monto ? 'Falta el monto.'
        : !datos.descripcion ? 'Falta la descripción.'
          : !datos.tipo ? 'Elige si el gasto es Familiar o Personal.'
            : !datos.categoria_id ? 'Elige una categoría.' : '';
    if (faltante) {
      error.textContent = faltante;
      return;
    }
    intentar(boton, () => opciones.alGuardar(datos));
  });

  return el('div', { class: 'tarjeta' },
    el('label', {}, 'Fecha', fecha),
    el('label', {}, 'Monto', monto),
    el('label', {}, 'Descripción', descripcion),
    pistaSugerencia,
    el('div', { class: 'etiqueta-campo', text: 'Tipo' }),
    opciones.sugerenciaTipo ? el('p', { class: 'nota', text: 'Según tu marca antigua: ' + opciones.sugerenciaTipo + '. Confírmalo eligiéndolo.' }) : null,
    el('div', { class: 'selector-tipo' }, botonFamiliar, botonPersonal),
    el('label', {}, 'Categoría', categoria),
    pistaCategoria,
    filaRendir,
    error,
    el('div', { class: 'acciones' }, boton, opciones.botonesExtra || []));
}

// ---------------------------------------------------------------------------
// Pantalla: nuevo gasto
// ---------------------------------------------------------------------------

function pintarNuevo(fechaAnterior) {
  vaciar($('contenedor-nuevo'), formularioGasto({
    inicial: { fecha: fechaAnterior },
    textoBoton: 'Guardar gasto',
    alGuardar: (datos) => guardarNuevo(datos, false)
  }));
}

async function guardarNuevo(datos, confirmarDuplicado) {
  const r = await llamar('guardarMovimiento', Object.assign({}, datos, {
    origen: 'manual', confirmarDuplicado: confirmarDuplicado
  }));
  if (r.guardado) {
    estado.movimientos = null;
    avisar('Gasto guardado.');
    pintarNuevo(datos.fecha);
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
  botonGuardar.addEventListener('click', async () => {
    await intentar(botonGuardar, acciones.guardarIgual);
    dialogo.close();
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
    vaciar(lista, el('li', { class: 'cargando', text: 'Cargando gastos…' }));
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
      el('p', { class: 'nota', text: 'Elige el tipo y la categoría de cada uno.' }),
      el('ul', { class: 'lista' }, propiosPorRevisar.map(itemGasto)))
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

  const visibles = delMes
    .filter((m) => (!tipo || m.tipo === tipo) && (verAnulados || m.estado !== 'Anulado'))
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
  vaciar(lista, visibles.length
    ? visibles.map(itemGasto)
    : el('li', { class: 'nota', text: 'No hay gastos en ' + nombreMes(mes) + '.' }));
}

function tarjetaTotal(titulo, monto) {
  return el('div', { class: 'total' }, el('span', { text: titulo }), el('strong', { text: pesos(monto) }));
}

function itemGasto(m) {
  const propio = m.usuario_id === estado.usuario.id;
  const meta = [fechaVisible(m.fecha), m.categoria_id ? etiquetaCategoria(m.categoria_id) : 'Sin categoría'];
  if (m.tipo === 'Familiar') {
    meta.push('pagó ' + nombreUsuario(m.usuario_id));
  }
  const contenido = [
    el('div', { class: 'gasto-detalle' },
      el('div', { class: 'gasto-descripcion', text: m.descripcion }),
      el('div', { class: 'gasto-meta', text: meta.join(' · ') }),
      el('div', {},
        m.tipo ? el('span', { class: 'etiqueta ' + m.tipo.toLowerCase(), text: m.tipo }) : null,
        m.estado !== 'Confirmado' ? el('span', { class: 'etiqueta', text: m.estado }) : null,
        m.rendir_trabajo ? el('span', { class: 'etiqueta', text: 'Rendir' }) : null)),
    el('div', { class: 'gasto-monto', text: pesos(m.monto) })
  ];
  const clases = 'gasto' + (m.tipo === 'Familiar' ? ' familiar' : '') + (m.estado === 'Anulado' ? ' anulado' : '');
  return el('li', {}, propio
    ? el('button', { type: 'button', class: clases, 'aria-label': 'Editar ' + m.descripcion, onclick: () => abrirEdicion(m) }, contenido)
    : el('div', { class: clases }, contenido));
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
        await llamar('actualizarMovimiento', Object.assign({ id: m.id }, datos));
        terminarEdicion(anulado ? 'Gasto restaurado.' : 'Cambios guardados.');
      }
    }));
  dialogo.showModal();
}

function terminarEdicion(mensaje) {
  $('dialogo').close();
  estado.movimientos = null;
  avisar(mensaje);
  pintarGastos();
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
    el('label', {}, 'Orden (opcional)', orden),
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
  ['filtro-mes', 'filtro-tipo', 'filtro-anulados'].forEach((id) => $(id).addEventListener('change', pintarGastos));
  campoMonto($('ingreso-monto'));
  $('boton-ingreso').addEventListener('click', guardarIngreso);
  $('boton-nueva-categoria').addEventListener('click', () => abrirCategoria(null));
  $('filtro-desactivadas').addEventListener('change', pintarConfig);

  if (window.google && google.accounts && google.accounts.id) {
    iniciarGoogle();
  } else {
    window.onGoogleLibraryLoad = iniciarGoogle;
  }
}

iniciar();
