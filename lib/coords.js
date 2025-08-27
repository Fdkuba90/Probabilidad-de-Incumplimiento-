// lib/coords.js
// Preferir “Resumen Créditos Activos” (fila Totales) y, si no, caer a “Créditos Activos”.
// Devuelve: { original, vigente, saldo, vencido, d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus, buckets?, _debug_coords? }

function dec(t){ try{ return decodeURIComponent(t||""); }catch{ return t||""; } }
function toNum(s){
  if(s==null) return null;
  const clean=String(s).trim().replace(/\$/g,"").replace(/,/g,"").replace(/\s+/g,"");
  if(!clean || clean==="--") return null;
  const n=Number(clean);
  return Number.isFinite(n)?n:null;
}
const safe = (n)=>Number.isFinite(n)?n:0;
const NUM_RE = /-?\d{1,3}(?:[ ,]\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/* ========== util rows ========== */
function pageToRows(page,yTol=1.2){
  const rows=[];
  for(const t of (page.Texts||[])){
    const s=(t.R && t.R[0] && dec(t.R[0].T))||"";
    if(!s.trim()) continue;
    let row=rows.find(r=>Math.abs(r.y - t.y)<=yTol);
    if(!row){ row={y:t.y,cells:[]}; rows.push(row); }
    row.cells.push({x:t.x,y:t.y,s});
  }
  rows.sort((a,b)=>a.y-b.y);
  for(const r of rows) r.cells.sort((a,b)=>a.x-b.x);
  return rows;
}
const rowText = (r)=>r.cells.map(c=>c.s).join(" ").replace(/[ \t]+/g," ").trim();

/* ========== A) Resumen Créditos Activos ========== */
function findResumenPage(data){
  const pages=data.Pages || data.formImage?.Pages || [];
  for(let i=0;i<pages.length;i++){
    const rows=pageToRows(pages[i],1.2);
    const txt=rows.map(rowText).join("\n");
    if(/Resumen\s+Cr[ée]ditos?\s+Activos/i.test(txt)) return {pageIndex:i, rows};
  }
  return null;
}

function parseTotalesFromResumenRows(rows){
  // buscar la última fila que contenga “Totales”
  let idx=-1;
  for(let i=0;i<rows.length;i++){
    if(/^\s*Totales\s*:?\s*$/i.test(rowText(rows[i])) || rows[i].cells.some(c=>/^\s*Totales\b/i.test(c.s))){
      idx=i;
    }
  }
  if(idx===-1) return null;

  // fusionar con la línea siguiente si casi no trae números en la misma
  const numsIn = (r)=> (rowText(r).match(NUM_RE)||[]).map(toNum).filter(n=>Number.isFinite(n));
  let nums = numsIn(rows[idx]);
  if(nums.length < 9 && rows[idx+1] && Math.abs(rows[idx+1].y - rows[idx].y) <= 1.6){
    nums = nums.concat(numsIn(rows[idx+1]));
  }
  if(!nums.length) return null;

  // en Resumen hay muchas columnas antes de Original; nos quedamos con los ÚLTIMOS 9 números
  const last9 = nums.slice(-9);
  if(last9.length < 9) return null;

  const [o, saldoActual, vigente, b1, b30, b60, b90, b120, b180] = last9.map(n=>Math.round(n));
  const d1_29=b1||0, d30_59=b30||0, d60_89=b60||0, d90_119=b90||0, d120_179=b120||0, d180_plus=b180||0;
  const vencido = d1_29+d30_59+d60_89+d90_119+d120_179+d180_plus;
  const saldo   = Math.round((vigente||0)+vencido);

  return {
    original: Math.round(o||0),
    vigente: Math.round(vigente||0),
    saldo, vencido,
    d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
    buckets: { v1_29:d1_29, v30_59:d30_59, v60_89:d60_89, v90_119:d90_119, v120_179:d120_179, v180p:d180_plus },
    _debug_coords: { source: "resumen", last9 }
  };
}

/* ========== B) Créditos Activos (encabezados + orden fijo) ========== */
const HEADER_COLS = [
  { key:"original",  re:/\boriginal\b/i },
  { key:"vigente",   re:/\bvigente\b/i },
  { key:"v1_29",     re:/(1\s*[–—-]\s*29|1\s*a\s*29)\s*d[ií]as?/i },
  { key:"v30_59",    re:/(30\s*[–—-]\s*59|30\s*a\s*59)\s*d[ií]as?/i },
  { key:"v60_89",    re:/(60\s*[–—-]\s*89|60\s*a\s*89)\s*d[ií]as?/i },
  { key:"v90_119",   re:/(90\s*[–—-]\s*119|90\s*a\s*119)\s*d[ií]as?/i },
  { key:"v120_179",  re:/(120\s*[–—-]\s*179|120\s*a\s*179)\s*d[ií]as?/i },
  { key:"v180p",     re:/(180\+|180\s*\+|180\s*y\s*m[aá]s|180\s*o\s+m[aá]s)/i }
];
function findActivosPage(data){
  const pages=data.Pages || data.formImage?.Pages || [];
  for(let i=0;i<pages.length;i++){
    const rows=pageToRows(pages[i],1.2);
    const joined=rows.map(rowText).join("\n");
    if(/Cr[ée]ditos?\s+Activos/i.test(joined) && /Capital\s*\+\s*Intereses/i.test(joined)) {
      return { pageIndex:i, rows };
    }
  }
  return null;
}
function findHeaderConfig(rows){
  for(let i=0;i<rows.length;i++){
    const r0=rows[i]; const l0=rowText(r0);
    if(!/original/i.test(l0) || !/vigente/i.test(l0)) continue;

    const merged={y:r0.y, cells:[...r0.cells]};
    if(rows[i+1] && rows[i+1].y - r0.y < 1.8) merged.cells.push(...rows[i+1].cells);
    if(rows[i+2] && rows[i+2].y - r0.y < 2.6) merged.cells.push(...rows[i+2].cells);
    merged.cells.sort((a,b)=>a.x-b.x);
    if(!merged.cells.some(c=>/d[ií]as/i.test(c.s))) continue;

    const centers={};
    for(const col of HEADER_COLS){
      const hit = merged.cells.find(c => col.re.test(c.s.replace(/\s+/g," ")));
      if(hit) centers[col.key]=hit.x;
    }
    if(centers.original==null || centers.vigente==null) continue;

    const xs=Object.values(centers).sort((a,b)=>a-b);
    const gaps=[]; for(let k=1;k<xs.length;k++) gaps.push(xs[k]-xs[k-1]);
    const medianGap=gaps.sort((a,b)=>a-b)[Math.floor(gaps.length/2)]||4.5;
    const want=["v1_29","v30_59","v60_89","v90_119","v120_179","v180p"];
    for(let idx=0;idx<want.length;idx++){
      const key=want[idx];
      if(centers[key]==null) centers[key]=(centers.vigente ?? xs[0]) + medianGap*(idx+1);
    }
    const xsAll=Object.values(centers).sort((a,b)=>a-b);
    const gapsAll=[]; for(let k=1;k<xsAll.length;k++) gapsAll.push(xsAll[k]-xsAll[k-1]);
    const med=gapsAll.sort((a,b)=>a-b)[Math.floor(gapsAll.length/2)]||5;
    const maxDist=Math.max(2.0, med*0.6);

    return { headerRowY:r0.y, centers, maxDist };
  }
  return null;
}
function mapRow(row, centers, maxDist){
  const acc={
    original:[], vigente:[],
    v1_29:[], v30_59:[], v60_89:[], v90_119:[], v120_179:[], v180p:[],
    numericByX:[],
    isTotales: row.cells.some(c=>/^\s*Totales\b/i.test(c.s))
  };
  for(const c of row.cells){
    const n=toNum(c.s); if(n==null) continue;
    acc.numericByX.push({x:c.x,n});
    let bestKey=null, best=Infinity;
    for(const [key,x] of Object.entries(centers)){
      const d=Math.abs(c.x-x);
      if(d<best){ best=d; bestKey=key; }
    }
    if(bestKey && best<=maxDist) acc[bestKey].push(n);
  }
  const maxVal=(arr)=> (arr||[]).reduce((m,v)=>m==null || Math.abs(v)>Math.abs(m)?v:m,null);
  const sum   =(arr)=> (arr||[]).reduce((a,b)=>a+(Number(b)||0),0);

  let original=maxVal(acc.original);
  let vigente =maxVal(acc.vigente);
  const buckets={
    v1_29:sum(acc.v1_29), v30_59:sum(acc.v30_59), v60_89:sum(acc.v60_89),
    v90_119:sum(acc.v90_119), v120_179:sum(acc.v120_179), v180p:sum(acc.v180p)
  };

  const ordered=acc.numericByX.sort((a,b)=>a.x-b.x).map(o=>o.n); // [O,V,1-29,...,180+]
  if(ordered.length>=2){
    if(original==null || original===0) original=ordered[0];
    if(vigente ==null || vigente ===0) vigente =ordered[1];
  }
  const fill=(cur,idx)=> (cur && cur!==0)?cur:(ordered.length>idx?ordered[idx]:cur);
  buckets.v1_29   = fill(buckets.v1_29,2);
  buckets.v30_59  = fill(buckets.v30_59,3);
  buckets.v60_89  = fill(buckets.v60_89,4);
  buckets.v90_119 = fill(buckets.v90_119,5);
  buckets.v120_179= fill(buckets.v120_179,6);
  buckets.v180p   = fill(buckets.v180p,7);

  return { original, vigente, buckets, isTotales:acc.isTotales, numCount:acc.numericByX.length };
}

/* ========== Export principal ========== */
export async function extractCreditosActivosByCoords(buffer){
  const mod = await import("pdf2json").catch(()=>null);
  const PDFParser = (mod && (mod.default || mod.PDFParser || mod)) || null;
  if(!PDFParser) return null;

  const parser=new PDFParser();
  const data=await new Promise((resolve,reject)=>{
    parser.on("pdfParser_dataError", e=>reject(e?.parserError||e));
    parser.on("pdfParser_dataReady", d=>resolve(d));
    parser.parseBuffer(buffer);
  });

  // 1) Intentar “Resumen Créditos Activos”
  const hitRes = findResumenPage(data);
  if(hitRes){
    const res = parseTotalesFromResumenRows(hitRes.rows);
    if(res) return res;
  }

  // 2) Caer a “Créditos Activos”
  const hitAct = findActivosPage(data);
  if(!hitAct) return null;

  const rows = pageToRows((data.Pages||[])[hitAct.pageIndex],1.2);
  const header = findHeaderConfig(rows);
  if(!header) return null;

  const { headerRowY, centers, maxDist } = header;
  const start = rows.findIndex(r=>Math.abs(r.y-headerRowY)<1e-6);
  const candidates = rows.slice(start+1);

  const mergeTol = 1.4;
  let best=null;

  for(let i=0;i<candidates.length;i++){
    const r=candidates[i];
    const line=rowText(r);
    if(/Resumen Cr[ée]ditos Activos|Cr[ée]ditos Liquidados|INFORMACI[ÓO]N COMERCIAL/i.test(line)) break;

    let m=mapRow(r,centers,maxDist);
    if(m.isTotales && m.numCount<=2 && i+1<candidates.length){
      const r2=candidates[i+1];
      if(Math.abs(r2.y - r.y)<=mergeTol){
        const merged={y:r.y, cells:[...r.cells, ...r2.cells]};
        const m2=mapRow(merged,centers,maxDist);
        if(m2.numCount>m.numCount) m=m2;
      }
    }
    if(m.isTotales){
      const d1_29=safe(m.buckets.v1_29), d30_59=safe(m.buckets.v30_59), d60_89=safe(m.buckets.v60_89),
            d90_119=safe(m.buckets.v90_119), d120_179=safe(m.buckets.v120_179), d180_plus=safe(m.buckets.v180p);
      const original=Math.round(safe(m.original));
      const vigente =Math.round(safe(m.vigente));
      const vencido = d1_29+d30_59+d60_89+d90_119+d120_179+d180_plus;
      const saldo   = Math.round(vigente + vencido);

      best = {
        original, vigente, saldo, vencido,
        d1_29, d30_59, d60_89, d90_119, d120_179, d180_plus,
        buckets:{ v1_29:d1_29, v30_59:d30_59, v60_89:d60_89, v90_119:d90_119, v120_179:d120_179, v180p:d180_plus },
        _debug_coords:{ source:"activos", centers, totRowY:r.y, ordered:r.cells.map(c=>({x:c.x,s:c.s})) }
      };
    }
  }
  return best;
}
