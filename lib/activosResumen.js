// lib/activosResumen.js
// Extracción robusta de "Resumen de Créditos Activos"
// Niveles:
//  A) Coordenadas normales (encabezados + cercanía en X)
//  B) "Modo Bridova": si la fila totales viene desordenada/pegada, tomamos la línea completa,
//     limpiamos ceros a la izquierda y “rebanamos” desde el final hasta obtener 8 números
//     en orden fijo: [Original, Vigente, 1–29, 30–59, 60–89, 90–119, 120–179, 180+]
//  C) Fallback simple por etiquetas si no hubo suerte.

function dec(t){ try{return decodeURIComponent(t||"");}catch{return t||"";} }
function toNum(s){
  if(s==null) return null;
  const clean = String(s).replace(/\$/g,"").replace(/,/g,"").replace(/\s+/g,"").trim();
  if(!clean || clean==="--") return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
const safe = (n)=> Number.isFinite(n) ? n : 0;

const NUM_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;

function pageToRows(page, yTol=1.2){
  const rows=[];
  for(const t of (page.Texts||[])){
    const s=(t.R&&t.R[0]&&dec(t.R[0].T))||"";
    if(!s.trim()) continue;
    let row = rows.find(r => Math.abs(r.y - t.y) <= yTol);
    if(!row){ row = { y:t.y, cells:[] }; rows.push(row); }
    row.cells.push({ x:t.x, y:t.y, s });
  }
  rows.sort((a,b)=>a.y-b.y);
  for(const r of rows) r.cells.sort((a,b)=>a.x-b.x);
  return rows;
}
const rowText = r => r.cells.map(c=>c.s).join(" ").replace(/\s+/g," ").trim();

function hasResumenMarker(joined){
  return /Resumen\s+Cr[ée]ditos?\s+Activos/i.test(joined);
}
function hasHeaders(joined){
  return /\boriginal\b/i.test(joined) && /\bvigente\b/i.test(joined);
}

function findResumenPage(data){
  const pages = data.Pages || data.formImage?.Pages || [];
  for(let i=0;i<pages.length;i++){
    const rows = pageToRows(pages[i],1.2);
    const joined = rows.map(rowText).join("\n");
    if( hasResumenMarker(joined) || hasHeaders(joined) ){
      return { pageIndex:i, rows };
    }
  }
  return null;
}

const HEADER_COLS = [
  { key:"original",  re:/\boriginal\b/i },
  { key:"vigente",   re:/\bvigente\b/i },
  { key:"d1_29",     re:/(^|\s)1\s*[–—-]\s*29(\s|$)/i },
  { key:"d30_59",    re:/(^|\s)30\s*[–—-]\s*59(\s|$)/i },
  { key:"d60_89",    re:/(^|\s)60\s*[–—-]\s*89(\s|$)/i },
  { key:"d90_119",   re:/(^|\s)90\s*[–—-]\s*119(\s|$)/i },
  { key:"d120_179",  re:/(^|\s)120\s*[–—-]\s*179(\s|$)/i },
  { key:"d180_plus", re:/(^|\s)180\+(\s|$)/i },
];

function findHeaderConfig(rows){
  for(let i=0;i<rows.length;i++){
    const r0=rows[i];
    const l0=rowText(r0);
    if(!/\boriginal\b/i.test(l0) || !/\bvigente\b/i.test(l0)) continue;

    const merged={ y:r0.y, cells:[...r0.cells] };
    if(rows[i+1] && rows[i+1].y-r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if(rows[i+2] && rows[i+2].y-r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);

    const centers={};
    for(const col of HEADER_COLS){
      const hit = merged.cells.find(c => col.re.test(c.s.replace(/\s+/g," ")));
      if(hit) centers[col.key]=hit.x;
    }
    if(centers.original==null || centers.vigente==null) continue;

    const xs=Object.values(centers).sort((a,b)=>a-b);
    const gaps=[]; for(let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const med = gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)] || 5;
    const maxDist = Math.max(2.0, med*0.6);

    const bandMin = Math.min(centers.original, centers.vigente) - med*0.7;
    const bandMax = Math.max(
      centers.d180_plus ?? 0, centers.d120_179 ?? 0, centers.d90_119 ?? 0,
      centers.d60_89 ?? 0, centers.d30_59 ?? 0, centers.d1_29 ?? 0
    ) + med*0.7;

    return { headerRowY:r0.y, centers, maxDist, bandMin, bandMax };
  }
  return null;
}

function isTotalesLike(t){ return /\bTotales?\b/i.test(t); }

function mapRow(row, cfg){
  const { centers, maxDist, bandMin, bandMax } = cfg;
  const withinBand = x => x>=bandMin && x<=bandMax;

  const acc = {
    original:[], vigente:[],
    d1_29:[], d30_59:[], d60_89:[], d90_119:[], d120_179:[], d180_plus:[],
    numericByX:[],
    isTot: isTotalesLike(rowText(row))
  };

  for(const c of row.cells){
    const n = toNum(c.s);
    if(n==null) continue;
    if(!withinBand(c.x)) continue;
    acc.numericByX.push({x:c.x, n});

    let bestKey=null, best=Infinity;
    for(const [key,x] of Object.entries(centers)){
      const d=Math.abs(c.x-x);
      if(d<best){ best=d; bestKey=key; }
    }
    if(bestKey && best<=maxDist) acc[bestKey].push(n);
  }

  const maxVal = arr => (arr||[]).reduce((m,v)=> m==null || Math.abs(v)>Math.abs(m) ? v : m, null);
  const sum    = arr => (arr||[]).reduce((a,b)=>a+(Number(b)||0),0);

  let original = maxVal(acc.original);
  let vigente  = maxVal(acc.vigente);

  const buckets = {
    d1_29:   sum(acc.d1_29),
    d30_59:  sum(acc.d30_59),
    d60_89:  sum(acc.d60_89),
    d90_119: sum(acc.d90_119),
    d120_179:sum(acc.d120_179),
    d180_plus:sum(acc.d180_plus)
  };

  const ordered = acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n);
  if(ordered.length>=2){
    if(original==null || original===0) original = ordered[0];
    if(vigente ==null || vigente ===0) vigente  = ordered[1];
  }

  return {
    isTot: acc.isTot,
    numCount: acc.numericByX.length,
    original, vigente, buckets
  };
}

// ---------- Modo Bridova ----------
function explodeWeirdNumbers(line){
  const raw = (line.match(/\d+/g) || []).map(s => s.replace(/^0+(?=\d)/,""));
  if(!raw.length) return [];
  const out=[];
  for(const tok of raw){
    if(tok.length >= 10){
      let t = tok;
      while(t.length>0){
        const take = (t.length%5===0 || t.length>=6) ? 5 : (t.length%6===0 ? 6 : 5);
        const slice = t.slice(-take);
        out.push(slice);
        t = t.slice(0, -take);
        if(out.length>16) break;
      }
    }else{
      out.push(tok);
    }
  }
  return out.map(s => Number(s)).filter(n => Number.isFinite(n));
}
function buildTotalsFromLast8(nums){
  const take = nums.slice(-8);
  if(take.length < 8) return null;
  const [original, vigente, d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus] = take.map(n=>Math.round(n));
  const vencido = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
  const saldo   = Math.round((vigente||0) + vencido);
  return { original, vigente, saldo, vencido, d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus };
}

// ---------- Fallback simple por etiquetas ----------
function fallbackByLabels(joined){
  const get = (re) => {
    const m = joined.match(re);
    return m ? toNum(m[1]) : null;
  };
  const original = get(/original[^0-9\-]*([0-9][0-9.,]*)/i);
  const vigente  = get(/vigente[^0-9\-]*([0-9][0-9.,]*)/i);
  const d1_29    = get(/1\s*[–—-]\s*29[^0-9\-]*([0-9][0-9.,]*)/i)  || 0;
  const d30_59   = get(/30\s*[–—-]\s*59[^0-9\-]*([0-9][0-9.,]*)/i) || 0;
  const d60_89   = get(/60\s*[–—-]\s*89[^0-9\-]*([0-9][0-9.,]*)/i) || 0;
  const d90_119  = get(/90\s*[–—-]\s*119[^0-9\-]*([0-9][0-9.,]*)/i)|| 0;
  const d120_179 = get(/120\s*[–—-]\s*179[^0-9\-]*([0-9][0-9.,]*)/i)|| 0;
  const d180_plus= get(/180\+[^0-9\-]*([0-9][0-9.,]*)/i)           || 0;

  if(original==null || vigente==null) return null;

  const vencido = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
  const saldo   = Math.round((vigente||0) + vencido);
  return {
    original:Math.round(original||0), vigente:Math.round(vigente||0), saldo, vencido,
    d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus
  };
}

// ---------- Export principal ----------
export async function extractActivosResumen(buffer){
  const mod = await import("pdf2json").catch(()=>null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if(!PDFParser) return null;

  const parser = new PDFParser();
  const data = await new Promise((resolve,reject)=>{
    parser.on("pdfParser_dataError", e=>reject(e?.parserError||e));
    parser.on("pdfParser_dataReady", d=>resolve(d));
    parser.parseBuffer(buffer);
  });

  const hit = findResumenPage(data);
  if(!hit) return null;

  const rows = pageToRows((data.Pages||[])[hit.pageIndex], 1.2);
  const header = findHeaderConfig(rows);
  const joined = rows.map(rowText).join("\n");

  // A) Modo normal coordenadas
  if(header){
    const start = rows.findIndex(r => Math.abs(r.y - header.headerRowY) < 1e-6);
    const mergeTol = 1.6;

    for(let i=start+1;i<rows.length;i++){
      const r = rows[i];
      const prev = i>start+1 ? rows[i-1] : null;
      const t = rowText(r);
      if(/Cr[ée]ditos?\s+Liquidados|INFORMACI[ÓO]N\s+COMERCIAL/i.test(t)) break;

      let line = r;
      if(isTotalesLike(t) && rows[i+1] && Math.abs(rows[i+1].y - r.y) <= mergeTol){
        line = { y:r.y, cells:[...r.cells, ...rows[i+1].cells] };
      }else if(prev && isTotalesLike(rowText(prev)) && Math.abs(r.y - prev.y) <= mergeTol){
        line = { y:prev.y, cells:[...prev.cells, ...r.cells] };
      }

      const m = mapRow(line, header);
      if(m.isTot || (m.original!=null && m.vigente!=null)){
        const d1_29   = safe(m.buckets.d1_29);
        const d30_59  = safe(m.buckets.d30_59);
        const d60_89  = safe(m.buckets.d60_89);
        const d90_119 = safe(m.buckets.d90_119);
        const d120_179= safe(m.buckets.d120_179);
        const d180_plus=safe(m.buckets.d180_plus);

        const original = Math.round(safe(m.original));
        const vigente  = Math.round(safe(m.vigente));
        const vencido  = d1_29 + d30_59 + d60_89 + d90_119 + d120_179 + d180_plus;
        const saldo    = Math.round(vigente + vencido);
        return { original, vigente, saldo, vencido, d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus };
      }
    }
  }

  // B) Modo Bridova
  {
    const cand = rows.find(r => /\bTotales?\b/i.test(rowText(r)));
    if(cand){
      const line = rowText(cand);
      const exploded = explodeWeirdNumbers(line);
      const bridova = buildTotalsFromLast8(exploded);
      if(bridova) return bridova;
    }
  }

  // C) Fallback por etiquetas
  const fb = fallbackByLabels(joined);
  if(fb) return fb;

  return null;
}
