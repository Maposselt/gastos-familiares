/**
 * Arma datos/dashboard.html a partir de datos/resumen.csv (la pestaña
 * "Resumen" de la planilla, exportada como CSV).
 *
 * Uso:  node herramientas/armar-dashboard.js [entrada.csv] [salida.html]
 *
 * No usa librerías ni internet: los gráficos se dibujan como SVG.
 * La carpeta datos/ no se sube a GitHub (ver .gitignore).
 */
const fs = require('fs');
const path = require('path');

const CARPETA = path.join(__dirname, '..', 'datos');
// Opcional: otra entrada y salida (sirve para probar con datos inventados).
const ENTRADA = process.argv[2] || path.join(CARPETA, 'resumen.csv');
const SALIDA = process.argv[3] || path.join(CARPETA, 'dashboard.html');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// ---------------------------------------------------------------------------
// Lectura del CSV
// ---------------------------------------------------------------------------

function leerCsv(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') {
        entreComillas = false;
      } else {
        campo += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') {
        i++;
      }
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += c;
    }
  }
  if (campo || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  return filas;
}

/** Número del CSV: "12345", "12345.5" o "12.345" (miles con punto). */
function numero(texto) {
  const limpio = String(texto || '').trim();
  if (/^-?\d{1,3}(\.\d{3})+$/.test(limpio)) {
    return Number(limpio.replace(/\./g, ''));
  }
  return Number(limpio.replace(',', '.')) || 0;
}

function leerResumen() {
  if (!fs.existsSync(ENTRADA)) {
    throw new Error('Falta ' + ENTRADA);
  }
  const filas = leerCsv(fs.readFileSync(ENTRADA, 'utf8').replace(/^﻿/, ''));
  const encabezado = filas[0].map((t) => t.trim());
  const col = (nombre, desde) => encabezado.indexOf(nombre, desde || 0);
  const iAnio = col('anio');
  const iCat = col('id');
  const iControl = col('total_control');
  if (iAnio < 0 || iCat < 0) {
    throw new Error('El CSV no tiene el formato de la pestaña Resumen.');
  }

  const categorias = {};
  const gastos = [];
  filas.slice(1).forEach((f) => {
    if (f[iCat]) {
      categorias[f[iCat]] = { tipo: f[iCat + 1], categoria: f[iCat + 2], subcategoria: f[iCat + 3] };
    }
    if (f[iAnio] && f[iAnio + 4] !== '') {
      gastos.push({
        mes: f[iAnio] + '-' + String(numero(f[iAnio + 1])).padStart(2, '0'),
        tipo: f[iAnio + 2],
        categoria_id: f[iAnio + 3],
        total: numero(f[iAnio + 4]),
        cantidad: numero(f[iAnio + 5])
      });
    }
  });
  const control = iControl >= 0 && filas[1] ? numero(filas[1][iControl]) : null;
  return { categorias, gastos, control };
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pesos(n) {
  return (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('es-CL');
}

/** $1,2 M / $350 mil, para ejes y etiquetas cortas. */
function pesosCorto(n) {
  if (Math.abs(n) >= 1e6) {
    return '$' + (n / 1e6).toLocaleString('es-CL', { maximumFractionDigits: 1 }) + ' M';
  }
  if (Math.abs(n) >= 1e3) {
    return '$' + Math.round(n / 1e3).toLocaleString('es-CL') + ' mil';
  }
  return pesos(n);
}

function nombreMes(clave, conAnio) {
  const [a, m] = clave.split('-').map(Number);
  return MESES[m - 1] + (conAnio ? ' ' + String(a).slice(2) : '');
}

function mesesEntre(desde, hasta) {
  const lista = [];
  let [a, m] = desde.split('-').map(Number);
  const fin = hasta;
  while (true) {
    const clave = a + '-' + String(m).padStart(2, '0');
    if (clave > fin) {
      break;
    }
    lista.push(clave);
    m++;
    if (m > 12) {
      m = 1;
      a++;
    }
  }
  return lista;
}

function hoyMes() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

const suma = (lista) => lista.reduce((s, x) => s + x, 0);
const promedio = (lista) => (lista.length ? suma(lista) / lista.length : 0);

// ---------------------------------------------------------------------------
// Gráficos SVG
// ---------------------------------------------------------------------------

/** Barras apiladas Familiar + Personal por mes. */
function graficoBarras(meses, familiar, personal, mesEnCurso) {
  const ancho = 720;
  const alto = 260;
  const margen = { izq: 64, der: 12, arr: 16, abj: 34 };
  const maximo = Math.max(1, ...meses.map((m) => familiar[m] + personal[m]));
  const paso = (ancho - margen.izq - margen.der) / meses.length;
  const barra = Math.min(38, paso * 0.65);
  const y = (v) => alto - margen.abj - (v / maximo) * (alto - margen.arr - margen.abj);
  const lineas = [0, 0.25, 0.5, 0.75, 1].map((p) => {
    const v = maximo * p;
    return `<line x1="${margen.izq}" x2="${ancho - margen.der}" y1="${y(v)}" y2="${y(v)}" class="eje"/>` +
      `<text x="${margen.izq - 8}" y="${y(v) + 4}" class="etiqueta" text-anchor="end">${pesosCorto(v)}</text>`;
  }).join('');
  const barras = meses.map((m, i) => {
    const x = margen.izq + paso * i + (paso - barra) / 2;
    const f = familiar[m];
    const p = personal[m];
    const clase = m === mesEnCurso ? ' en-curso' : '';
    return `<g><title>${nombreMes(m, true)}: familiar ${pesos(f)} · personal ${pesos(p)}</title>` +
      `<rect x="${x}" y="${y(f)}" width="${barra}" height="${Math.max(0, y(0) - y(f))}" class="b-familiar${clase}" rx="2"/>` +
      `<rect x="${x}" y="${y(f + p)}" width="${barra}" height="${Math.max(0, y(f) - y(f + p))}" class="b-personal${clase}" rx="2"/>` +
      `<text x="${x + barra / 2}" y="${alto - margen.abj + 16}" class="etiqueta" text-anchor="middle">${nombreMes(m)}</text></g>`;
  }).join('');
  return `<svg viewBox="0 0 ${ancho} ${alto}" class="grafico" role="img" aria-label="Gastos por mes">${lineas}${barras}</svg>`;
}

/** Línea pequeña de la evolución de una categoría. */
function minigrafico(valores) {
  const ancho = 140;
  const alto = 34;
  const maximo = Math.max(1, ...valores);
  const x = (i) => 2 + (i / Math.max(1, valores.length - 1)) * (ancho - 4);
  const y = (v) => alto - 3 - (v / maximo) * (alto - 6);
  const puntos = valores.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ultimo = valores.length - 1;
  return `<svg viewBox="0 0 ${ancho} ${alto}" class="mini" aria-hidden="true">` +
    `<polyline points="${puntos}" class="linea"/>` +
    `<circle cx="${x(ultimo)}" cy="${y(valores[ultimo])}" r="2.5" class="punto"/></svg>`;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

function armar() {
  const { categorias, gastos, control } = leerResumen();
  if (!gastos.length) {
    throw new Error('El resumen no tiene gastos.');
  }
  const totalLeido = suma(gastos.map((g) => g.total));
  if (control !== null && Math.round(control) !== Math.round(totalLeido)) {
    throw new Error('El total no calza con el de control (' + pesos(totalLeido) + ' vs ' + pesos(control) + '). Revisa resumen.csv.');
  }

  const mesActual = hoyMes();
  const clavesMes = gastos.map((g) => g.mes).sort();
  const meses = mesesEntre(clavesMes[0], clavesMes[clavesMes.length - 1] > mesActual ? clavesMes[clavesMes.length - 1] : mesActual).slice(-13);
  const mesEnCurso = meses.includes(mesActual) ? mesActual : null;
  const completos = meses.filter((m) => m !== mesEnCurso);
  const ultimoCompleto = completos[completos.length - 1];
  const anteriores = completos.slice(0, -1);

  const infoCat = (id) => categorias[id] || { tipo: '', categoria: 'Sin categoría', subcategoria: id };
  const totalPor = (filtro) => {
    const r = {};
    meses.forEach((m) => { r[m] = 0; });
    gastos.filter(filtro).forEach((g) => { if (r[g.mes] !== undefined) r[g.mes] += g.total; });
    return r;
  };
  const familiar = totalPor((g) => g.tipo === 'Familiar');
  const personal = totalPor((g) => g.tipo === 'Personal');

  // Tarjetas de arriba.
  const promFamiliar = promedio(anteriores.map((m) => familiar[m]));
  const variacion = (actual, base) => (base ? Math.round((actual / base - 1) * 100) : null);
  const textoVariacion = (v) => (v === null ? '' : `<span class="${v > 0 ? 'sube' : 'baja'}">${v > 0 ? '+' : ''}${v}% vs. promedio</span>`);
  const tarjetas = [
    ['Familiar · ' + nombreMes(ultimoCompleto, true), pesos(familiar[ultimoCompleto]), textoVariacion(variacion(familiar[ultimoCompleto], promFamiliar))],
    ['Familiar · promedio mensual', pesos(promFamiliar), escapar(anteriores.length + ' meses anteriores')],
    ['Mis personales · ' + nombreMes(ultimoCompleto, true), pesos(personal[ultimoCompleto]),
      textoVariacion(variacion(personal[ultimoCompleto], promedio(anteriores.map((m) => personal[m]))))],
    mesEnCurso ? ['En curso · ' + nombreMes(mesEnCurso, true), pesos(familiar[mesEnCurso] + personal[mesEnCurso]), 'familiar + personal, mes incompleto'] : null
  ].filter(Boolean).map(([t, v, n]) => `<div class="tarjeta"><span>${escapar(t)}</span><strong>${v}</strong><small>${n}</small></div>`).join('');

  // Totales por mes de cada categoría (o de cada "categoría / subcategoría"), para un tipo.
  function agrupar(tipo, nombreDe) {
    const mapa = new Map();
    gastos.filter((g) => g.tipo === tipo).forEach((g) => {
      const nombre = nombreDe(infoCat(g.categoria_id));
      if (!mapa.has(nombre)) {
        mapa.set(nombre, Object.fromEntries(meses.map((m) => [m, 0])));
      }
      if (mapa.get(nombre)[g.mes] !== undefined) {
        mapa.get(nombre)[g.mes] += g.total;
      }
    });
    return Array.from(mapa.entries())
      .map(([nombre, valores]) => ({ nombre, valores, total: suma(meses.map((m) => valores[m])) }))
      .sort((a, b) => b.total - a.total);
  }
  const porCategoria = (tipo) => agrupar(tipo, (c) => c.categoria);
  const separador = ' / ';
  const porSubcategoria = (tipo) => agrupar(tipo, (c) => c.categoria + separador + c.subcategoria);

  /** Tabla mes × categoría con sus subcategorías debajo; el color más intenso es donde más se gastó. */
  function tablaCalor(tipo) {
    const filas = porCategoria(tipo);
    if (!filas.length) {
      return '<p class="nota">Sin gastos.</p>';
    }
    const subcategorias = porSubcategoria(tipo);
    const maximo = Math.max(1, ...filas.flatMap((f) => meses.map((m) => f.valores[m])));
    const celda = (v) => {
      const intensidad = v ? 0.08 + 0.62 * (v / maximo) : 0;
      return `<td style="--i:${intensidad.toFixed(2)}" title="${pesos(v)}">${v ? pesosCorto(v) : '·'}</td>`;
    };
    const fila = (f, nombre, clase) => `<tr class="${clase}"><th>${escapar(nombre)}</th>${meses.map((m) => celda(f.valores[m])).join('')}<td class="total">${pesosCorto(f.total)}</td></tr>`;
    const totalesMes = meses.map((m) => suma(filas.map((f) => f.valores[m])));
    return `<div class="tabla-scroll"><table class="calor"><thead><tr><th>Categoría</th>` +
      meses.map((m) => `<th class="${m === mesEnCurso ? 'en-curso' : ''}">${nombreMes(m, true)}</th>`).join('') +
      `<th>Total</th></tr></thead><tbody>` +
      filas.map((f) => {
        const subs = subcategorias.filter((s) => s.nombre.startsWith(f.nombre + separador));
        // Si la categoría tiene una sola subcategoría, basta con su fila.
        return fila(f, f.nombre, 'categoria') + (subs.length > 1
          ? subs.map((s) => fila(s, s.nombre.slice(f.nombre.length + separador.length), 'sub')).join('') : '');
      }).join('') +
      `</tbody><tfoot><tr><th>Total</th>${totalesMes.map((v) => `<td>${pesosCorto(v)}</td>`).join('')}<td class="total">${pesosCorto(suma(totalesMes))}</td></tr></tfoot></table></div>`;
  }

  // Por subcategoría: así un alza en "Supermercado" no se esconde dentro de "Casa".
  function evolucion(tipo) {
    return porSubcategoria(tipo).map((f) => {
      const serie = completos.map((m) => f.valores[m]);
      const base = promedio(anteriores.map((m) => f.valores[m]));
      const v = variacion(f.valores[ultimoCompleto], base);
      const alerta = v !== null && Math.abs(v) >= 25 && base > 0;
      return `<div class="evolucion${alerta ? ' alerta' : ''}"><div><strong>${escapar(f.nombre)}</strong>` +
        `<small>${nombreMes(ultimoCompleto)}: ${pesos(f.valores[ultimoCompleto])} · promedio ${pesos(base)}</small></div>` +
        `${minigrafico(serie)}<span class="variacion ${v > 0 ? 'sube' : 'baja'}">${v === null ? '—' : (v > 0 ? '+' : '') + v + '%'}</span></div>`;
    }).join('');
  }

  // Subcategorías que más gastaron en los últimos 3 meses completos.
  const ultimos3 = completos.slice(-3);
  const porSub = new Map();
  gastos.filter((g) => ultimos3.includes(g.mes)).forEach((g) => {
    const c = infoCat(g.categoria_id);
    const clave = g.tipo + ' · ' + c.categoria + ' / ' + c.subcategoria;
    porSub.set(clave, (porSub.get(clave) || 0) + g.total);
  });
  const top = Array.from(porSub.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxTop = Math.max(1, ...top.map((t) => t[1]));
  const tablaTop = top.map(([nombre, total]) =>
    `<tr><th>${escapar(nombre)}</th><td class="barra-celda"><span style="width:${(100 * total / maxTop).toFixed(1)}%"></span></td><td>${pesos(total)}</td><td>${pesos(total / ultimos3.length)}/mes</td></tr>`).join('');

  const generado = new Date().toLocaleString('es-CL', { dateStyle: 'long', timeStyle: 'short' });
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Dashboard de gastos</title>
<style>
:root { --fondo:#f5f6f8; --superficie:#fff; --texto:#1d2330; --suave:#5d6677; --borde:#d8dce4;
  --familiar:#2f5bd3; --personal:#2f9e6b; --sube:#b3261e; --baja:#1f7a4d; --calor:47,91,211; }
@media (prefers-color-scheme: dark) { :root { --fondo:#14171d; --superficie:#1e232b; --texto:#e7eaf0; --suave:#a3abba;
  --borde:#353c48; --familiar:#7b9cff; --personal:#6fcf97; --sube:#ff8a80; --baja:#6fcf97; --calor:123,156,255; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--fondo); color:var(--texto); font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:1000px; margin:0 auto; padding:20px 16px 40px; }
h1 { margin:0 0 4px; font-size:1.5rem; } h2 { margin:28px 0 10px; font-size:1.15rem; }
.nota { color:var(--suave); font-size:.85rem; margin:0 0 12px; }
.tarjetas { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; }
.tarjeta, .bloque { background:var(--superficie); border:1px solid var(--borde); border-radius:10px; padding:12px 14px; }
.tarjeta span, .tarjeta small { display:block; color:var(--suave); font-size:.82rem; }
.tarjeta strong { display:block; font-size:1.35rem; margin:2px 0; }
.sube { color:var(--sube); } .baja { color:var(--baja); }
.grafico { width:100%; height:auto; } .eje { stroke:var(--borde); } .etiqueta { fill:var(--suave); font-size:11px; }
.b-familiar { fill:var(--familiar); } .b-personal { fill:var(--personal); } .en-curso { opacity:.45; }
.leyenda { display:flex; gap:16px; font-size:.85rem; color:var(--suave); margin-top:4px; }
.leyenda i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
.tabla-scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.85rem; }
th, td { padding:6px 8px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--borde); }
th:first-child { text-align:left; position:sticky; left:0; background:var(--superficie); }
thead th { color:var(--suave); font-weight:600; }
.calor td { background:rgba(var(--calor),var(--i,0)); } .calor td.total, tfoot td { font-weight:600; background:none; }
.calor tr.categoria th { font-weight:700; } .calor tr.sub th { font-weight:400; padding-left:22px; color:var(--suave); }
.evoluciones { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:8px; }
.evolucion { display:grid; grid-template-columns:1fr 140px 56px; gap:10px; align-items:center; background:var(--superficie);
  border:1px solid var(--borde); border-radius:10px; padding:8px 12px; }
.evolucion.alerta { border-color:var(--sube); }
.evolucion small { display:block; color:var(--suave); font-size:.78rem; }
.mini { width:140px; height:34px; } .linea { fill:none; stroke:var(--familiar); stroke-width:2; } .punto { fill:var(--familiar); }
.variacion { text-align:right; font-weight:600; }
.barra-celda { width:40%; } .barra-celda span { display:block; height:10px; border-radius:5px; background:var(--familiar); }
</style>
</head>
<body>
<main>
<h1>Dashboard de gastos</h1>
<p class="nota">Gastos confirmados: familiares y mis personales (los personales de otras personas no se incluyen). Actualizado el ${escapar(generado)}</p>
<div class="tarjetas">${tarjetas}</div>

<h2>Gastos por mes</h2>
<div class="bloque">${graficoBarras(meses, familiar, personal, mesEnCurso)}
<div class="leyenda"><span><i style="background:var(--familiar)"></i>Familiar</span><span><i style="background:var(--personal)"></i>Mis personales</span>${mesEnCurso ? '<span>Barra clara: mes en curso</span>' : ''}</div></div>

<h2>Evolución por subcategoría · familiares</h2>
<p class="nota">${nombreMes(ultimoCompleto, true)} comparado con el promedio de los meses anteriores. Con borde rojo: variación de 25% o más.</p>
<div class="evoluciones">${evolucion('Familiar')}</div>

<h2>Evolución por subcategoría · mis personales</h2>
<div class="evoluciones">${evolucion('Personal')}</div>

<h2>Mes a mes · familiares</h2>
<div class="bloque">${tablaCalor('Familiar')}</div>

<h2>Mes a mes · mis personales</h2>
<div class="bloque">${tablaCalor('Personal')}</div>

<h2>Subcategorías con más gasto</h2>
<p class="nota">Últimos 3 meses completos (${ultimos3.map((m) => nombreMes(m, true)).join(', ')}).</p>
<div class="bloque tabla-scroll"><table>${tablaTop}</table></div>
</main>
</body>
</html>
`;
  fs.writeFileSync(SALIDA, html, 'utf8');
  console.log('Dashboard listo: ' + SALIDA);
  console.log('Total leído: ' + pesos(totalLeido) + (control !== null ? ' (calza con el de control)' : ''));
}

try {
  armar();
} catch (error) {
  console.error('No pude armar el dashboard: ' + error.message);
  process.exitCode = 1;
}
