let DATA = null;

// ---------------------------------------------------------------------------
// Estado del panel "what-if". Todo lo que el usuario puede mover vive aqui.
// ---------------------------------------------------------------------------
const state = {
  factor: 1.0,          // factor sobre Q* teorico (1.0 = EOQ puro; ya cumple el objetivo, ver Fase 4)
  nivel: 0.95,           // nivel de servicio objetivo (para R)
  demandaSlider: 1.0,    // ajuste manual de demanda global (0.7x - 1.5x)
  estacion: 'normal',    // normal | festivo | temporada_alta | temporada_baja
  mermaPct: 0.08,        // configurador de merma predictiva (reemplaza el default)
  impuestoPct: 0.08,     // impuesto al consumo (INC, restaurante independiente). Franquicia -> 19% IVA
  comisionDomicilioPct: 0.25, // comision plataforma de domicilios (supuesto, sin cifra oficial unica)
  menuActivos: {},        // producto -> bool
  menuPrecios: {},        // producto -> precio actual (editable)
};
// temporada_alta=1.44 (no 1.15): el propio hallazgo de Fase 5 mide que
// diciembre es 12.0% de la venta anual real de Bachue contra 8.33% de un
// mes promedio (12.0/8.33 = +44%) -- el multiplicador de este slider estaba
// muy por debajo de lo que los datos del proyecto ya habian encontrado.
const ESTACION_MULT = { normal: 1.0, festivo: 1.25, temporada_alta: 1.44, temporada_baja: 0.85 };
const ESTACION_LABEL = { normal: 'Normal', festivo: 'Puente / festivo', temporada_alta: 'Temporada alta (dic.)', temporada_baja: 'Temporada baja' };

let scenarios = { A: null, B: null };
let ultimo = null; // ultimo resultado computado (para exportar/guardar escenario)

// ---------------------------------------------------------------------------
// Matematica: percentil, mezcla de lead time, muestreo "caso de la leche"
// ---------------------------------------------------------------------------
function percentile(arr, q){
  const s = [...arr].sort((a,b)=>a-b);
  const idx = q*(s.length-1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo===hi) return s[lo];
  return s[lo] + (s[hi]-s[lo])*(idx-lo);
}
function fmtCOP(n){ return '$' + Math.round(n).toLocaleString('es-CO'); }
function fmtCOPCompact(n){
  const sign = n<0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e9) return sign+'$'+(abs/1e9).toFixed(1)+'MM';
  if (abs >= 1e6) return sign+'$'+(abs/1e6).toFixed(1)+'M';
  if (abs >= 1e3) return sign+'$'+(abs/1e3).toFixed(0)+'K';
  return sign+fmtCOP(abs);
}
function fmtPct(n, d){ return (n*100).toFixed(d===undefined?1:d) + '%'; }

const REDUCE_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateNumber(el, to, formatter, duration){
  if (!el) return;
  const from = parseFloat(el.dataset.raw);
  el.dataset.raw = to;
  if (REDUCE_MOTION || isNaN(from) || from === to){ el.textContent = formatter(to); return; }
  const start = performance.now();
  const d = duration || 650;
  function tick(now){
    const t = Math.min(1, (now-start)/d);
    const eased = 1 - Math.pow(1-t, 3);
    el.textContent = formatter(from + (to-from)*eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function showToast(msg){
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(()=>{ t.classList.add('out'); setTimeout(()=> t.remove(), 260); }, 2600);
}

function updateSliderFill(el){
  if (!el) return;
  const min = parseFloat(el.min), max = parseFloat(el.max), val = parseFloat(el.value);
  const pct = max>min ? ((val-min)/(max-min))*100 : 0;
  el.style.setProperty('--fill', pct+'%');
}

function demandaEfectiva(){
  const menuFactor = menuFactorActivo();
  return state.demandaSlider * ESTACION_MULT[state.estacion] * menuFactor;
}
function menuFactorActivo(){
  const total = DATA.menu.length;
  const activos = DATA.menu.filter(m => state.menuActivos[m.producto]).length;
  if (!activos) return 1; // ningun plato activo -> no reducir la demanda a 0 (ver precioFactorActivo)
  return total ? activos/total : 1;
}
function precioFactorActivo(){
  const activos = DATA.menu.filter(m => state.menuActivos[m.producto]);
  if (!activos.length) return 1;
  const origAvg = activos.reduce((s,m)=>s+m.precio_cop,0)/activos.length;
  const curAvg = activos.reduce((s,m)=>s+(state.menuPrecios[m.producto] ?? m.precio_cop),0)/activos.length;
  return origAvg ? curAvg/origAvg : 1;
}
function hActual(){
  return state.mermaPct + DATA.parametros.almacenamiento_pct + DATA.parametros.oportunidad_capital_pct;
}

function computeRMixto(nivelServicio, mult){
  const p = DATA.parametros.prob_lead_time_largo;
  const repsBase = Math.round((1-p)/p);
  const out = {};
  DATA.dias.forEach(dia=>{
    const arrs = DATA.lt_arrays[dia];
    let pooled = [];
    for (let i=0;i<repsBase;i++) pooled = pooled.concat(arrs.base);
    pooled = pooled.concat(arrs.largo);
    out[dia] = percentile(pooled, nivelServicio) * mult;
  });
  return out;
}
function muestrear(tabla){
  const u = Math.random();
  let fila = tabla[tabla.length-1];
  for (const f of tabla){ if (f.frec_acum >= u){ fila = f; break; } }
  return fila.limite_inf + Math.random()*(fila.limite_sup - fila.limite_inf);
}

// ---------------------------------------------------------------------------
// Motor de simulacion Monte Carlo (mismo metodo que el analisis oficial en
// Python; aqui con los multiplicadores what-if aplicados a demanda y R).
// ---------------------------------------------------------------------------
function simular(q, rPorDia, mult, nReplicasOverride){
  const P = DATA.parametros;
  const N_REPLICAS = nReplicasOverride || 600, N_DIAS = 365, BURN_IN = 30;
  const resultados = [];
  let traza = null;
  const quiebrePorDiaCount = {}, quiebrePorDiaTotal = {};
  DATA.dias.forEach(d=>{ quiebrePorDiaCount[d]=0; quiebrePorDiaTotal[d]=0; });

  for (let rep=0; rep<N_REPLICAS; rep++){
    let inventario = q;
    let enTransito = [];
    let demandaTotal=0, servidaTotal=0, diasQuiebre=0, costoOrdenar=0, costoMantener=0, nPedidos=0;
    const guardarTraza = rep===0;
    const traceLocal = guardarTraza ? [] : null;

    for (let d=0; d<N_DIAS; d++){
      const dia = DATA.dias[d%7];

      const llegan = enTransito.filter(p=>p.dias===0);
      llegan.forEach(p=> inventario += p.cantidad);
      enTransito = enTransito.filter(p=>p.dias>0).map(p=>({dias:p.dias-1, cantidad:p.cantidad}));

      const inventarioInicio = inventario;
      const posicion = inventario + enTransito.reduce((s,p)=>s+p.cantidad,0);
      let pedidoColocado = false, pedidoLeadTime = null;
      if (posicion <= rPorDia[dia]){
        const lt = Math.random() < P.prob_lead_time_largo ? P.lead_time_largo : P.lead_time_base;
        // lt-1: el descuento de dias de arriba ya corrio para hoy, asi que
        // un pedido con lead time nominal lt debe quedar con lt-1 dias
        // restantes para llegar exactamente en lt dias (antes decia "lt",
        // lo que hacia que tardara lt+1 dias reales en llegar).
        enTransito.push({dias: lt - 1, cantidad: q});
        nPedidos++;
        pedidoColocado = true; pedidoLeadTime = lt;
        if (d>=BURN_IN) costoOrdenar += P.s_ordenar;
      }

      const demanda = muestrear(DATA.tablas_muestreo[dia]) * mult;
      const servido = Math.min(inventario, demanda);
      const quiebre = Math.max(0, demanda - inventario);
      inventario = Math.max(0, inventario - demanda);
      const costoMantenerDia = inventario * (hActual()/7);

      if (d>=BURN_IN){
        demandaTotal += demanda; servidaTotal += servido;
        quiebrePorDiaTotal[dia]++;
        if (quiebre>0){ diasQuiebre++; quiebrePorDiaCount[dia]++; }
        costoMantener += costoMantenerDia;
      }
      if (guardarTraza) traceLocal.push({
        dia:d, diaSemana: dia, inventario, inventarioInicio, posicion, demanda, servido,
        quiebre: quiebre>0, quiebreMonto: quiebre, R: rPorDia[dia], Q: q,
        pedidoColocado, pedidoLeadTime,
      });
    }

    const diasMedidos = N_DIAS - BURN_IN;
    resultados.push({
      nivelServicio: demandaTotal>0 ? servidaTotal/demandaTotal : NaN,
      pctQuiebre: diasQuiebre/diasMedidos,
      costoMantener, costoOrdenar, costoTotal: costoMantener+costoOrdenar,
      pedidosSemana: nPedidos/(N_DIAS/7),
    });
    if (guardarTraza) traza = traceLocal;
  }

  const mean = (k)=> resultados.reduce((s,r)=>s+r[k],0)/resultados.length;
  const quiebrePorDiaPct = {};
  DATA.dias.forEach(d=> quiebrePorDiaPct[d] = quiebrePorDiaTotal[d] ? quiebrePorDiaCount[d]/quiebrePorDiaTotal[d] : 0);

  const serviciosOrdenados = resultados.map(r=>r.nivelServicio).sort((a,b)=>a-b);
  const sdServicio = Math.sqrt(serviciosOrdenados.reduce((s,v)=>s+(v-mean('nivelServicio'))**2,0)/serviciosOrdenados.length);
  const errorEstandar = sdServicio / Math.sqrt(N_REPLICAS);
  const convergencia = {
    replicas: N_REPLICAS,
    media: mean('nivelServicio'),
    desvEst: sdServicio,
    errorEstandar,
    ic95Inf: mean('nivelServicio') - 1.96*errorEstandar,
    ic95Sup: mean('nivelServicio') + 1.96*errorEstandar,
    p5: percentile(serviciosOrdenados, 0.05),
    p95: percentile(serviciosOrdenados, 0.95),
  };

  return {
    nivelServicio: mean('nivelServicio'),          // tasa de llenado ($ servido / $ demandado)
    nivelServicioCiclo: 1 - mean('pctQuiebre'),     // 1 - % dias con algun quiebre (metrica distinta)
    pctQuiebre: mean('pctQuiebre'),
    costoTotalSemanal: mean('costoTotal')/ (365/7),
    costoMantenerSemanal: mean('costoMantener')/ (365/7),
    costoOrdenarSemanal: mean('costoOrdenar')/ (365/7),
    pedidosSemana: mean('pedidosSemana'),
    quiebrePorDiaPct,
    convergencia,
    traza, q, rPorDia, mult,
  };
}

function promedioCanalDelivery(){
  const meses = Object.values(DATA.canal_mensual);
  return meses.reduce((s,m)=>s+m.delivery,0) / meses.length;
}

function ejecutarSimulacion(){
  const mult = demandaEfectiva();
  const q = DATA.parametros.q_teorico * Math.sqrt(mult) * state.factor;
  const rPorDia = computeRMixto(state.nivel, mult);
  const res = simular(q, rPorDia, mult);

  const ventaProteinaSemanalBase = DATA.parametros.demanda_semanal_proteina / DATA.parametros.food_cost_pct;
  const precioFactor = precioFactorActivo();
  // ventaTeorica: toda la demanda que llego, a precio de lista.
  // ventaReal: lo que de verdad se factura -> se resta lo que no se pudo vender por quiebre.
  const ventaTeorica = ventaProteinaSemanalBase * mult * precioFactor;
  const ventaReal = ventaTeorica * res.nivelServicio;
  const ventaPerdidaQuiebre = ventaTeorica - ventaReal;

  const costoMateriaPrima = ventaReal * DATA.parametros.food_cost_pct;
  const margen = ventaReal - costoMateriaPrima - res.costoTotalSemanal;

  res.ventaSimulada = ventaReal;
  res.ventaTeorica = ventaTeorica;
  res.ventaPerdidaQuiebre = ventaPerdidaQuiebre;
  res.margen = margen;
  res.margenPct = ventaReal>0 ? margen/ventaReal : 0;
  res.mult = mult;
  res.precioFactor = precioFactor;
  res.resultadoAnual = calcularResultadoAnual(res, ventaReal, ventaTeorica, ventaPerdidaQuiebre);

  ultimo = res;
  return res;
}

function calcularResultadoAnual(res, ventaRealSemanal, ventaTeoricaSemanal, ventaPerdidaSemanal){
  const SEMANAS_ANO = 52;
  const ventasBrutas = ventaRealSemanal * SEMANAS_ANO;             // precio de lista, impuesto incluido
  const impuesto = ventasBrutas - ventasBrutas/(1+state.impuestoPct);
  const ingresoNeto = ventasBrutas - impuesto;
  const costoMateriaPrima = ingresoNeto * DATA.parametros.food_cost_pct;
  const utilidadBruta = ingresoNeto - costoMateriaPrima;
  const deliveryPct = promedioCanalDelivery();
  const ventaDelivery = ingresoNeto * deliveryPct;
  const comisionDomicilios = ventaDelivery * state.comisionDomicilioPct;
  const costoLogistico = res.costoTotalSemanal * SEMANAS_ANO;
  const utilidadOperacional = utilidadBruta - comisionDomicilios - costoLogistico;

  return {
    ventasBrutas, impuesto, ingresoNeto, costoMateriaPrima, utilidadBruta,
    deliveryPct, ventaDelivery, comisionDomicilios, costoLogistico, utilidadOperacional,
    ventaPerdidaAnual: ventaPerdidaSemanal * SEMANAS_ANO,
    ventaTeoricaAnual: ventaTeoricaSemanal * SEMANAS_ANO,
    margenNetoPct: ingresoNeto>0 ? utilidadOperacional/ingresoNeto : 0,
  };
}

function calcularBaselineSinCalibrar(){
  // Mismo escenario que el actual, pero con el EOQ "de libro" (factor 1.0x, sin la
  // calibracion por simulacion de la Fase 4). Usa menos replicas (150) porque es
  // solo para la comparacion de referencia, no para el resultado principal.
  const mult = demandaEfectiva();
  const q = DATA.parametros.q_teorico * Math.sqrt(mult) * 1.0;
  const rPorDia = computeRMixto(state.nivel, mult);
  const resBase = simular(q, rPorDia, mult, 150);

  const ventaProteinaSemanalBase = DATA.parametros.demanda_semanal_proteina / DATA.parametros.food_cost_pct;
  const precioFactor = precioFactorActivo();
  const ventaTeorica = ventaProteinaSemanalBase * mult * precioFactor;
  const ventaReal = ventaTeorica * resBase.nivelServicio;
  const ventaPerdida = ventaTeorica - ventaReal;

  const ra = calcularResultadoAnual(resBase, ventaReal, ventaTeorica, ventaPerdida);
  ra.nivelServicio = resBase.nivelServicio;
  return ra;
}

// ---------------------------------------------------------------------------
// SVG helpers
// ---------------------------------------------------------------------------
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs){ const el=document.createElementNS(NS,tag); for(const k in attrs) el.setAttribute(k,attrs[k]); return el; }
function clearSvg(svg){ while(svg.firstChild) svg.removeChild(svg.firstChild); }
function txt(x,y,s,size,anchor){ const t=svgEl('text',{x,y,'font-size':size||10,'text-anchor':anchor||'start'}); t.textContent=s; return t; }
function animatePath(path){
  if (REDUCE_MOTION) return;
  requestAnimationFrame(()=>{
    try { const len = path.getTotalLength(); path.style.setProperty('--len', len); path.classList.add('draw'); } catch(e){}
  });
}

function attachHover(svg, ML, MT, plotW, plotH, nDias, viewBoxW, getInfo){
  const tooltip = document.getElementById('chart-tooltip');
  const cross = svgEl('line',{class:'hover-cross', x1:ML,x2:ML, y1:MT, y2:MT+plotH, stroke:'var(--ink-2)','stroke-width':1,'stroke-dasharray':'3,3', opacity:0});
  svg.appendChild(cross);
  const capture = svgEl('rect',{class:'hover-capture', x:ML, y:MT, width:plotW, height:plotH, fill:'transparent'});
  svg.appendChild(capture);

  capture.addEventListener('mousemove', (e)=>{
    const rect = svg.getBoundingClientRect();
    const svgX = (e.clientX-rect.left)/rect.width*viewBoxW;
    let i = Math.round((svgX-ML)/plotW*(nDias-1));
    i = Math.max(0, Math.min(nDias-1, i));
    const info = getInfo(i);
    cross.setAttribute('x1', info.x); cross.setAttribute('x2', info.x); cross.setAttribute('opacity', 1);
    tooltip.innerHTML = info.html;
    tooltip.style.left = e.clientX+'px';
    tooltip.style.top = rect.top+'px';
    tooltip.classList.add('show');
  });
  capture.addEventListener('mouseleave', ()=>{
    cross.setAttribute('opacity', 0);
    tooltip.classList.remove('show');
  });
}

// Tooltip generico para marcas puntuales (barras, segmentos de dona, el
// gauge): sigue el cursor en vez de anclarse al eje X como attachHover,
// porque estos charts no tienen un eje temporal continuo para escanear.
// Da la misma interaccion de hover a TODOS los tipos de grafico del panel.
function attachPointTooltip(el, getHtml){
  const tooltip = document.getElementById('chart-tooltip');
  if (!el || !tooltip) return;
  const show = (e)=>{
    tooltip.innerHTML = getHtml();
    tooltip.style.left = e.clientX+'px';
    tooltip.style.top = e.clientY+'px';
    tooltip.classList.add('show');
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', show);
  el.addEventListener('mouseleave', ()=> tooltip.classList.remove('show'));
}

function renderBarChart(svg, labels, values, errors, fmt){
  fmt = fmt || fmtCOP;
  clearSvg(svg);
  const W=640,H=300,ML=56,MR=12,MT=16,MB=34, plotW=W-ML-MR, plotH=H-MT-MB;
  const maxV = Math.max(...values.map((v,i)=>v+(errors?errors[i]:0)))*1.08;
  const step = plotW/labels.length, bw = step*0.6;
  for (let g=0; g<=4; g++){
    const y = MT+plotH-(g/4)*plotH;
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:y,y2:y,class:'grid'}));
    svg.appendChild(txt(ML-8,y+3,(maxV*g/4/1e6).toFixed(1)+'M',10,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:ML,y1:MT,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:MT+plotH,y2:MT+plotH,class:'axis'}));
  labels.forEach((lab,i)=>{
    const x = ML+i*step+step/2, v=values[i], barH=(v/maxV)*plotH, y=MT+plotH-barH;
    const r = svgEl('rect',{x:x-bw/2,y,width:bw,height:barH,fill:'var(--accent)',rx:4,class:'bar'});
    r.style.animationDelay = (i*45)+'ms';
    svg.appendChild(r);
    attachPointTooltip(r, ()=> `<b>${lab}</b>${fmt(v)}` + (errors ? `<br>±${fmt(errors[i])}` : ''));
    if (errors){
      const eH=(errors[i]/maxV)*plotH;
      svg.appendChild(svgEl('line',{x1:x,x2:x,y1:y-eH,y2:Math.min(y+eH,MT+plotH),stroke:'var(--muted)','stroke-width':1.3}));
      svg.appendChild(svgEl('line',{x1:x-5,x2:x+5,y1:Math.max(y-eH,MT),y2:Math.max(y-eH,MT),stroke:'var(--muted)','stroke-width':1.3}));
    }
    svg.appendChild(txt(x,MT+plotH+18,lab.slice(0,3),11,'middle'));
  });
}

function renderGroupedBar(svg, labels, seriesA, seriesB, opts){
  opts = opts || {};
  const fmt = opts.fmt || ((v)=>fmtPct(v,1));
  const nameA = opts.nameA || 'Serie A', nameB = opts.nameB || 'Serie B';
  clearSvg(svg);
  const W=640,H=320,ML=44,MR=12,MT=16,MB=36, plotW=W-ML-MR, plotH=H-MT-MB;
  const maxV = Math.max(...seriesA,...seriesB)*1.15;
  const step = plotW/labels.length, bw = step*0.34;
  for (let g=0; g<=4; g++){
    const y = MT+plotH-(g/4)*plotH;
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:y,y2:y,class:'grid'}));
    svg.appendChild(txt(ML-8,y+3,(maxV*g/4*100).toFixed(0)+'%',10,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:ML,y1:MT,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:MT+plotH,y2:MT+plotH,class:'axis'}));
  labels.forEach((lab,i)=>{
    const cx = ML+i*step+step/2;
    const hA=(seriesA[i]/maxV)*plotH, hB=(seriesB[i]/maxV)*plotH;
    const rA = svgEl('rect',{x:cx-bw-1,y:MT+plotH-hA,width:bw,height:hA,fill:'var(--accent)',rx:3,class:'bar'});
    const rB = svgEl('rect',{x:cx+1,y:MT+plotH-hB,width:bw,height:hB,fill:'var(--accent-2)',rx:3,class:'bar'});
    rA.style.animationDelay = (i*40)+'ms'; rB.style.animationDelay = (i*40+20)+'ms';
    svg.appendChild(rA); svg.appendChild(rB);
    attachPointTooltip(rA, ()=> `<b>${lab}</b>${nameA}: ${fmt(seriesA[i])}`);
    attachPointTooltip(rB, ()=> `<b>${lab}</b>${nameB}: ${fmt(seriesB[i])}`);
    svg.appendChild(txt(cx,MT+plotH+16,lab.slice(0,3),10,'middle'));
  });
}

let trayectoriaGeom = null;
function renderTrayectoria(svg, traza, nDias){
  clearSvg(svg);
  const W=640,H=340,ML=56,MR=12,MT=16,MB=30, plotW=W-ML-MR, plotH=H-MT-MB;
  const datos = traza.slice(0,nDias);
  const maxV = Math.max(...datos.map(d=>Math.max(d.inventario,d.R)))*1.08;
  const x=(i)=>ML+(i/(nDias-1))*plotW, y=(v)=>MT+plotH-(v/maxV)*plotH;
  for (let g=0; g<=4; g++){
    const yy = MT+plotH-(g/4)*plotH;
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:yy,y2:yy,class:'grid'}));
    svg.appendChild(txt(ML-8,yy+3,(maxV*g/4/1e6).toFixed(1)+'M',10,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:ML,y1:MT,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:MT+plotH,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('path',{d:datos.map((d,i)=>(i===0?'M':'L')+x(i)+','+y(d.R)).join(' '),fill:'none',stroke:'var(--muted)','stroke-width':1.3,'stroke-dasharray':'4,3'}));
  const pInv = svgEl('path',{d:datos.map((d,i)=>(i===0?'M':'L')+x(i)+','+y(d.inventario)).join(' '),fill:'none',stroke:'var(--accent)','stroke-width':2.2,'stroke-linecap':'round','stroke-linejoin':'round'});
  svg.appendChild(pInv); animatePath(pInv);
  datos.forEach((d,i)=>{ if (d.quiebre) svg.appendChild(svgEl('circle',{cx:x(i),cy:y(d.inventario),r:3.4,fill:'var(--critical)'})); });

  const markerLine = svgEl('line',{class:'day-marker-line', x1:ML,x2:ML, y1:MT, y2:MT+plotH});
  const markerDot = svgEl('circle',{class:'day-marker-dot', r:5.5, cx:ML, cy:MT});
  svg.appendChild(markerLine); svg.appendChild(markerDot);

  attachHover(svg, ML, MT, plotW, plotH, datos.length, W, (i)=>{
    const d = datos[i];
    return { x:x(i), html:`<b>Día ${i}</b>Inventario: ${fmtCOP(d.inventario)}<br>R: ${fmtCOP(d.R)}${d.quiebre?'<br><span style="color:var(--critical)">Quiebre de stock</span>':''}` };
  });

  trayectoriaGeom = { x, y, datos, markerLine, markerDot };
  moveDayMarker(parseInt(document.getElementById('sl-dia')?.value || 0, 10));
}

function moveDayMarker(dia){
  if (!trayectoriaGeom) return;
  const { x, y, datos, markerLine, markerDot } = trayectoriaGeom;
  const i = Math.max(0, Math.min(datos.length-1, dia));
  const d = datos[i];
  markerLine.setAttribute('x1', x(i)); markerLine.setAttribute('x2', x(i));
  markerDot.setAttribute('cx', x(i)); markerDot.setAttribute('cy', y(d.inventario));
  renderDiaDetalle(d, i);
}

function renderGauge(svg, value, max, color, tooltipHtml){
  clearSvg(svg);
  const cx=85, cy=90, r=62;
  const f = Math.max(0.012, Math.min(0.988, max>0 ? value/max : 0));
  const pt = (ff)=>{ const a = Math.PI - ff*Math.PI; return [cx+r*Math.cos(a), cy-r*Math.sin(a)]; };
  const [bx0,by0] = pt(0.012), [bx1,by1] = pt(0.988);
  svg.appendChild(svgEl('path',{d:`M${bx0},${by0} A${r},${r} 0 0 1 ${bx1},${by1}`, fill:'none', stroke:'var(--line)','stroke-width':13,'stroke-linecap':'round'}));
  const [fx0,fy0] = pt(0.012), [fx1,fy1] = pt(f);
  const fill = svgEl('path',{d:`M${fx0},${fy0} A${r},${r} 0 0 1 ${fx1},${fy1}`, fill:'none', stroke:color,'stroke-width':13,'stroke-linecap':'round', class:'gauge-fill'});
  svg.appendChild(fill);
  const [rx,ry] = pt(Math.min(0.988, 0.5));
  svg.appendChild(svgEl('line',{x1:rx,y1:ry-9,x2:rx,y2:ry+9,stroke:'var(--ink-2)','stroke-width':2}));
  if (tooltipHtml) attachPointTooltip(fill, ()=> tooltipHtml);
}

// Construye las filas de una tabla de frecuencias (Sturges) a partir de la
// tabla de muestreo ya exportada (limite_inf/limite_sup/frec_acum por clase).
function construirFilasFrecuencia(tabla){
  let prevAcum = 0;
  return tabla.map(c=>{
    const relativa = c.frec_acum - prevAcum;
    prevAcum = c.frec_acum;
    return { intervalo: `${fmtCOP(c.limite_inf)} – ${fmtCOP(c.limite_sup)}`, relativa, acumulada: c.frec_acum };
  });
}

// Tabla de frecuencias del dia anterior y siguiente, para CUALQUIERA de los
// 365 dias del ano: solo depende del dia de la semana (modulo 7), nunca de
// la fecha exacta, asi que no hay casos especiales en los bordes del ano.
function renderFrecuenciasAdyacentes(i){
  const wd = ((i % 7) + 7) % 7;
  const diaPrev = DATA.dias[(wd + 6) % 7];
  const diaNext = DATA.dias[(wd + 1) % 7];

  const tituloPrev = document.getElementById('freq-dia-anterior-titulo');
  const tituloNext = document.getElementById('freq-dia-siguiente-titulo');
  if (tituloPrev) tituloPrev.textContent = `Día anterior: ${diaPrev}`;
  if (tituloNext) tituloNext.textContent = `Día siguiente: ${diaNext}`;

  const llenar = (tablaId, dia)=>{
    const tbody = document.querySelector('#'+tablaId+' tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    construirFilasFrecuencia(DATA.tablas_muestreo[dia]).forEach(f=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${f.intervalo}</td><td class="num">${fmtPct(f.relativa)}</td><td class="num">${fmtPct(f.acumulada)}</td>`;
      tbody.appendChild(tr);
    });
  };
  llenar('tabla-freq-anterior', diaPrev);
  llenar('tabla-freq-siguiente', diaNext);
}

function renderDiaDetalle(d, i){
  renderFrecuenciasAdyacentes(i);
  const lbl = document.getElementById('lbl-dia');
  if (lbl) lbl.textContent = `Día ${i+1}`;
  const sl = document.getElementById('sl-dia');
  if (sl && parseInt(sl.value,10) !== i) sl.value = i;

  const serieDia = DATA.serie_diaria[i];
  if (serieDia){
    const fecha = new Date(serieDia.fecha+'T00:00:00');
    const mesNombre = DATA.estacionalidad.meses[fecha.getMonth()];
    document.getElementById('dia-fecha').textContent = `${fecha.getDate()} de ${mesNombre.toLowerCase()}, 2025`;
    const canal = DATA.canal_mensual[mesNombre];
    renderDonut(document.getElementById('donut-canal'), [
      { value: canal.in_house, color: 'var(--accent)', label: 'In house', fmt: (v)=>fmtPct(v,0) },
      { value: canal.delivery, color: 'var(--accent-2)', label: 'Domicilio', fmt: (v)=>fmtPct(v,0) },
    ]);
  }

  document.getElementById('dia-semana').textContent = d.diaSemana;
  document.getElementById('dia-posicion').textContent = fmtCOP(d.posicion);
  document.getElementById('dia-r').textContent = fmtCOP(d.R);
  document.getElementById('dia-pedido').textContent = d.pedidoColocado
    ? `Sí: ${fmtCOP(d.Q)}, llega en ${d.pedidoLeadTime} días` : 'No se colocó pedido';

  animateNumber(document.getElementById('chip-inv-inicio'), d.inventarioInicio, v=>fmtCOP(v), 350);
  animateNumber(document.getElementById('chip-demanda'), d.demanda, v=>fmtCOP(v), 350);
  animateNumber(document.getElementById('chip-inv-cierre'), d.inventario, v=>fmtCOP(v), 350);
  document.getElementById('chip-pedido').textContent = d.pedidoColocado ? 'Sí' : 'No';

  const estadoEl = document.getElementById('dia-estado');
  let gaugeColor = 'var(--good)', gaugeLabel = 'Normal';
  if (d.quiebre){ estadoEl.innerHTML = '<span class="pill critical" style="margin:0">Quiebre de stock</span>'; gaugeColor='var(--critical)'; gaugeLabel='Quiebre'; }
  else if (d.inventario < d.R){ estadoEl.innerHTML = '<span class="pill warn" style="margin:0">Por debajo de R</span>'; gaugeColor='var(--warn)'; gaugeLabel='Bajo R'; }
  else { estadoEl.innerHTML = '<span class="pill good" style="margin:0">Normal</span>'; }

  const gaugeMax = Math.max(d.R*2, d.posicion*1.05, d.inventario*1.05);
  renderGauge(document.getElementById('gauge-stock'), d.inventario, gaugeMax, gaugeColor, `<b>${gaugeLabel}</b>Inventario: ${fmtCOP(d.inventario)}<br>R vigente: ${fmtCOP(d.R)}`);
  document.getElementById('gauge-label').textContent = gaugeLabel + ' · ' + fmtCOP(d.inventario);

  renderDonut(document.getElementById('donut-demanda'), [
    { value: d.servido, color: 'var(--good)', label: 'Atendida' },
    { value: d.quiebreMonto, color: 'var(--critical)', label: 'Quiebre' },
  ]);

  actualizarContadorQuiebres(i);
}

function diasQuiebreLista(){
  if (!ultimo || !ultimo.traza) return [];
  const lista = [];
  ultimo.traza.forEach((d,i)=>{ if (d.quiebre) lista.push(i); });
  return lista;
}

function irAQuiebre(direccion){
  const lista = diasQuiebreLista();
  if (!lista.length){ showToast('No hay quiebres de stock en esta réplica'); return; }
  const sl = document.getElementById('sl-dia');
  const actual = parseInt(sl.value,10);
  let objetivo;
  if (direccion > 0){
    objetivo = lista.find(d=>d>actual);
    if (objetivo===undefined) objetivo = lista[0];
  } else {
    const anteriores = lista.filter(d=>d<actual);
    objetivo = anteriores.length ? anteriores[anteriores.length-1] : lista[lista.length-1];
  }
  sl.value = objetivo; updateSliderFill(sl); moveDayMarker(objetivo);
}

function actualizarContadorQuiebres(diaActual){
  const lbl = document.getElementById('lbl-quiebres');
  if (!lbl) return;
  const lista = diasQuiebreLista();
  if (!lista.length){ lbl.textContent = 'Sin quiebres en esta réplica'; return; }
  const pos = lista.indexOf(diaActual);
  lbl.textContent = pos>=0 ? `Quiebre ${pos+1} de ${lista.length}` : `${lista.length} quiebres en esta réplica`;
}

function renderCartaComposicion(){
  const categorias = {};
  DATA.menu.forEach(m=>{
    if (!state.menuActivos[m.producto]) return;
    categorias[m.categoria] = (categorias[m.categoria]||0) + 1;
  });
  const colores = { Carnes:'var(--accent)', Pescados:'var(--accent-2)', Pollo:'var(--good)' };
  const nombres = Object.keys(categorias);
  renderDonut(document.getElementById('donut-carta'), nombres.map(n=>({ value: categorias[n], color: colores[n] || 'var(--muted)', label: n, fmt: (v)=>v+' platos' })), { centerLabel: nombres[0] ? nombres[0].toLowerCase() : '' });

  const tbody = document.querySelector('#tabla-carta tbody');
  tbody.innerHTML = '';
  nombres.forEach(n=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="dot2" style="background:${colores[n]||'var(--muted)'}; display:inline-block; margin-right:6px"></span>${n}</td><td class="num">${categorias[n]} platos</td>`;
    tbody.appendChild(tr);
  });
}

function renderWaterfall(svg, items){
  // items: [{label, value, kind:'total'|'delta'}] - 'total' dibuja desde 0, 'delta' se acumula sobre el anterior.
  clearSvg(svg);
  const W=640,H=320,ML=58,MR=16,MT=18,MB=64, plotW=W-ML-MR, plotH=H-MT-MB;
  let running = 0;
  const bars = items.map(it=>{
    let from, to;
    if (it.kind==='total'){ from=0; to=it.value; running=it.value; }
    else { from=running; to=running+it.value; running=to; }
    return { ...it, from, to };
  });
  const vals = bars.flatMap(b=>[b.from,b.to]);
  const maxV = Math.max(0,...vals)*1.12, minV = Math.min(0,...vals)*1.12;
  const range = (maxV-minV)||1;
  const y = (v)=> MT + plotH - ((v-minV)/range)*plotH;
  const n = bars.length, step = plotW/n, bw = step*0.56;

  for (let g=0; g<=4; g++){
    const v = minV + (range*g/4);
    const yy = y(v);
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:yy,y2:yy,class:'grid'}));
    svg.appendChild(txt(ML-8,yy+3,fmtCOPCompact(v),9,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:y(0),y2:y(0),class:'axis'}));

  bars.forEach((b,i)=>{
    const cx = ML + i*step + step/2;
    const yTop = y(Math.max(b.from,b.to)), yBot = y(Math.min(b.from,b.to));
    const h = Math.max(2, yBot-yTop);
    let color = 'var(--accent)';
    if (b.kind==='delta') color = b.value>=0 ? 'var(--good)' : 'var(--critical)';
    else if (b.value<0) color = 'var(--critical)';
    const r = svgEl('rect',{x:cx-bw/2, y:yTop, width:bw, height:h, fill:color, rx:3, class:'bar'});
    r.style.animationDelay = (i*55)+'ms';
    svg.appendChild(r);
    attachPointTooltip(r, ()=> `<b>${b.label}</b>${fmtCOP(b.value)}${b.kind==='total' ? '<br>Total acumulado: '+fmtCOP(b.to) : ''}`);
    if (i<n-1){
      svg.appendChild(svgEl('line',{x1:cx+bw/2, x2:cx+step-bw/2, y1:y(b.to), y2:y(b.to), stroke:'var(--line)','stroke-width':1.2,'stroke-dasharray':'3,2'}));
    }
    svg.appendChild(txt(cx, yTop-7, fmtCOPCompact(b.value), 9.5, 'middle'));
    const lbl = txt(0,0,b.label,9,'middle');
    lbl.setAttribute('transform', `translate(${cx},${MT+plotH+14}) rotate(-28)`);
    lbl.setAttribute('text-anchor','end');
    svg.appendChild(lbl);
  });
}

function renderDonut(svg, segments, opts){
  // segments: [{value, color, label?, fmt?}]. label/fmt alimentan el tooltip
  // de cada porcion; antes esta funcion no tenia hover en ningun llamador.
  // centerLabel es el texto chico bajo el %: por defecto el nombre del primer
  // segmento (antes decia siempre "mantener", heredado de chart-costos, y
  // quedaba mal en donut-carta/donut-demanda/donut-canal/chart-donut-resultado).
  opts = opts || {};
  clearSvg(svg);
  const cx=130, cy=130, rOuter=104, rInner=66;
  const total = segments.reduce((s,seg)=>s+seg.value,0) || 1;
  let angleStart = -Math.PI/2;
  segments.forEach((seg,i)=>{
    const frac = seg.value/total;
    const angleEnd = angleStart + frac*2*Math.PI - (segments.length>1 ? 0.03 : 0);
    const x1=cx+rOuter*Math.cos(angleStart), y1=cy+rOuter*Math.sin(angleStart);
    const x2=cx+rOuter*Math.cos(angleEnd), y2=cy+rOuter*Math.sin(angleEnd);
    const x3=cx+rInner*Math.cos(angleEnd), y3=cy+rInner*Math.sin(angleEnd);
    const x4=cx+rInner*Math.cos(angleStart), y4=cy+rInner*Math.sin(angleStart);
    const largeArc = (angleEnd-angleStart) > Math.PI ? 1 : 0;
    const d = `M${x1},${y1} A${rOuter},${rOuter} 0 ${largeArc} 1 ${x2},${y2} L${x3},${y3} A${rInner},${rInner} 0 ${largeArc} 0 ${x4},${y4} Z`;
    const path = svgEl('path',{d, fill:seg.color, class:'donut-seg'});
    path.style.animationDelay = (i*90)+'ms';
    svg.appendChild(path);
    const fmt = seg.fmt || fmtCOP;
    const nombre = seg.label || `Segmento ${i+1}`;
    attachPointTooltip(path, ()=> `<b>${nombre}</b>${fmt(seg.value)} (${fmtPct(frac,0)})`);
    angleStart += frac*2*Math.PI;
  });
  const t1 = txt(cx, cy-2, fmtPct(segments[0] ? segments[0].value/total : 0, 0), 15, 'middle');
  t1.setAttribute('font-weight','700'); t1.style.fill = 'var(--ink)';
  svg.appendChild(t1);
  const centerLabel = opts.centerLabel !== undefined ? opts.centerLabel : ((segments[0] && segments[0].label) ? segments[0].label.toLowerCase() : '');
  if (centerLabel){
    const t2 = txt(cx, cy+14, centerLabel, 8, 'middle');
    t2.style.fill = 'var(--muted)';
    svg.appendChild(t2);
  }
}

function renderConvergencia(c){
  animateNumber(document.getElementById('conv-media'), c.media, v=>fmtPct(v));
  animateNumber(document.getElementById('conv-sd'), c.desvEst, v=>'±'+fmtPct(v));
  const icEl = document.getElementById('conv-ic95');
  if (icEl) icEl.textContent = `[${fmtPct(c.ic95Inf)}, ${fmtPct(c.ic95Sup)}]`;
  animateNumber(document.getElementById('conv-p5'), c.p5, v=>fmtPct(v));
  animateNumber(document.getElementById('conv-p95'), c.p95, v=>fmtPct(v));
}

function renderCostos(res){
  animateNumber(document.getElementById('costo-mantener'), res.costoMantenerSemanal, v=>fmtCOP(v));
  animateNumber(document.getElementById('costo-ordenar'), res.costoOrdenarSemanal, v=>fmtCOP(v));
  renderDonut(document.getElementById('chart-costos'), [
    { value: res.costoMantenerSemanal, color: 'var(--accent)', label: 'Mantener inventario' },
    { value: res.costoOrdenarSemanal, color: 'var(--accent-2)', label: 'Ordenar al proveedor' },
  ]);
}

function renderResultadoAnual(res){
  const ra = res.resultadoAnual;

  animateNumber(document.getElementById('kpi-utilidad-anual'), ra.utilidadOperacional, v=>fmtCOP(v));
  const pill = document.getElementById('kpi-utilidad-pill');
  if (ra.utilidadOperacional >= 0){ pill.className='pill good'; pill.textContent='Ganancia operacional'; }
  else { pill.className='pill critical'; pill.textContent='Pérdida operacional'; }

  animateNumber(document.getElementById('kpi-ventas-brutas'), ra.ventasBrutas, v=>fmtCOP(v));
  animateNumber(document.getElementById('kpi-margen-neto'), ra.margenNetoPct, v=>fmtPct(v));
  animateNumber(document.getElementById('kpi-quiebre-perdida'), ra.ventaPerdidaAnual, v=>fmtCOP(v));

  renderWaterfall(document.getElementById('chart-waterfall'), [
    { label:'Ventas brutas', value: ra.ventasBrutas, kind:'total' },
    { label:'Impuesto consumo', value: -ra.impuesto, kind:'delta' },
    { label:'Materia prima', value: -ra.costoMateriaPrima, kind:'delta' },
    { label:'Comisión domicilios', value: -ra.comisionDomicilios, kind:'delta' },
    { label:'Costo inventario', value: -ra.costoLogistico, kind:'delta' },
    { label:'Utilidad operacional', value: ra.utilidadOperacional, kind:'total' },
  ]);

  renderDonut(document.getElementById('chart-donut-resultado'), [
    { value: ra.impuesto, color: 'var(--warn)', label: 'Impuesto al consumo' },
    { value: ra.costoMateriaPrima, color: 'var(--accent)', label: 'Materia prima' },
    { value: ra.comisionDomicilios, color: 'var(--accent-2)', label: 'Comisión domicilios' },
    { value: ra.costoLogistico, color: 'var(--muted)', label: 'Costo de inventario' },
    { value: Math.max(0, ra.utilidadOperacional), color: 'var(--good)', label: 'Utilidad operacional' },
  ], { centerLabel: 'impuesto al consumo' });

  const filas = [
    ['Ventas brutas facturadas (año)', ra.ventasBrutas],
    [`(-) Impuesto al consumo (${fmtPct(state.impuestoPct,0)})`, -ra.impuesto],
    ['= Ingreso operacional neto', ra.ingresoNeto],
    [`(-) Costo materia prima (${fmtPct(DATA.parametros.food_cost_pct,0)})`, -ra.costoMateriaPrima],
    ['= Utilidad bruta', ra.utilidadBruta],
    [`(-) Comisión domicilios (${fmtPct(ra.deliveryPct,0)} de venta × ${fmtPct(state.comisionDomicilioPct,0)})`, -ra.comisionDomicilios],
    ['(-) Costo de inventario (mantener + ordenar)', -ra.costoLogistico],
    ['= Utilidad operacional del año', ra.utilidadOperacional],
  ];
  const tbody = document.querySelector('#tabla-resultado tbody');
  tbody.innerHTML = '';
  filas.forEach(([label, valor])=>{
    const tr = document.createElement('tr');
    const esTotal = label.startsWith('=');
    if (esTotal){ tr.style.fontWeight = '600'; tr.style.background = 'var(--surface-2)'; }
    tr.innerHTML = `<td>${label}</td><td class="num" style="color:${valor<0?'var(--critical)':'inherit'}">${fmtCOP(valor)}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('resultado-memo').innerHTML = `
    Demanda total que llegó durante el año (a precio de lista): ${fmtCOP(ra.ventaTeoricaAnual)}.
    De eso, <b>${fmtCOP(ra.ventaPerdidaAnual)}</b> no se facturaron porque el inventario no alcanzó (quiebre de stock),
    es decir, nivel de servicio del ${fmtPct(res.nivelServicio)} sobre la demanda real.`;

  // Comparacion: configuracion actual (factor state.factor) vs. EOQ puro de
  // formula (1.0x) - el default ya es 1.0x porque la Fase 4 confirmo que el
  // EOQ puro, con el lead time simulado correctamente, cumple el objetivo de
  // servicio sin calibrar nada (ver fase4_simulacion.py). Esta tabla muestra
  // cuanto cuesta en pesos subir el factor por encima de ese default.
  const base = calcularBaselineSinCalibrar();
  const diferencia = ra.utilidadOperacional - base.utilidadOperacional;
  document.getElementById('comp-servicio-calibrado').textContent = fmtPct(res.nivelServicio);
  document.getElementById('comp-servicio-base').textContent = fmtPct(base.nivelServicio);
  animateNumber(document.getElementById('comp-utilidad-calibrado'), ra.utilidadOperacional, v=>fmtCOP(v));
  animateNumber(document.getElementById('comp-utilidad-base'), base.utilidadOperacional, v=>fmtCOP(v));
  const diffEl = document.getElementById('comp-diferencia');
  animateNumber(diffEl, diferencia, v=>(v>=0?'+':'')+fmtCOP(v));
  diffEl.style.color = diferencia>=0 ? 'var(--good)' : 'var(--critical)';
  document.getElementById('comp-nota').textContent = Math.abs(state.factor-1.0)<0.05
    ? `Esta es la configuración por defecto (factor 1.0x = EOQ puro): ya cumple el objetivo de servicio, no hace falta subir el factor.`
    : diferencia>=0
      ? `Con factor ${state.factor.toFixed(1)}x esta configuración da ${fmtCOP(diferencia)} MÁS de utilidad al año que el EOQ puro (1.0x).`
      : `Con factor ${state.factor.toFixed(1)}x esta configuración da ${fmtCOP(Math.abs(diferencia))} MENOS de utilidad al año que el EOQ puro (1.0x) — el colchón extra de inventario no se está pagando solo aquí.`;
}

function renderComparativo(svg, real, simulado, nDias){
  clearSvg(svg);
  const W=640,H=300,ML=56,MR=12,MT=16,MB=30, plotW=W-ML-MR, plotH=H-MT-MB;
  const r = real.slice(0,nDias), s = simulado.slice(0,nDias);
  const maxV = Math.max(...r, ...s.map(d=>d.demanda))*1.08;
  const x=(i)=>ML+(i/(nDias-1))*plotW, y=(v)=>MT+plotH-(v/maxV)*plotH;
  for (let g=0; g<=4; g++){
    const yy = MT+plotH-(g/4)*plotH;
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:yy,y2:yy,class:'grid'}));
    svg.appendChild(txt(ML-8,yy+3,(maxV*g/4/1e6).toFixed(1)+'M',10,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:ML,y1:MT,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:MT+plotH,y2:MT+plotH,class:'axis'}));
  const pReal = svgEl('path',{d:r.map((v,i)=>(i===0?'M':'L')+x(i)+','+y(v)).join(' '),fill:'none',stroke:'var(--muted)','stroke-width':1.6,'stroke-linecap':'round'});
  const pSim = svgEl('path',{d:s.map((d,i)=>(i===0?'M':'L')+x(i)+','+y(d.demanda)).join(' '),fill:'none',stroke:'var(--accent)','stroke-width':1.8,'stroke-opacity':0.95,'stroke-linecap':'round'});
  svg.appendChild(pReal); svg.appendChild(pSim);
  animatePath(pReal); animatePath(pSim);

  attachHover(svg, ML, MT, plotW, plotH, r.length, W, (i)=>{
    return { x:x(i), html:`<b>Día ${i}</b>Real: ${fmtCOP(r[i])}<br>Proyectado: ${fmtCOP(s[i].demanda)}` };
  });
}

// ---------------------------------------------------------------------------
// Reproduccion de la trayectoria dia a dia (requestAnimationFrame, ~60fps).
// Toggle real reproducir <-> pausar: pausar conserva la posicion exacta del
// dia (no reinicia desde cero) y la velocidad se puede cambiar en pleno vuelo.
// `playback` vive mientras hay una reproduccion activa o en pausa; se vuelve
// null en cuanto termina, se cancela, o el usuario cambia un control what-if.
// ---------------------------------------------------------------------------
let velocidadReproduccion = 1;
const MS_POR_DIA_BASE = 90; // a 1x: ~33s para recorrer el año completo, dia a dia, legible
const LABEL_PLAY_IDLE = '▶ Reproducir año completo';
let playback = null;

function construirEscenaReproduccion(){
  if (!ultimo || !ultimo.traza) return null;
  const nDias = 365;
  const datos = ultimo.traza.slice(0, nDias);
  const svg = document.getElementById('chart-trayectoria');

  const W=640,H=340,ML=56,MR=12,MT=16,MB=30, plotW=W-ML-MR, plotH=H-MT-MB;
  const maxV = Math.max(...datos.map(d=>Math.max(d.inventario,d.R)))*1.08;
  const x=(i)=>ML+(i/(nDias-1))*plotW, y=(v)=>MT+plotH-(v/maxV)*plotH;

  clearSvg(svg);
  for (let g=0; g<=4; g++){
    const yy = MT+plotH-(g/4)*plotH;
    svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:yy,y2:yy,class:'grid'}));
    svg.appendChild(txt(ML-8,yy+3,(maxV*g/4/1e6).toFixed(1)+'M',10,'end'));
  }
  svg.appendChild(svgEl('line',{x1:ML,x2:ML,y1:MT,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('line',{x1:ML,x2:W-MR,y1:MT+plotH,y2:MT+plotH,class:'axis'}));
  svg.appendChild(svgEl('path',{d:datos.map((d,i)=>(i===0?'M':'L')+x(i)+','+y(d.R)).join(' '),fill:'none',stroke:'var(--muted)','stroke-width':1.3,'stroke-dasharray':'4,3'}));

  const pInv = svgEl('path',{fill:'none',stroke:'var(--accent)','stroke-width':2.4,'stroke-linecap':'round','stroke-linejoin':'round'});
  svg.appendChild(pInv);
  const playhead = svgEl('circle',{r:5.5,fill:'var(--accent)',stroke:'var(--surface)','stroke-width':2.2});
  svg.appendChild(playhead);

  // El clearSvg() de arriba borró el marcador de día (markerLine/markerDot)
  // que renderTrayectoria() había dejado en trayectoriaGeom, dejando esas
  // referencias apuntando a nodos ya fuera del DOM. Se recrean aquí y se
  // reemplaza trayectoriaGeom para que moveDayMarker() (el slider "Día",
  // los botones ◀/▶ y "Quiebre siguiente") sigan funcionando durante y
  // después de la reproducción, en vez de quedar huérfanos para siempre.
  const markerLine = svgEl('line',{class:'day-marker-line', x1:ML,x2:ML, y1:MT, y2:MT+plotH});
  const markerDot = svgEl('circle',{class:'day-marker-dot', r:5.5, cx:ML, cy:MT});
  svg.appendChild(markerLine); svg.appendChild(markerDot);
  trayectoriaGeom = { x, y, datos, markerLine, markerDot };
  moveDayMarker(parseInt(document.getElementById('sl-dia')?.value || 0, 10));

  return { nDias, datos, svg, W,H,ML,MR,MT,MB,plotW,plotH, x, y, pInv, playhead, marcados:{}, ultimoDiaMostrado:-1, estado:'playing', rafId:null };
}

// Cancela de inmediato cualquier reproduccion activa/en pausa sin dejar el
// grafico o el boton en un estado intermedio. Se llama antes de reconstruir
// el chart con datos nuevos (ej. el usuario mueve un slider what-if a medio
// vuelo de la animacion) para evitar manipular nodos SVG ya removidos.
function cancelarReproduccion(){
  if (!playback) return;
  if (playback.rafId) cancelAnimationFrame(playback.rafId);
  playback = null;
  const btn = document.getElementById('btn-play');
  if (btn){ btn.disabled = false; btn.textContent = LABEL_PLAY_IDLE; }
  const readout = document.getElementById('play-readout');
  if (readout) readout.innerHTML = '&nbsp;';
}

function finalizarReproduccion(){
  const p = playback;
  playback = null;
  const btn = document.getElementById('btn-play');
  if (btn){ btn.disabled = false; btn.textContent = LABEL_PLAY_IDLE; }
  if (!p) return;
  if (p.svg.contains(p.playhead)) p.svg.removeChild(p.playhead);
  attachHover(p.svg, p.ML, p.MT, p.plotW, p.plotH, p.nDias, p.W, (i)=>{
    const d = p.datos[i];
    return { x:p.x(i), html:`<b>Día ${i}</b>Inventario: ${fmtCOP(d.inventario)}<br>R: ${fmtCOP(d.R)}${d.quiebre?'<br><span style="color:var(--critical)">Quiebre de stock</span>':''}` };
  });
}

function frameReproduccion(now){
  const p = playback;
  if (!p || p.estado !== 'playing') return;
  const { datos, x, y, pInv, playhead, nDias } = p;
  const t = Math.min(1, (now-p.start)/p.duration);
  const pos = t*(nDias-1);
  const iFloor = Math.floor(pos), frac = pos-iFloor;

  let d = 'M'+x(0)+','+y(datos[0].inventario);
  for (let i=1; i<=iFloor; i++) d += ' L'+x(i)+','+y(datos[i].inventario);
  let curX, curY, curInv;
  if (iFloor < nDias-1){
    const a = datos[iFloor], b = datos[iFloor+1];
    curInv = a.inventario + (b.inventario-a.inventario)*frac;
    curX = x(iFloor+frac); curY = y(curInv);
    d += ' L'+curX+','+curY;
  } else {
    curInv = datos[nDias-1].inventario; curX = x(nDias-1); curY = y(curInv);
  }
  pInv.setAttribute('d', d);
  playhead.setAttribute('cx', curX); playhead.setAttribute('cy', curY);

  for (let i=0;i<=iFloor;i++){
    if (datos[i].quiebre && !p.marcados[i]){
      const m = svgEl('circle',{cx:x(i),cy:y(datos[i].inventario),r:3.4,fill:'var(--critical)'});
      p.svg.insertBefore(m, playhead);
      p.marcados[i] = true;
    }
  }

  const readout = document.getElementById('play-readout');
  readout.innerHTML = `Día ${iFloor} de ${nDias-1} — Inventario: ${fmtCOP(curInv)}` +
    (datos[iFloor].quiebre ? ' <span style="color:var(--critical)">· quiebre de stock</span>' : '');

  if (iFloor !== p.ultimoDiaMostrado){
    p.ultimoDiaMostrado = iFloor;
    renderDiaDetalle(datos[iFloor], iFloor);
    moveDayMarker(iFloor);
  }

  if (t < 1) p.rafId = requestAnimationFrame(frameReproduccion);
  else finalizarReproduccion();
}

function reproducirTrayectoria(){
  // Nota: "Reproducir" es una funcion que el usuario pide explicitamente y
  // controla por completo (pausar/reanudar/velocidad/scrub) -- a diferencia
  // de las animaciones decorativas de entrada (donas, barras, conteo de
  // numeros), que si respetan prefers-reduced-motion, esta SIEMPRE anima
  // cuadro a cuadro. Saltar directo al resultado final aqui rompia el boton
  // de play en cualquier navegador/SO con "reducir movimiento" activado.
  if (playback) return; // ya hay una reproduccion activa o en pausa: usar togglePlayback()
  const escena = construirEscenaReproduccion();
  if (!escena) return;
  const btn = document.getElementById('btn-play');

  escena.duration = (escena.nDias-1) * MS_POR_DIA_BASE / velocidadReproduccion;
  escena.start = performance.now();
  playback = escena;
  btn.disabled = false; btn.textContent = '⏸ Pausar';
  playback.rafId = requestAnimationFrame(frameReproduccion);
}

function pausarReproduccion(){
  if (!playback || playback.estado !== 'playing') return;
  playback.estado = 'paused';
  if (playback.rafId) cancelAnimationFrame(playback.rafId);
  playback.elapsedAlPausar = performance.now() - playback.start;
  document.getElementById('btn-play').textContent = '▶ Reanudar';
}

function reanudarReproduccion(){
  if (!playback || playback.estado !== 'paused') return;
  playback.estado = 'playing';
  playback.start = performance.now() - playback.elapsedAlPausar;
  document.getElementById('btn-play').textContent = '⏸ Pausar';
  playback.rafId = requestAnimationFrame(frameReproduccion);
}

function togglePlayback(){
  if (!playback){ reproducirTrayectoria(); return; }
  if (playback.estado === 'playing'){ pausarReproduccion(); return; }
  if (playback.estado === 'paused'){ reanudarReproduccion(); return; }
}

// Pausa limpiamente si el usuario interactua a mano con el scrub/quiebres
// mientras la animacion esta corriendo, para que no compitan por el mismo SVG.
function detenerReproduccionSiActiva(){
  if (playback && playback.estado === 'playing') pausarReproduccion();
}

function cambiarVelocidadReproduccion(nuevaVelocidad){
  if (playback && (playback.estado === 'playing' || playback.estado === 'paused')){
    // conserva la posicion visual exacta: recalcula start/elapsed para la nueva duracion
    const elapsedActual = playback.estado === 'playing' ? (performance.now()-playback.start) : playback.elapsedAlPausar;
    const t = Math.min(1, elapsedActual / playback.duration);
    playback.duration = (playback.nDias-1) * MS_POR_DIA_BASE / nuevaVelocidad;
    const nuevoElapsed = t * playback.duration;
    if (playback.estado === 'playing') playback.start = performance.now() - nuevoElapsed;
    else playback.elapsedAlPausar = nuevoElapsed;
  }
  velocidadReproduccion = nuevaVelocidad;
}

// ---------------------------------------------------------------------------
// Render por pestaña
// ---------------------------------------------------------------------------
let prevMeetsTarget = null;
function renderResumen(res){
  animateNumber(document.getElementById('kpi-servicio'), res.nivelServicio, v=>fmtPct(v));
  animateNumber(document.getElementById('kpi-servicio-ciclo'), res.nivelServicioCiclo, v=>fmtPct(v));
  const pill = document.getElementById('kpi-servicio-pill');
  // Tolerancia de 1.5pp: la simulacion es Monte Carlo (varia un poco cada
  // corrida), asi que exigir el objetivo exacto marcaria "no cumple" por
  // ruido estadistico normal. Se explica en el title para que no sea una
  // cifra oculta.
  const TOLERANCIA_PP = 0.015;
  const meets = res.nivelServicio >= state.nivel - TOLERANCIA_PP;
  pill.title = `Objetivo: ${fmtPct(state.nivel)} · tolerancia de ${fmtPct(TOLERANCIA_PP,1)} por variación normal de la simulación Monte Carlo`;
  if (meets){ pill.className='pill good'; pill.textContent='Cumple el objetivo'; }
  else { pill.className='pill critical'; pill.textContent='Por debajo del objetivo'; }
  if (meets && prevMeetsTarget === false){
    const card = document.getElementById('kpi-card-servicio');
    card.classList.remove('celebrate');
    void card.offsetWidth;
    card.classList.add('celebrate');
    showToast('Nivel de servicio objetivo alcanzado');
  }
  prevMeetsTarget = meets;

  animateNumber(document.getElementById('kpi-costo'), res.costoTotalSemanal, v=>fmtCOP(v));
  document.getElementById('kpi-costo-sub').textContent = `food cost + ordenar + mantener`;
  animateNumber(document.getElementById('kpi-margen'), res.margenPct, v=>fmtPct(v));
  document.getElementById('kpi-margen-sub').textContent = fmtCOP(res.margen) + ' / semana';
  animateNumber(document.getElementById('kpi-inventario'), res.q, v=>fmtCOP(v));
  document.getElementById('kpi-inventario-sub').textContent = 'valor requerido por pedido';

  const cont = document.getElementById('semaforo');
  cont.innerHTML = '';
  DATA.dias.forEach(dia=>{
    const p = res.quiebrePorDiaPct[dia];
    let cls = 'good', label='Bajo riesgo';
    if (p >= 0.15){ cls='critical'; label='Alto riesgo'; }
    else if (p >= 0.05){ cls='warn'; label='Riesgo moderado'; }
    const div = document.createElement('div');
    div.className = 'semaforo-chip';
    div.title = label;
    div.innerHTML = `<div class="dia">${dia.slice(0,3)}</div><div class="dot ${cls}"></div><div class="pct">${fmtPct(p,0)}</div>`;
    cont.appendChild(div);
  });

  renderComparativo(document.getElementById('chart-comparativo'), window.__realSerie, res.traza, 365);
}

function renderTablaR(res){
  const tbody = document.querySelector('#tabla-r tbody');
  tbody.innerHTML = '';
  DATA.dias.forEach(dia=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${dia}</td><td class="num">${fmtCOP(res.rPorDia[dia])}</td><td class="num">${fmtCOP(res.q)}</td>`;
    tbody.appendChild(tr);
  });
  animateNumber(document.getElementById('kpi-quiebre'), res.pctQuiebre, v=>fmtPct(v));
  animateNumber(document.getElementById('kpi-pedidos'), res.pedidosSemana, v=>v.toFixed(2)+' pedidos/semana');
  renderTrayectoria(document.getElementById('chart-trayectoria'), res.traza, 365);
  renderConvergencia(res.convergencia);
  renderCostos(res);
}

function renderMenuTabla(){
  const tbody = document.querySelector('#tabla-menu tbody');
  tbody.innerHTML = '';
  DATA.menu.forEach(item=>{
    if (!(item.producto in state.menuActivos)) state.menuActivos[item.producto] = true;
    if (!(item.producto in state.menuPrecios)) state.menuPrecios[item.producto] = item.precio_cop;
    const activo = state.menuActivos[item.producto];
    const tr = document.createElement('tr');
    tr.className = activo ? '' : 'dish-off';
    tr.innerHTML = `
      <td><label class="toggle"><input type="checkbox" data-producto="${item.producto}" class="chk-dish" aria-label="Activar o desactivar ${item.producto}" ${activo?'checked':''}></label></td>
      <td>${item.producto}<br><span style="color:var(--muted); font-size:.74rem">${item.categoria}</span></td>
      <td class="num"><input type="number" min="0" step="100" data-producto="${item.producto}" class="inp-precio" value="${state.menuPrecios[item.producto]}"></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.chk-dish').forEach(el=> el.addEventListener('change', e=>{
    const activosRestantes = DATA.menu.filter(m=> m.producto===e.target.dataset.producto ? e.target.checked : state.menuActivos[m.producto]).length;
    if (!e.target.checked && activosRestantes===0){
      e.target.checked = true;
      showToast('Debe quedar al menos un plato activo');
      return;
    }
    state.menuActivos[e.target.dataset.producto] = e.target.checked;
    renderMenuTabla(); recalcular();
  }));
  tbody.querySelectorAll('.inp-precio').forEach(el=> el.addEventListener('input', debounce(e=>{
    state.menuPrecios[e.target.dataset.producto] = Math.max(0, parseFloat(e.target.value)||0);
    recalcular();
  },150)));
  renderCartaComposicion();
}

function renderEscenarios(){
  ['A','B'].forEach(slot=>{
    const el = document.getElementById('escenario-'+slot);
    const sc = scenarios[slot];
    if (!sc){ el.classList.remove('has-data'); el.innerHTML = `<h3>Escenario ${slot} <span></span></h3><p class="scenario-empty">Vacío — ajusta los controles y pulsa "Guardar como ${slot}".</p>`; return; }
    el.classList.add('has-data');
    const r = sc.result;
    el.innerHTML = `
      <h3>Escenario ${slot} <button class="btn ghost" data-clear="${slot}" style="padding:4px 9px; font-size:.72rem">Borrar</button></h3>
      <p class="sub" style="font-size:.78rem; color:var(--muted); margin-bottom:10px">
        Factor Q ${sc.state.factor.toFixed(1)}x · Nivel ${Math.round(sc.state.nivel*100)}% ·
        Demanda ${sc.state.demandaSlider.toFixed(2)}x · ${ESTACION_LABEL[sc.state.estacion]} ·
        Merma ${fmtPct(sc.state.mermaPct,0)}
      </p>
      <table>
        <tr><td>Nivel de servicio</td><td class="num">${fmtPct(r.nivelServicio)}</td></tr>
        <tr><td>Días con quiebre</td><td class="num">${fmtPct(r.pctQuiebre)}</td></tr>
        <tr><td>Costo total/semana</td><td class="num">${fmtCOP(r.costoTotalSemanal)}</td></tr>
        <tr><td>Margen simulado</td><td class="num">${fmtPct(r.margenPct)}</td></tr>
        <tr><td>Valor inventario (Q)</td><td class="num">${fmtCOP(r.q)}</td></tr>
        <tr><td>Utilidad operacional (año)</td><td class="num" style="color:${r.resultadoAnual.utilidadOperacional<0?'var(--critical)':'inherit'}">${fmtCOP(r.resultadoAnual.utilidadOperacional)}</td></tr>
      </table>`;
    el.querySelector('[data-clear]')?.addEventListener('click', ()=>{ scenarios[slot]=null; renderEscenarios(); });
  });
}

function renderContexto(){
  const P = DATA.patron_semanal;
  renderBarChart(document.getElementById('chart-semanal'), DATA.dias, P.media, P.std);
  const E = DATA.estacionalidad;
  renderGroupedBar(document.getElementById('chart-estacionalidad'), E.meses, E.pct_bachue, E.repr_global, { fmt:(v)=>fmtPct(v,1), nameA:'% real de Bachué', nameB:'REPR% global (empresa)' });
  const idxFinde=[5,6], idxSemana=[0,1,2,3,4];
  const finde = idxFinde.reduce((s,i)=>s+P.media[i],0)/idxFinde.length;
  const semana = idxSemana.reduce((s,i)=>s+P.media[i],0)/idxSemana.length;
  document.getElementById('ctx-finde').textContent = fmtCOP(finde);
  document.getElementById('ctx-semana').textContent = fmtCOP(semana);
  document.getElementById('ctx-uplift').textContent = '+'+Math.round((finde/semana-1)*100)+'%';
}

function recalcular(){
  // Si el usuario mueve un control what-if a medio vuelo de la reproduccion,
  // cancela la animacion en curso antes de reconstruir el grafico: seguir
  // animando sobre nodos SVG que renderTrayectoria() va a reemplazar rompe
  // la reproduccion (nodos removidos del DOM a medio camino).
  cancelarReproduccion();

  document.getElementById('lbl-factor').textContent = state.factor.toFixed(1)+'x';
  document.getElementById('lbl-nivel').textContent = Math.round(state.nivel*100)+'%';
  document.getElementById('lbl-demanda').textContent = state.demandaSlider.toFixed(2)+'x';
  document.getElementById('lbl-merma').textContent = fmtPct(state.mermaPct,0);
  document.getElementById('lbl-impuesto').textContent = fmtPct(state.impuestoPct,0);
  document.getElementById('lbl-comision').textContent = fmtPct(state.comisionDomicilioPct,0);
  document.getElementById('lbl-mult-efectivo').textContent = demandaEfectiva().toFixed(2)+'x';

  const res = ejecutarSimulacion();
  renderResumen(res);
  renderTablaR(res);
  renderResultadoAnual(res);
}

function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

// ---------------------------------------------------------------------------
// Exportar CSV
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Exportar Excel (libro completo con todo lo que esta calculando el
// simulador en este momento: parametros, R/Q, estabilidad, resultado
// anual, trayectoria dia a dia con fecha real, tablas de frecuencia de
// los 7 dias, y el menu activo).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Exportación a Excel (ExcelJS): colores, fuentes, formatos numéricos nativos,
// formato condicional (barras de datos / escalas de color) y gráficos
// incrustados como imágenes (ExcelJS no expone objetos de gráfico nativos de
// Excel en su API gratuita: se verificó empíricamente que `addChart` no
// existe; `addImage` sí, así que los "gráficos" se dibujan en <canvas> y se
// incrustan como imagen PNG real dentro de la hoja).
// ---------------------------------------------------------------------------

const XL_COLOR = {
  header: 'FF2563EB', header2: 'FF7C3AED', headerFont: 'FFFFFFFF',
  title: 'FF1D4ED8', sub: 'FF475569',
  good: 'FF15803D', goodFill: 'FFD1FAE5', goodFont: 'FF065F46',
  bad: 'FFDC2626', badFill: 'FFFEE2E2', badFont: 'FF991B1B',
  warn: 'FFB45309', warnFill: 'FFFEF3C7', warnFont: 'FF92400E',
  zebra: 'FFF1F5F9', border: 'FFCBD5E1', infoFill: 'FFDBEAFE', infoFont: 'FF1E3A8A',
  diaColores: ['FFDBEAFE','FFEDE9FE','FFD1FAE5','FFFEF3C7','FFFFE4E6','FFE0F2FE','FFE2E8F0'],
};
const FMT_COP = '"$"#,##0';
const FMT_PCT1 = '0.0%';
const FMT_PCT2 = '0.00%';
const FMT_NUM = '#,##0.00';

function fechaUTC(yyyyMmDd){
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function xlColLetra(n){
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function xlEstilizarEncabezado(row, fillArgb){
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: XL_COLOR.headerFont }, size: 11, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb || XL_COLOR.header } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFFFFFFF' } } };
  });
  row.height = 24;
}

function xlTitulo(ws, texto, nCols, subtitulo){
  ws.mergeCells(1, 1, 1, Math.max(nCols, 2));
  const t = ws.getCell(1, 1);
  t.value = texto;
  t.font = { bold: true, size: 14, color: { argb: XL_COLOR.title }, name: 'Calibri' };
  ws.getRow(1).height = 26;
  if (subtitulo){
    ws.mergeCells(2, 1, 2, Math.max(nCols, 2));
    const s = ws.getCell(2, 1);
    s.value = subtitulo;
    s.font = { italic: true, size: 9.5, color: { argb: XL_COLOR.sub }, name: 'Calibri' };
  }
  ws.getRow(3).height = 4;
}

// Tabla declarativa: fila 1 título, fila 2 subtítulo, fila 3 espaciadora,
// fila 4 encabezado, datos desde la fila 5. Devuelve filas útiles para poder
// aplicar formato condicional / gráficos después.
function xlCrearHojaTabla(wb, nombre, titulo, subtitulo, columnas, filas, opts){
  opts = opts || {};
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4 }] });
  const nCols = columnas.length;
  xlTitulo(ws, titulo, nCols, subtitulo);

  const headerRowIdx = 4;
  columnas.forEach((col, i) => { ws.getCell(headerRowIdx, i + 1).value = col.header; });
  xlEstilizarEncabezado(ws.getRow(headerRowIdx), opts.fillHeader);
  columnas.forEach((col, i) => { ws.getColumn(i + 1).width = col.width || 18; });

  filas.forEach((fila, idx) => {
    const r = headerRowIdx + 1 + idx;
    columnas.forEach((col, i) => {
      const cell = ws.getCell(r, i + 1);
      const v = fila[col.key];
      cell.value = v;
      cell.font = { name: 'Calibri', size: 10.5 };
      cell.alignment = { vertical: 'middle', horizontal: col.align || (typeof v === 'number' ? 'right' : 'left') };
      cell.border = { bottom: { style: 'hair', color: { argb: XL_COLOR.border } } };
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (idx % 2 === 1 && !opts.sinZebra) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.zebra } };
      if (col.pintar) col.pintar(cell, fila, r);
    });
  });

  if (filas.length){
    ws.autoFilter = { from: { row: headerRowIdx, column: 1 }, to: { row: headerRowIdx, column: nCols } };
  }
  return { ws, headerRowIdx, firstDataRow: headerRowIdx + 1, lastDataRow: headerRowIdx + filas.length, nCols };
}

function xlBarraDatos(ws, rango, colorArgb){
  ws.addConditionalFormatting({ ref: rango, rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: colorArgb || XL_COLOR.header } }] });
}
function xlEscalaColor(ws, rango, colorBajo, colorAlto){
  ws.addConditionalFormatting({ ref: rango, rules: [{ type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: colorBajo || 'FFF8696B' }, { argb: colorAlto || 'FF63BE7B' }] }] });
}
function xlResaltarSiTexto(ws, rango, colFormulaAbsoluta, textoIgual, fillArgb, fontArgb){
  ws.addConditionalFormatting({
    ref: rango,
    rules: [{ type: 'expression', formulae: [`$${colFormulaAbsoluta}="${textoIgual}"`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: fillArgb } }, font: { color: { argb: fontArgb }, bold: true } } }],
  });
}
function xlResaltarSiNumeroCero(ws, rango, colFormulaAbsoluta, fillArgb, fontArgb){
  ws.addConditionalFormatting({
    ref: rango,
    rules: [{ type: 'expression', formulae: [`$${colFormulaAbsoluta}=0`], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: fillArgb } }, font: { color: { argb: fontArgb }, italic: true } } }],
  });
}
// Dado un día, devuelve una función que ubica un costo_proteina dentro del
// intervalo de clase (Sturges) al que pertenece esa tabla de muestreo —
// el mismo texto que construye `construirFilasFrecuencia` para esa tabla.
function xlClasificarEnIntervalo(tabla){
  return function(valor){
    for (let i = 0; i < tabla.length; i++){
      const c = tabla[i];
      const esUltima = i === tabla.length - 1;
      if (valor >= c.limite_inf && (esUltima ? valor <= c.limite_sup : valor < c.limite_sup)){
        return `${fmtCOP(c.limite_inf)} – ${fmtCOP(c.limite_sup)}`;
      }
    }
    const borde = valor < tabla[0].limite_inf ? tabla[0] : tabla[tabla.length - 1];
    return `${fmtCOP(borde.limite_inf)} – ${fmtCOP(borde.limite_sup)}`;
  };
}

// ---- Gráficos dibujados a mano en <canvas> e incrustados como imagen PNG ----

function xlNuevoCanvas(w, h){
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'alphabetic';
  return { c, ctx };
}
function xlCanvasABase64(c){ return c.toDataURL('image/png').split(',')[1]; }

function xlDibujarBarras(w, h, titulo, items, formatoValor){
  const { c, ctx } = xlNuevoCanvas(w, h);
  ctx.fillStyle = '#1e293b'; ctx.font = 'bold 15px Calibri, Arial'; ctx.fillText(titulo, 14, 24);
  const padL = 56, padR = 18, padT = 44, padB = 48;
  const areaW = w - padL - padR, areaH = h - padT - padB;
  const maxV = Math.max(1, ...items.map(it => Math.abs(it.value)));
  const bw = areaW / items.length;
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT + areaH); ctx.lineTo(padL + areaW, padT + areaH); ctx.stroke();
  items.forEach((it, i) => {
    const bh = (Math.abs(it.value) / maxV) * (areaH - 20);
    const x = padL + i * bw + bw * 0.18;
    const bw2 = bw * 0.64;
    const y = padT + areaH - bh;
    ctx.fillStyle = it.color || '#2563EB';
    ctx.fillRect(x, y, bw2, bh);
    ctx.fillStyle = '#1e293b'; ctx.font = '10.5px Calibri, Arial'; ctx.textAlign = 'center';
    ctx.fillText(formatoValor ? formatoValor(it.value) : String(Math.round(it.value)), x + bw2 / 2, y - 6);
    ctx.font = '10.5px Calibri, Arial';
    const labelLines = String(it.label).split('\n');
    labelLines.forEach((ln, li) => ctx.fillText(ln, x + bw2 / 2, padT + areaH + 16 + li * 12));
  });
  ctx.textAlign = 'left';
  return xlCanvasABase64(c);
}

function xlDibujarLinea(w, h, titulo, serie, quiebreIdx){
  const { c, ctx } = xlNuevoCanvas(w, h);
  ctx.fillStyle = '#1e293b'; ctx.font = 'bold 15px Calibri, Arial'; ctx.fillText(titulo, 14, 24);
  const padL = 60, padR = 18, padT = 40, padB = 28;
  const areaW = w - padL - padR, areaH = h - padT - padB;
  const maxV = Math.max(1, ...serie);
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++){
    const y = padT + areaH - (g / 4) * areaH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + areaW, y); ctx.stroke();
    ctx.fillStyle = '#64748b'; ctx.font = '9.5px Calibri, Arial';
    ctx.fillText(fmtCOPCompact(maxV * g / 4), 4, y + 3);
  }
  ctx.strokeStyle = '#2563EB'; ctx.lineWidth = 1.6; ctx.beginPath();
  serie.forEach((v, i) => {
    const x = padL + (i / (serie.length - 1)) * areaW;
    const y = padT + areaH - (v / maxV) * areaH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#dc2626';
  (quiebreIdx || []).forEach(i => {
    const x = padL + (i / (serie.length - 1)) * areaW;
    const y = padT + areaH - (serie[i] / maxV) * areaH;
    ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = '#475569'; ctx.font = '10px Calibri, Arial';
  ctx.fillText('Día 1', padL, padT + areaH + 18);
  ctx.textAlign = 'right';
  ctx.fillText('Día 365', padL + areaW, padT + areaH + 18);
  ctx.textAlign = 'left';
  return xlCanvasABase64(c);
}

function xlDibujarDonut(w, h, titulo, items){
  const { c, ctx } = xlNuevoCanvas(w, h);
  ctx.fillStyle = '#1e293b'; ctx.font = 'bold 15px Calibri, Arial'; ctx.fillText(titulo, 14, 24);
  // Se sanea cada it.value a 0 si no es finito (NaN/Infinity): si no, "NaN || 1"
  // confunde un total NaN con uno legitimamente en cero (NaN es falsy en JS).
  items = items.map(it => ({ ...it, value: Number.isFinite(it.value) ? it.value : 0 }));
  const sumaValida = items.reduce((s, it) => s + Math.max(0, it.value), 0);
  const total = sumaValida > 0 ? sumaValida : 1;
  const cx = h / 2 + 20, cy = h / 2 + 14, rOut = Math.min(h, w * 0.46) / 2 - 10, rIn = rOut * 0.55;
  let ang = -Math.PI / 2;
  items.forEach(it => {
    const frac = Math.max(0, it.value) / total;
    const a1 = ang + frac * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rOut, ang, a1);
    ctx.closePath(); ctx.fillStyle = it.color; ctx.fill();
    ang = a1;
  });
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(cx, cy, rIn, 0, Math.PI * 2); ctx.fill();
  let ly = 48;
  const lx = h + 16;
  items.forEach(it => {
    ctx.fillStyle = it.color; ctx.fillRect(lx, ly - 9, 10, 10);
    ctx.fillStyle = '#1e293b'; ctx.font = '10.5px Calibri, Arial';
    ctx.fillText(`${it.label}  (${fmtPct(Math.max(0, it.value) / total)})`, lx + 15, ly);
    ly += 18;
  });
  return xlCanvasABase64(c);
}

function xlAgregarImagen(wb, ws, base64, col, row, wPx, hPx){
  const id = wb.addImage({ base64, extension: 'png' });
  ws.addImage(id, { tl: { col, row }, ext: { width: wPx, height: hPx } });
}

async function exportarExcel(){
  if (typeof ExcelJS === 'undefined'){ showToast('No se pudo cargar la librería de Excel (sin conexión a internet)'); return; }
  const btn = document.getElementById('btn-export-excel');
  if (btn) btn.disabled = true;
  try {
    const res = ultimo || ejecutarSimulacion();
    const ra = res.resultadoAnual;
    const base = calcularBaselineSinCalibrar();
    const c = res.convergencia;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Simulador Bachué';
    wb.created = new Date();

    // ---------------- Portada / Dashboard ----------------
    const port = wb.addWorksheet('Portada', { views: [{ showGridLines: false }] });
    port.mergeCells('A1:H2');
    const tPort = port.getCell('A1');
    tPort.value = 'Simulación de inventario — Restaurante Bachué (Girardot, Cundinamarca)';
    tPort.font = { bold: true, size: 17, color: { argb: XL_COLOR.title }, name: 'Calibri' };
    tPort.alignment = { vertical: 'middle' };
    port.mergeCells('A3:H3');
    port.getCell('A3').value = `Generado ${new Date().toLocaleString('es-CO')} · Modelo (Q,R) con punto de reorden empírico y calibración por simulación Monte Carlo (${c.replicas} réplicas × 365 días)`;
    port.getCell('A3').font = { italic: true, size: 10, color: { argb: XL_COLOR.sub } };

    const kpis = [
      { label: 'Tasa de llenado ($ servido / $ demandado)', valor: fmtPct(res.nivelServicio), fill: XL_COLOR.goodFill, font: XL_COLOR.goodFont },
      { label: 'Nivel de servicio por día (1 − % días con quiebre)', valor: fmtPct(res.nivelServicioCiclo), fill: XL_COLOR.infoFill, font: XL_COLOR.infoFont },
      { label: 'Q calibrado por pedido', valor: fmtCOP(res.q), fill: 'FFEDE9FE', font: 'FF5B21B6' },
      { label: 'Factor de calibración sobre Q teórico EOQ', valor: state.factor.toFixed(2) + '×', fill: 'FFE0F2FE', font: 'FF075985' },
      { label: 'Utilidad operacional proyectada (año)', valor: fmtCOP(ra.utilidadOperacional), fill: XL_COLOR.goodFill, font: XL_COLOR.goodFont },
      { label: 'Venta perdida por quiebres (año)', valor: fmtCOP(ra.ventaPerdidaAnual), fill: XL_COLOR.badFill, font: XL_COLOR.badFont },
    ];
    let kr = 5;
    kpis.forEach((k, i) => {
      const col0 = 1 + (i % 2) * 4;
      const row0 = kr + Math.floor(i / 2) * 3;
      port.mergeCells(row0, col0, row0, col0 + 3);
      port.mergeCells(row0 + 1, col0, row0 + 2, col0 + 3);
      const lbl = port.getCell(row0, col0);
      lbl.value = k.label; lbl.font = { size: 9.5, bold: true, color: { argb: 'FF475569' } };
      const val = port.getCell(row0 + 1, col0);
      val.value = k.valor; val.font = { size: 20, bold: true, color: { argb: k.font } };
      val.alignment = { vertical: 'middle', horizontal: 'center' };
      for (let rr = row0; rr <= row0 + 2; rr++) for (let cc = col0; cc <= col0 + 3; cc++) port.getCell(rr, cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: k.fill } };
    });
    for (let i = 1; i <= 8; i++) port.getColumn(i).width = 11;

    const donutItems = [
      { label: 'Costo materia prima', value: ra.costoMateriaPrima, color: '#2563EB' },
      { label: 'Impuesto al consumo', value: ra.impuesto, color: '#7C3AED' },
      { label: 'Comisión domicilios', value: ra.comisionDomicilios, color: '#B45309' },
      { label: 'Costo logístico (inventario)', value: ra.costoLogistico, color: '#DC2626' },
      { label: 'Utilidad operacional', value: Math.max(0, ra.utilidadOperacional), color: '#15803D' },
    ];
    const donutB64 = xlDibujarDonut(560, 230, 'Desglose de ventas brutas anuales (COP)', donutItems);
    xlAgregarImagen(wb, port, donutB64, 0, 14, 560, 230);
    port.mergeCells('A32:H33');
    port.getCell('A32').value = '¿Términos poco claros? Ve a la pestaña "Glosario". Pestañas: Resumen de parámetros · Punto de reorden (R) · Estabilidad de la simulación · Resultado anual (P&L) · Trayectoria simulada día a día (365 días) · Tablas de frecuencia por día (Sturges) · Ventas reales históricas 2025 (365 días) · Carta/menú · Escenarios A/B.';
    port.getCell('A32').font = { size: 9, italic: true, color: { argb: 'FF64748B' } };
    port.getCell('A32').alignment = { wrapText: true };

    // ---------------- Glosario / guía de lectura ----------------
    const guia = [
      { pregunta: '¿Cuánto debo pedir y cuándo hacer el pedido?', hoja: 'Punto_Reorden' },
      { pregunta: '¿Cuánta plata voy a ganar/perder en el año?', hoja: 'Resultado_Anual' },
      { pregunta: '¿Qué tan confiable es la simulación (no es solo un número de suerte)?', hoja: 'Estabilidad_Replicas' },
      { pregunta: '¿De dónde salen los números de demanda que usa el modelo?', hoja: 'Frecuencias_por_dia y Ventas_Reales_2025' },
      { pregunta: '¿Qué pasó día por día dentro de la simulación (cuándo hubo quiebres)?', hoja: 'Trayectoria_365_dias' },
      { pregunta: '¿Qué productos se vendieron y a qué precio?', hoja: 'Menu_Carta' },
      { pregunta: 'Quiero ver todo resumido en una sola pantalla', hoja: 'Portada' },
    ];
    const glosario = [
      { termino: 'EOQ / Q teórico', significa: 'Cantidad económica de pedido: el monto (en $) que conviene comprar cada vez, calculado con la fórmula clásica de teoría de inventarios, antes de ajustarlo con la simulación.' },
      { termino: 'Q calibrado', significa: 'El Q teórico multiplicado por un "factor de calibración" que se encontró probando distintos valores en la simulación, porque el Q teórico solo (de libro) no alcanzaba el nivel de servicio deseado.' },
      { termino: 'Punto de reorden (R)', significa: 'El nivel de inventario al que, cuando se llega, hay que hacer un nuevo pedido — para que llegue antes de quedarse sin producto, considerando el tiempo de entrega (lead time).' },
      { termino: 'Lead time', significa: 'Los días que tarda en llegar un pedido desde que se hace hasta que está disponible para vender.' },
      { termino: 'Quiebre de stock', significa: 'Un día en el que la demanda de los clientes superó el inventario disponible: hubo ventas que no se pudieron atender.' },
      { termino: 'Tasa de llenado (nivel de servicio)', significa: 'Del total de $ que los clientes quisieron comprar, qué % sí se logró vender. Si es 95%, de cada $100 de demanda se perdieron $5 por quiebres.' },
      { termino: 'Nivel de servicio por día', significa: 'De los 365 días del año, en qué % NO hubo ningún quiebre. Es distinto a la tasa de llenado: un solo día malo cuenta igual que un día con un quiebre enorme.' },
      { termino: '% días con quiebre', significa: 'El complemento del anterior: de los 365 días, en qué % sí hubo al menos un quiebre de stock.' },
      { termino: 'Simulación Monte Carlo / réplicas', significa: 'En vez de calcular con una sola fórmula, el modelo "juega" la operación del restaurante miles de veces con demanda aleatoria (pero realista, basada en datos reales) y promedia los resultados — así se mide qué tan estable es la estrategia de inventario, no solo un escenario de suerte.' },
      { termino: 'Burn-in', significa: 'Los primeros días de cada simulación se descartan del resultado final porque el sistema "arranca en frío" (sin inventario acumulado todavía) y no son representativos de la operación normal.' },
      { termino: 'IC 95% de la media (error estándar)', significa: 'Un rango que dice: "si repitiéramos este experimento muchas veces, el verdadero nivel de servicio promedio esperado estaría casi siempre dentro de este rango". Mide la precisión de la ESTIMACIÓN, no la suerte de un año puntual.' },
      { termino: 'Percentil 5-95 entre réplicas', significa: 'Diferente al anterior: describe qué tan bueno o malo puede ser UN año cualquiera (no el promedio). El 90% de los años simulados caen dentro de este rango.' },
      { termino: 'Intervalo de clase (Sturges) / frecuencia', significa: 'Para estimar la demanda de un día cualquiera, se agrupan las ventas históricas reales de ese día de la semana en "rangos" (intervalos). La frecuencia dice qué tan seguido cayó la venta real en cada rango — eso es lo que usa la simulación para generar demanda aleatoria realista.' },
      { termino: 'Costo proteína equivalente', significa: 'La venta total del día convertida a su equivalente en costo de materia prima (proteína), aplicando los % de participación de proteína y de costo de materia prima sobre la venta. Es la unidad en la que trabaja todo el modelo de inventario.' },
      { termino: 'Factor de calibración de Q', significa: 'Cuántas veces más grande es el Q que realmente se usa, comparado con el Q teórico de la fórmula EOQ. Se ajusta manualmente en el simulador (slider) para ver su efecto en servicio vs. costo.' },
      { termino: 'Impuesto al consumo (INC)', significa: 'El impuesto que aplica a un restaurante independiente en Colombia (distinto del IVA, que aplicaría si fuera una franquicia de una marca de terceros).' },
      { termino: 'Comisión domicilios', significa: 'El % que se queda la plataforma de entrega (Rappi, etc.) por cada venta hecha por ese canal; no hay una cifra oficial única, así que es un supuesto editable.' },
      { termino: 'Margen simulado', significa: 'Lo que queda de la venta real después de restar el costo de materia prima y el costo de inventario (mantener + ordenar), como % de la venta real.' },
    ];

    const gloss = wb.addWorksheet('Glosario', { views: [{ showGridLines: false }] });
    gloss.mergeCells('A1:C1');
    gloss.getCell('A1').value = 'Glosario y guía de lectura';
    gloss.getCell('A1').font = { bold: true, size: 15, color: { argb: XL_COLOR.title } };
    gloss.mergeCells('A2:C2');
    gloss.getCell('A2').value = 'Pensado para cualquier persona, sin trasfondo técnico, que abra este archivo por primera vez.';
    gloss.getCell('A2').font = { italic: true, size: 9.5, color: { argb: XL_COLOR.sub } };

    gloss.mergeCells('A4:B4');
    gloss.getCell('A4').value = '¿Qué hoja mirar si quieres saber...?';
    gloss.getCell('A4').font = { bold: true, size: 12, color: { argb: XL_COLOR.title } };
    gloss.getCell('A5').value = 'Pregunta'; gloss.getCell('B5').value = 'Hoja a consultar';
    xlEstilizarEncabezado(gloss.getRow(5), XL_COLOR.header2);
    guia.forEach((g, i) => {
      const r = 6 + i;
      gloss.getCell(r, 1).value = g.pregunta; gloss.getCell(r, 2).value = g.hoja;
      gloss.getCell(r, 1).alignment = { wrapText: true, vertical: 'middle' };
      gloss.getCell(r, 2).font = { bold: true, color: { argb: XL_COLOR.header } };
      gloss.getCell(r, 2).alignment = { vertical: 'middle' };
      if (i % 2 === 1){ gloss.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.zebra } }; gloss.getCell(r, 2).fill = gloss.getCell(r, 1).fill; }
      gloss.getRow(r).height = 28;
    });

    const glosarioStart = 6 + guia.length + 2;
    gloss.mergeCells(glosarioStart, 1, glosarioStart, 2);
    gloss.getCell(glosarioStart, 1).value = 'Glosario de términos técnicos';
    gloss.getCell(glosarioStart, 1).font = { bold: true, size: 12, color: { argb: XL_COLOR.title } };
    const glosHeaderRow = glosarioStart + 1;
    gloss.getCell(glosHeaderRow, 1).value = 'Término'; gloss.getCell(glosHeaderRow, 2).value = 'Qué significa, en palabras simples';
    xlEstilizarEncabezado(gloss.getRow(glosHeaderRow), XL_COLOR.header);
    glosario.forEach((g, i) => {
      const r = glosHeaderRow + 1 + i;
      gloss.getCell(r, 1).value = g.termino; gloss.getCell(r, 1).font = { bold: true, size: 10.5 };
      gloss.getCell(r, 2).value = g.significa; gloss.getCell(r, 2).font = { size: 10.5 };
      gloss.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' };
      gloss.getCell(r, 2).alignment = { wrapText: true, vertical: 'top' };
      if (i % 2 === 1){ gloss.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.zebra } }; gloss.getCell(r, 2).fill = gloss.getCell(r, 1).fill; }
      gloss.getRow(r).height = 46;
    });
    gloss.getColumn(1).width = 34;
    gloss.getColumn(2).width = 62;
    gloss.getColumn(3).width = 2;
    gloss.views = [{ state: 'frozen', ySplit: 5, showGridLines: false }];

    // ---------------- Resumen ----------------
    const filasResumen = [
      { parametro: 'Tienda', valor: 'Bachué (Girardot, Cundinamarca)', tipo: 'text' },
      { parametro: 'Factor de calibración de Q', valor: state.factor, tipo: 'num' },
      { parametro: 'Nivel de servicio objetivo (para R)', valor: state.nivel, tipo: 'pct' },
      { parametro: 'Ajuste de demanda (slider)', valor: state.demandaSlider, tipo: 'num' },
      { parametro: 'Estacionalidad', valor: ESTACION_LABEL[state.estacion], tipo: 'text' },
      { parametro: 'Merma %', valor: state.mermaPct, tipo: 'pct' },
      { parametro: 'Impuesto al consumo %', valor: state.impuestoPct, tipo: 'pct' },
      { parametro: 'Comisión domicilios %', valor: state.comisionDomicilioPct, tipo: 'pct' },
      { parametro: 'Multiplicador de demanda efectivo', valor: demandaEfectiva(), tipo: 'num' },
      { parametro: 'Q teórico EOQ (COP)', valor: Math.round(DATA.parametros.q_teorico), tipo: 'money' },
      { parametro: 'Q calibrado (COP)', valor: Math.round(res.q), tipo: 'money' },
      { parametro: 'Nivel de servicio (tasa de llenado)', valor: res.nivelServicio, tipo: 'pct' },
      { parametro: 'Nivel de servicio por día (1 − % días con quiebre)', valor: res.nivelServicioCiclo, tipo: 'pct' },
      { parametro: 'Costo total proyectado (COP/semana)', valor: Math.round(res.costoTotalSemanal), tipo: 'money' },
      { parametro: 'Margen simulado %', valor: res.margenPct, tipo: 'pct' },
    ];
    const { ws: wsResumen } = xlCrearHojaTabla(wb, 'Resumen', 'Parámetros de la simulación', `Generado ${new Date().toLocaleString('es-CO')}`,
      [{ header: 'Parámetro', key: 'parametro', width: 46 }, { header: 'Valor', key: 'valor', width: 22,
        pintar: (cell, fila) => { cell.numFmt = fila.tipo === 'money' ? FMT_COP : fila.tipo === 'pct' ? FMT_PCT1 : fila.tipo === 'num' ? FMT_NUM : undefined; } }],
      filasResumen);
    wsResumen.getColumn(2).alignment = { horizontal: 'right' };

    // ---------------- Punto de reorden ----------------
    const filasR = DATA.dias.map(dia => ({ dia, r: Math.round(res.rPorDia[dia]), q: Math.round(res.q) }));
    const tR = xlCrearHojaTabla(wb, 'Punto_Reorden', 'Punto de reorden (R) y cantidad a pedir (Q)', 'R calculado de forma empírica (percentil de demanda en lead time, mezcla 80% 2 días / 20% 3 días) · Q calibrado por simulación',
      [{ header: 'Día de pedido', key: 'dia', width: 18 },
       { header: 'Punto de reorden R (COP)', key: 'r', width: 24, numFmt: FMT_COP },
       { header: 'Cantidad a pedir Q (COP)', key: 'q', width: 24, numFmt: FMT_COP }],
      filasR);
    xlBarraDatos(tR.ws, `B${tR.firstDataRow}:B${tR.lastDataRow}`, XL_COLOR.header);
    const barrasR = xlDibujarBarras(560, 300, 'Punto de reorden R por día (COP)',
      DATA.dias.map(d => ({ label: d.slice(0, 3), value: res.rPorDia[d], color: '#2563EB' })), v => fmtCOPCompact(v));
    xlAgregarImagen(wb, tR.ws, barrasR, 4, 3, 560, 300);

    // ---------------- Estabilidad de la simulación ----------------
    const filasEstab = [
      { metrica: 'Réplicas simuladas', valor: c.replicas, tipo: 'num0' },
      { metrica: 'Media (nivel de servicio)', valor: c.media, tipo: 'pct2' },
      { metrica: 'Desviación estándar entre réplicas', valor: c.desvEst, tipo: 'pct2' },
      { metrica: 'Error estándar de la media', valor: c.errorEstandar, tipo: 'pct2' },
      { metrica: 'IC 95% de la media — límite inferior', valor: c.ic95Inf, tipo: 'pct2' },
      { metrica: 'IC 95% de la media — límite superior', valor: c.ic95Sup, tipo: 'pct2' },
      { metrica: 'Percentil 5 entre réplicas (1 año individual)', valor: c.p5, tipo: 'pct2' },
      { metrica: 'Percentil 95 entre réplicas (1 año individual)', valor: c.p95, tipo: 'pct2' },
    ];
    const tEstab = xlCrearHojaTabla(wb, 'Estabilidad_Replicas', 'Estabilidad de la simulación Monte Carlo', `${c.replicas} réplicas independientes de 365 días (burn-in de 30 días descartado)`,
      [{ header: 'Métrica', key: 'metrica', width: 44 },
       { header: 'Valor', key: 'valor', width: 20, pintar: (cell, fila) => { cell.numFmt = fila.tipo === 'num0' ? '#,##0' : FMT_PCT2; } }],
      filasEstab);
    tEstab.ws.mergeCells(tEstab.lastDataRow + 2, 1, tEstab.lastDataRow + 5, 6);
    const nota = tEstab.ws.getCell(tEstab.lastDataRow + 2, 1);
    nota.value = 'Nota metodológica: el "IC 95% de la media" (filas 5-6) describe la incertidumbre sobre el nivel de servicio ESPERADO a largo plazo, vía el Teorema del Límite Central (media ± 1.96×error estándar). El "percentil 5-95 entre réplicas" (filas 7-8) es un intervalo de predicción: describe la dispersión que puede tener UN año individual cualquiera. Son conceptos distintos y no deben confundirse.';
    nota.font = { italic: true, size: 9.5, color: { argb: XL_COLOR.infoFont } };
    nota.alignment = { wrapText: true, vertical: 'top' };
    nota.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.infoFill } };

    // ---------------- Resultado anual (P&L) ----------------
    const filasRA = [
      { concepto: 'Ventas brutas facturadas (año)', valor: ra.ventasBrutas, tipo: 'total' },
      { concepto: `(−) Impuesto al consumo (${fmtPct(state.impuestoPct, 0)})`, valor: -ra.impuesto, tipo: 'cost' },
      { concepto: '= Ingreso operacional neto', valor: ra.ingresoNeto, tipo: 'total' },
      { concepto: `(−) Costo materia prima (${fmtPct(DATA.parametros.food_cost_pct, 0)})`, valor: -ra.costoMateriaPrima, tipo: 'cost' },
      { concepto: '= Utilidad bruta', valor: ra.utilidadBruta, tipo: 'total' },
      { concepto: '(−) Comisión domicilios', valor: -ra.comisionDomicilios, tipo: 'cost' },
      { concepto: '(−) Costo de inventario (mantener + ordenar)', valor: -ra.costoLogistico, tipo: 'cost' },
      { concepto: '= Utilidad operacional del año (sistema calibrado)', valor: ra.utilidadOperacional, tipo: 'final' },
      { concepto: 'Venta perdida por quiebres de stock (año)', valor: ra.ventaPerdidaAnual, tipo: 'info' },
    ];
    const tRA = xlCrearHojaTabla(wb, 'Resultado_Anual', 'Estado de resultados simulado (año)', 'Precios de lista incluyen impuesto al consumo · 52 semanas',
      [{ header: 'Concepto', key: 'concepto', width: 50 },
       { header: 'Valor (COP)', key: 'valor', width: 22, numFmt: FMT_COP,
         pintar: (cell, fila) => {
           if (fila.tipo === 'cost'){ cell.font = { color: { argb: XL_COLOR.badFont }, size: 10.5 }; }
           if (fila.tipo === 'total'){ cell.font = { bold: true, size: 10.5 }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.zebra } }; }
           if (fila.tipo === 'final'){ cell.font = { bold: true, size: 11.5, color: { argb: XL_COLOR.goodFont } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.goodFill } }; }
           if (fila.tipo === 'info'){ cell.font = { italic: true, color: { argb: XL_COLOR.badFont } }; }
         } }],
      filasRA, { sinZebra: true });
    filasRA.forEach((f, idx) => { if (f.tipo === 'total' || f.tipo === 'final') tRA.ws.getCell(tRA.firstDataRow + idx, 1).font = { bold: true }; });

    const filasComp = [
      { concepto: 'EOQ puro de fórmula (factor 1.0×) — nivel de servicio', calibrado: res.nivelServicio, base: base.nivelServicio, tipo: 'pct' },
      { concepto: 'Utilidad operacional (año)', calibrado: ra.utilidadOperacional, base: base.utilidadOperacional, tipo: 'money' },
    ];
    const compStart = tRA.lastDataRow + 3;
    tRA.ws.mergeCells(compStart, 1, compStart, 3);
    tRA.ws.getCell(compStart, 1).value = 'Comparación: configuración actual vs. EOQ puro de fórmula (factor 1.0×, el valor por defecto)';
    tRA.ws.getCell(compStart, 1).font = { bold: true, size: 11, color: { argb: XL_COLOR.title } };
    const compHeaderRow = compStart + 1;
    ['Indicador', 'Configuración actual', 'EOQ puro (1.0×)'].forEach((h, i) => { tRA.ws.getCell(compHeaderRow, i + 1).value = h; });
    xlEstilizarEncabezado(tRA.ws.getRow(compHeaderRow), XL_COLOR.header2);
    filasComp.forEach((f, idx) => {
      const r = compHeaderRow + 1 + idx;
      tRA.ws.getCell(r, 1).value = f.concepto;
      const cCal = tRA.ws.getCell(r, 2); cCal.value = f.calibrado; cCal.numFmt = f.tipo === 'pct' ? FMT_PCT1 : FMT_COP;
      const cBase = tRA.ws.getCell(r, 3); cBase.value = f.base; cBase.numFmt = f.tipo === 'pct' ? FMT_PCT1 : FMT_COP;
      cCal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.goodFill } }; cCal.font = { bold: true, color: { argb: XL_COLOR.goodFont } };
      cBase.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.warnFill } }; cBase.font = { color: { argb: XL_COLOR.warnFont } };
    });

    const barrasRA = xlDibujarBarras(560, 300, 'Hitos del estado de resultados (COP)',
      [{ label: 'Ventas\nbrutas', value: ra.ventasBrutas, color: '#2563EB' },
       { label: 'Ingreso\nneto', value: ra.ingresoNeto, color: '#2563EB' },
       { label: 'Utilidad\nbruta', value: ra.utilidadBruta, color: '#2563EB' },
       { label: 'Utilidad\noperac.', value: ra.utilidadOperacional, color: '#15803D' },
       { label: 'Costo\nmat. prima', value: ra.costoMateriaPrima, color: '#DC2626' },
       { label: 'Costo\nlogístico', value: ra.costoLogistico, color: '#DC2626' }], v => fmtCOPCompact(v));
    xlAgregarImagen(wb, tRA.ws, barrasRA, 4, 0, 560, 300);

    // ---------------- Trayectoria 365 días ----------------
    const filasTray = res.traza.map((d, i) => {
      // d.diaSemana es el ciclo arbitrario Lunes-Domingo que usa el motor de
      // simulacion internamente (dia 0 = "Lunes"), sin relacion con el
      // calendario real. La columna "Fecha real 2025" SI es una fecha real,
      // asi que el dia de la semana mostrado debe salir de esa fecha (misma
      // formula que Ventas_Reales_2025), o quedaria desalineado en las 365
      // filas (ej. 2025-01-01 es miercoles, no "Lunes").
      const fecha = DATA.serie_diaria[i] ? fechaUTC(DATA.serie_diaria[i].fecha) : null;
      const diaSemanaReal = fecha ? DATA.dias[(fecha.getUTCDay() + 6) % 7] : d.diaSemana;
      return {
      diaNum: i + 1,
      fecha,
      diaSemana: diaSemanaReal,
      invAbrir: Math.round(d.inventarioInicio),
      posicion: Math.round(d.posicion),
      r: Math.round(d.R),
      pedido: d.pedidoColocado ? 'Sí' : 'No',
      leadTime: d.pedidoColocado ? d.pedidoLeadTime : null,
      demanda: Math.round(d.demanda),
      invCerrar: Math.round(d.inventario),
      quiebre: d.quiebre ? 'Sí' : 'No',
      };
    });
    const tTray = xlCrearHojaTabla(wb, 'Trayectoria_365_dias', 'Trayectoria simulada día a día (365 días)', 'Una réplica representativa de la simulación Monte Carlo',
      [{ header: 'Día (1-365)', key: 'diaNum', width: 11 },
       { header: 'Fecha real 2025', key: 'fecha', width: 15, numFmt: 'dd/mm/yyyy' },
       { header: 'Día de la semana', key: 'diaSemana', width: 15 },
       { header: 'Inventario al abrir (COP)', key: 'invAbrir', width: 20, numFmt: FMT_COP },
       { header: 'Posición (on-hand + tránsito)', key: 'posicion', width: 22, numFmt: FMT_COP },
       { header: 'Punto de reorden R (COP)', key: 'r', width: 20, numFmt: FMT_COP },
       { header: '¿Pedido colocado?', key: 'pedido', width: 14, align: 'center' },
       { header: 'Lead time del pedido (días)', key: 'leadTime', width: 18, numFmt: '0', align: 'center' },
       { header: 'Demanda del día (COP)', key: 'demanda', width: 18, numFmt: FMT_COP },
       { header: 'Inventario al cerrar (COP)', key: 'invCerrar', width: 20, numFmt: FMT_COP },
       { header: '¿Quiebre de stock?', key: 'quiebre', width: 15, align: 'center' }],
      filasTray);
    xlBarraDatos(tTray.ws, `J${tTray.firstDataRow}:J${tTray.lastDataRow}`, XL_COLOR.header);
    xlResaltarSiTexto(tTray.ws, `A${tTray.firstDataRow}:K${tTray.lastDataRow}`, `K${tTray.firstDataRow}`, 'Sí', XL_COLOR.badFill, XL_COLOR.badFont);
    xlResaltarSiTexto(tTray.ws, `G${tTray.firstDataRow}:G${tTray.lastDataRow}`, `G${tTray.firstDataRow}`, 'Sí', XL_COLOR.infoFill, XL_COLOR.infoFont);
    const serieInv = res.traza.map(d => d.inventario);
    const quiebreIdx = res.traza.map((d, i) => d.quiebre ? i : -1).filter(i => i >= 0);
    const lineaInv = xlDibujarLinea(640, 280, 'Inventario al cerrar a lo largo del año (COP) — puntos rojos = quiebre', serieInv, quiebreIdx);
    xlAgregarImagen(wb, tTray.ws, lineaInv, 12, 0, 640, 280);

    // ---------------- Frecuencias por día ----------------
    const filasFrec = [];
    DATA.dias.forEach((dia, di) => {
      construirFilasFrecuencia(DATA.tablas_muestreo[dia]).forEach(f => {
        filasFrec.push({ dia, intervalo: f.intervalo, relativa: f.relativa, acumulada: f.acumulada, _di: di });
      });
    });
    const tFrec = xlCrearHojaTabla(wb, 'Frecuencias_por_dia', 'Tablas de frecuencia empírica de demanda por día', 'Intervalos de clase por regla de Sturges, usados para el muestreo Monte Carlo ("caso de la leche")',
      [{ header: 'Día de la semana', key: 'dia', width: 16, pintar: (cell, fila) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.diaColores[fila._di % 7] } }; cell.font = { bold: true, size: 10.5 }; } },
       { header: 'Intervalo de demanda (COP)', key: 'intervalo', width: 30 },
       { header: 'Frecuencia relativa', key: 'relativa', width: 18, numFmt: FMT_PCT1 },
       { header: 'Frecuencia acumulada', key: 'acumulada', width: 20, numFmt: FMT_PCT1 }],
      filasFrec, { sinZebra: true });
    xlEscalaColor(tFrec.ws, `D${tFrec.firstDataRow}:D${tFrec.lastDataRow}`, 'FFFEF3C7', 'FF15803D');

    // ---------------- Ventas reales 2025 (los 365 datos históricos crudos) ----------------
    // Trazabilidad: estos son los datos reales que, agrupados en intervalos de
    // Sturges por día de la semana, construyen la tabla de "Frecuencias_por_dia"
    // de arriba (la cual a su vez alimenta el muestreo Monte Carlo).
    const clasificadoresPorDia = {};
    DATA.dias.forEach(dia => { clasificadoresPorDia[dia] = xlClasificarEnIntervalo(DATA.tablas_muestreo[dia]); });
    const filasVentasReales = DATA.serie_diaria.map(d => {
      const fecha = fechaUTC(d.fecha);
      const diaSemana = DATA.dias[(fecha.getUTCDay() + 6) % 7];
      const costoProteina = d.venta * DATA.parametros.pct_venta_proteina * DATA.parametros.food_cost_pct;
      return {
        fecha, diaSemana, venta: Math.round(d.venta), costoProteina: Math.round(costoProteina),
        intervalo: d.venta > 0 ? clasificadoresPorDia[diaSemana](costoProteina) : '— (venta $0, posible cierre)',
        cero: d.venta === 0,
      };
    });
    const tVentas = xlCrearHojaTabla(wb, 'Ventas_Reales_2025', 'Ventas reales históricas 2025 (365 días)', 'Dato crudo detrás de "Frecuencias_por_dia": cada fila se clasifica en el intervalo de Sturges de su día de la semana',
      [{ header: 'Fecha', key: 'fecha', width: 14, numFmt: 'dd/mm/yyyy' },
       { header: 'Día de la semana', key: 'diaSemana', width: 15, pintar: (cell, fila) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL_COLOR.diaColores[DATA.dias.indexOf(fila.diaSemana) % 7] } }; cell.font = { bold: true, size: 10.5 }; } },
       { header: 'Venta real total (COP)', key: 'venta', width: 20, numFmt: FMT_COP },
       { header: 'Costo proteína equivalente (COP)', key: 'costoProteina', width: 26, numFmt: FMT_COP },
       { header: 'Intervalo de clase (Sturges) al que pertenece', key: 'intervalo', width: 34 }],
      filasVentasReales, { sinZebra: true });
    xlEscalaColor(tVentas.ws, `D${tVentas.firstDataRow}:D${tVentas.lastDataRow}`, 'FFFEF3C7', 'FF15803D');
    xlResaltarSiNumeroCero(tVentas.ws, `A${tVentas.firstDataRow}:E${tVentas.lastDataRow}`, `C${tVentas.firstDataRow}`, XL_COLOR.warnFill, XL_COLOR.warnFont);

    // ---------------- Carta / menú ----------------
    const filasMenu = DATA.menu.map(m => ({
      plato: m.producto, categoria: m.categoria,
      activo: state.menuActivos[m.producto] ? 'Sí' : 'No',
      precioOriginal: m.precio_cop, precioActual: state.menuPrecios[m.producto] ?? m.precio_cop,
    }));
    const tMenu = xlCrearHojaTabla(wb, 'Menu_Carta', 'Carta / menú de productos', 'Precios editables desde la pestaña Escenarios del simulador',
      [{ header: 'Plato', key: 'plato', width: 30 },
       { header: 'Categoría', key: 'categoria', width: 18 },
       { header: 'Activo', key: 'activo', width: 10, align: 'center' },
       { header: 'Precio original (COP)', key: 'precioOriginal', width: 20, numFmt: FMT_COP },
       { header: 'Precio actual (COP)', key: 'precioActual', width: 20, numFmt: FMT_COP }],
      filasMenu);
    xlResaltarSiTexto(tMenu.ws, `C${tMenu.firstDataRow}:C${tMenu.lastDataRow}`, `C${tMenu.firstDataRow}`, 'No', XL_COLOR.badFill, XL_COLOR.badFont);

    // ---------------- Escenarios A/B (si existen) ----------------
    if (scenarios.A || scenarios.B){
      const filasEsc = [];
      ['A', 'B'].forEach(slot => {
        const sc = scenarios[slot];
        if (!sc) return;
        filasEsc.push({ escenario: slot, factor: sc.state.factor, nivel: sc.state.nivel, demanda: sc.state.demandaSlider,
          estacion: ESTACION_LABEL[sc.state.estacion], merma: sc.state.mermaPct, servicio: sc.result.nivelServicio,
          pctQuiebre: sc.result.pctQuiebre, costoSemana: Math.round(sc.result.costoTotalSemanal), margen: sc.result.margenPct,
          utilidad: Math.round(sc.result.resultadoAnual.utilidadOperacional) });
      });
      if (filasEsc.length){
        const tEsc = xlCrearHojaTabla(wb, 'Escenarios_A_B', 'Comparación de escenarios A / B', 'Capturados manualmente desde la pestaña Escenarios',
          [{ header: 'Escenario', key: 'escenario', width: 12, pintar: (cell, fila) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fila.escenario === 'A' ? XL_COLOR.infoFill : 'FFEDE9FE' } }; cell.font = { bold: true }; } },
           { header: 'Factor Q', key: 'factor', width: 12, numFmt: FMT_NUM },
           { header: 'Nivel servicio objetivo', key: 'nivel', width: 18, numFmt: FMT_PCT1 },
           { header: 'Demanda', key: 'demanda', width: 12, numFmt: FMT_NUM },
           { header: 'Estacionalidad', key: 'estacion', width: 16 },
           { header: 'Merma %', key: 'merma', width: 12, numFmt: FMT_PCT1 },
           { header: 'Nivel de servicio simulado', key: 'servicio', width: 20, numFmt: FMT_PCT1 },
           { header: '% días con quiebre', key: 'pctQuiebre', width: 16, numFmt: FMT_PCT1 },
           { header: 'Costo total/semana', key: 'costoSemana', width: 18, numFmt: FMT_COP },
           { header: 'Margen %', key: 'margen', width: 12, numFmt: FMT_PCT1 },
           { header: 'Utilidad operacional (año)', key: 'utilidad', width: 22, numFmt: FMT_COP }],
          filasEsc, { sinZebra: true });
        tEsc.ws.getRow(tEsc.headerRowIdx).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      }
    }

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'simulacion_bachue.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Excel exportado');
  } catch (err) {
    console.error(err);
    showToast('No se pudo generar el Excel: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function exportarCSV(){
  const res = ultimo || ejecutarSimulacion();
  const filas = [];
  filas.push(['Simulador Bachue - lista de compra sugerida']);
  filas.push(['Generado', new Date().toLocaleString('es-CO')]);
  filas.push([]);
  filas.push(['Parametro','Valor']);
  filas.push(['Factor calibracion Q', state.factor.toFixed(2)]);
  filas.push(['Nivel de servicio objetivo', fmtPct(state.nivel)]);
  filas.push(['Ajuste demanda (slider)', state.demandaSlider.toFixed(2)]);
  filas.push(['Estacionalidad', ESTACION_LABEL[state.estacion]]);
  filas.push(['Merma %', fmtPct(state.mermaPct)]);
  filas.push(['Multiplicador de demanda efectivo', demandaEfectiva().toFixed(2)]);
  filas.push([]);
  filas.push(['Resultado de la simulacion']);
  filas.push(['Nivel de servicio simulado', fmtPct(res.nivelServicio)]);
  filas.push(['% dias con quiebre', fmtPct(res.pctQuiebre)]);
  filas.push(['Costo total semanal (COP)', Math.round(res.costoTotalSemanal)]);
  filas.push(['Margen simulado %', fmtPct(res.margenPct)]);
  filas.push(['Valor de inventario requerido por pedido (Q, COP)', Math.round(res.q)]);
  filas.push([]);
  filas.push(['Dia de pedido','Punto de reorden R (COP)','Cantidad a pedir Q (COP)','Riesgo de quiebre']);
  DATA.dias.forEach(dia=>{
    filas.push([dia, Math.round(res.rPorDia[dia]), Math.round(res.q), fmtPct(res.quiebrePorDiaPct[dia])]);
  });
  const csv = filas.map(f => f.map(c => {
    const s = String(c ?? '');
    return /[,"\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\n');

  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'simulacion_bachue.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exportado');
}

// ---------------------------------------------------------------------------
// Navegacion por pestañas
// ---------------------------------------------------------------------------
function moveTabIndicator(){
  const nav = document.querySelector('nav.tabs');
  const active = nav.querySelector('button[aria-selected="true"]');
  const ind = document.getElementById('tab-indicator');
  if (!nav || !active || !ind) return;
  const navRect = nav.getBoundingClientRect();
  const btnRect = active.getBoundingClientRect();
  ind.style.top = (btnRect.top-navRect.top)+'px';
  ind.style.left = (btnRect.left-navRect.left)+'px';
  ind.style.width = btnRect.width+'px';
  ind.style.height = btnRect.height+'px';
}

function activarTab(id){
  document.querySelectorAll('nav.tabs button').forEach(b=> b.setAttribute('aria-selected', b.dataset.tab===id ? 'true':'false'));
  document.querySelectorAll('.panel').forEach(p=> p.classList.toggle('active', p.id==='panel-'+id));
  document.getElementById('titulo-tab').textContent = document.querySelector(`[data-tab="${id}"]`).dataset.label;
  try { localStorage.setItem('bachue_tab', id); } catch(e){}
  requestAnimationFrame(moveTabIndicator);
}

function resetear(){
  state.factor=2.0; state.nivel=0.95; state.demandaSlider=1.0; state.estacion='normal'; state.mermaPct=0.08;
  state.impuestoPct=0.08; state.comisionDomicilioPct=0.25;
  DATA.menu.forEach(m=>{ state.menuActivos[m.producto]=true; state.menuPrecios[m.producto]=m.precio_cop; });
  document.getElementById('sl-factor').value = state.factor;
  document.getElementById('sl-nivel').value = state.nivel;
  document.getElementById('sl-demanda').value = state.demandaSlider;
  document.getElementById('sl-merma').value = state.mermaPct;
  document.getElementById('sl-impuesto').value = state.impuestoPct;
  document.getElementById('sl-comision').value = state.comisionDomicilioPct;
  document.querySelectorAll('.preset').forEach(b=> b.setAttribute('aria-pressed', b.dataset.preset==='normal' ? 'true':'false'));
  ['sl-factor','sl-nivel','sl-demanda','sl-merma','sl-impuesto','sl-comision'].forEach(id=> updateSliderFill(document.getElementById(id)));
  renderMenuTabla();
  recalcular();
  showToast('Valores restablecidos');
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init(){
  try {
    const res = await fetch('data/datos_front.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
  } catch (err) {
    document.getElementById('app-root').innerHTML =
      '<div class="loading">No se pudieron cargar los datos (data/datos_front.json).<br>' +
      'Si abriste este archivo con doble clic, el navegador bloquea fetch() sobre file://.<br>' +
      'Corre un servidor local (ver iniciar_servidor.bat) y entra por http://localhost:8000.</div>';
    console.error(err);
    return;
  }
  document.getElementById('app-root').classList.add('visible');
  document.getElementById('loading-msg').hidden = true;

  window.__realSerie = DATA.serie_diaria.map(d => d.venta * DATA.parametros.pct_venta_proteina * DATA.parametros.food_cost_pct);

  DATA.menu.forEach(m=>{ state.menuActivos[m.producto]=true; state.menuPrecios[m.producto]=m.precio_cop; });

  document.getElementById('ctx-pct').textContent = fmtPct(DATA.parametros.pct_venta_proteina,0);
  document.getElementById('ctx-fc').textContent = fmtPct(DATA.parametros.food_cost_pct,0);
  document.getElementById('ctx-s').textContent = fmtCOP(DATA.parametros.s_ordenar);

  renderContexto();
  renderMenuTabla();
  recalcular();
  renderEscenarios();

  document.querySelectorAll('nav.tabs button').forEach(b=> b.addEventListener('click', ()=> activarTab(b.dataset.tab)));
  let tabInicial = 'resumen';
  try { tabInicial = localStorage.getItem('bachue_tab') || 'resumen'; } catch(e){}
  activarTab(tabInicial);
  window.addEventListener('resize', debounce(moveTabIndicator, 120));

  const TAB_KEYS = {'1':'resumen','2':'variables','3':'simulacion','4':'tiempo','5':'escenarios','6':'resultado','7':'metodologia'};
  document.addEventListener('keydown', (e)=>{
    if (['INPUT','TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
    if (TAB_KEYS[e.key]) activarTab(TAB_KEYS[e.key]);
  });

  ['sl-factor','sl-nivel','sl-demanda','sl-merma','sl-impuesto','sl-comision'].forEach(id=> updateSliderFill(document.getElementById(id)));
  const debouncedRecalc = debounce(recalcular, 80);

  document.getElementById('sl-factor').addEventListener('input', e=>{ updateSliderFill(e.target); state.factor=parseFloat(e.target.value); debouncedRecalc(); });
  document.getElementById('sl-nivel').addEventListener('input', e=>{ updateSliderFill(e.target); state.nivel=parseFloat(e.target.value); debouncedRecalc(); });
  document.getElementById('sl-demanda').addEventListener('input', e=>{ updateSliderFill(e.target); state.demandaSlider=parseFloat(e.target.value); debouncedRecalc(); });
  document.getElementById('sl-merma').addEventListener('input', e=>{ updateSliderFill(e.target); state.mermaPct=parseFloat(e.target.value); debouncedRecalc(); });
  document.getElementById('sl-impuesto').addEventListener('input', e=>{ updateSliderFill(e.target); state.impuestoPct=parseFloat(e.target.value); debouncedRecalc(); });
  document.getElementById('sl-comision').addEventListener('input', e=>{ updateSliderFill(e.target); state.comisionDomicilioPct=parseFloat(e.target.value); debouncedRecalc(); });

  document.querySelectorAll('.preset').forEach(b=> b.addEventListener('click', ()=>{
    state.estacion = b.dataset.preset;
    document.querySelectorAll('.preset').forEach(x=> x.setAttribute('aria-pressed', x===b ? 'true':'false'));
    recalcular();
  }));

  updateSliderFill(document.getElementById('sl-dia'));
  document.getElementById('sl-dia').addEventListener('input', e=>{ detenerReproduccionSiActiva(); updateSliderFill(e.target); moveDayMarker(parseInt(e.target.value,10)); });
  document.getElementById('btn-dia-prev').addEventListener('click', ()=>{
    detenerReproduccionSiActiva();
    const sl = document.getElementById('sl-dia');
    sl.value = Math.max(0, parseInt(sl.value,10)-1);
    updateSliderFill(sl); moveDayMarker(parseInt(sl.value,10));
  });
  document.getElementById('btn-dia-next').addEventListener('click', ()=>{
    detenerReproduccionSiActiva();
    const sl = document.getElementById('sl-dia');
    sl.value = Math.min(364, parseInt(sl.value,10)+1);
    updateSliderFill(sl); moveDayMarker(parseInt(sl.value,10));
  });
  document.getElementById('btn-quiebre-prev').addEventListener('click', ()=>{ detenerReproduccionSiActiva(); irAQuiebre(-1); });
  document.getElementById('btn-quiebre-next').addEventListener('click', ()=>{ detenerReproduccionSiActiva(); irAQuiebre(1); });

  try { if (localStorage.getItem('bachue_sidebar_collapsed') === '1') document.getElementById('sidebar').classList.add('collapsed'); } catch(e){}
  document.getElementById('btn-sidebar-toggle').addEventListener('click', ()=>{
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    try { localStorage.setItem('bachue_sidebar_collapsed', sidebar.classList.contains('collapsed') ? '1':'0'); } catch(e){}
    requestAnimationFrame(moveTabIndicator);
  });
  document.getElementById('sidebar').addEventListener('transitionend', e=>{ if (e.propertyName==='width') moveTabIndicator(); });

  document.getElementById('btn-reset').addEventListener('click', resetear);
  document.getElementById('btn-play').addEventListener('click', togglePlayback);
  document.querySelectorAll('.speed-btn').forEach(b=> b.addEventListener('click', ()=>{
    document.querySelectorAll('.speed-btn').forEach(x=> x.setAttribute('aria-pressed', x===b ? 'true':'false'));
    cambiarVelocidadReproduccion(parseFloat(b.dataset.speed));
  }));
  document.getElementById('btn-export').addEventListener('click', exportarCSV);
  document.getElementById('btn-export-excel').addEventListener('click', exportarExcel);
  document.getElementById('btn-print').addEventListener('click', ()=> window.print());
  document.getElementById('btn-guardar-a').addEventListener('click', ()=>{
    scenarios.A = { state: JSON.parse(JSON.stringify(state)), result: ultimo };
    renderEscenarios();
    showToast('Guardado como Escenario A');
  });
  document.getElementById('btn-guardar-b').addEventListener('click', ()=>{
    scenarios.B = { state: JSON.parse(JSON.stringify(state)), result: ultimo };
    renderEscenarios();
    showToast('Guardado como Escenario B');
  });
}

init();
