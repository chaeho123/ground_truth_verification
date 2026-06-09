const state = {
  questions: [],
  results: {},
  idxList: [],
  pos: 0,
  paused: true,
};

async function ensurePdfJs(){
  if(window.pdfjsLib) return window.pdfjsLib;
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.349/pdf.min.js';
    s.onload = ()=>{
      try{
        const lib = window.pdfjsLib;
        lib.GlobalWorkerOptions.workerUrl = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.349/pdf.worker.min.js';
        resolve(lib);
      }catch(e){ reject(e); }
    };
    s.onerror = (e)=> reject(new Error('Failed to load pdf.js'));
    document.head.appendChild(s);
  });
}

async function init(){
  try{ await ensurePdfJs(); }catch(e){ console.warn('pdf.js failed to load:', e); }
  const res = await fetch('/api/questions');
  state.questions = await res.json();
  const r = await fetch('/api/results');
  state.results = await r.json();
  bindUI();
  document.getElementById('total').innerText = ` / ${state.questions.length} total`;
}

function bindUI(){
  document.getElementById('start').addEventListener('click', onStart);
  document.getElementById('pause').addEventListener('click', onPause);
  document.getElementById('next').addEventListener('click', onNext);
  document.getElementById('prev').addEventListener('click', onPrev);
  document.getElementById('approve').addEventListener('click', ()=>onSet('approved'));
  document.getElementById('deny').addEventListener('click', ()=>onSet('denied'));
  document.getElementById('refresh').addEventListener('click', onRefresh);
}

function parseRange(str){
  const parts = (str||'').split('-').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
  if(parts.length===2) return [parts[0]-1, parts[1]-1];
  if(parts.length===1) return [parts[0]-1, parts[0]-1];
  return [0, state.questions.length-1];
}

function onStart(){
  const range = parseRange(document.getElementById('range').value);
  state.idxList = [];
  for(let i=range[0]; i<=range[1] && i<state.questions.length; i++) state.idxList.push(i);
  state.pos = 0;
  state.paused = false;
  showCurrent();
  refreshLogs();
}

function onPause(){
  state.paused = !state.paused;
  document.getElementById('pause').innerText = state.paused ? 'Resume' : 'Pause';
}

function onNext(){
  if(state.pos < state.idxList.length-1) { state.pos++; showCurrent(); }
}
function onPrev(){ if(state.pos>0){ state.pos--; showCurrent(); }}

async function onSet(status){
  const idx = state.idxList[state.pos];
  await fetch('/api/submit', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({index: idx, status})});
  state.results[idx] = {status};
  refreshLogs();
  if(!state.paused){ if(state.pos < state.idxList.length-1){ state.pos++; showCurrent(); } else { document.getElementById('status').innerText='Done'; }}
}

function clearViewer(){
  const v = document.getElementById('viewer');
  v.innerHTML = '';
}

async function showCurrent(){
  clearViewer();
  const idx = state.idxList[state.pos];
  const q = state.questions[idx];
  document.getElementById('qnum').innerText = `Question ${idx+1} (${state.pos+1}/${state.idxList.length})`;
  document.getElementById('question').innerText = q.question;
  document.getElementById('status').innerText = state.results[idx] ? `Already: ${state.results[idx].status}` : '';
  // Create pressable bars for PDFs and pages (lazy load pages on click)
  for(const rel of q.relevant){
    const file = rel.source;
    const url = `/data/${encodeURIComponent(file)}`;
    const container = document.createElement('div'); container.className='pdf-block';
    const header = document.createElement('div'); header.className='file-header';
    const title = document.createElement('div'); title.className='pdf-title'; title.innerText = file; header.appendChild(title);
    const pagesBar = document.createElement('div'); pagesBar.className='pages-bar';
    for(const p of rel.pages){
      const btn = document.createElement('button'); btn.className='page-btn'; btn.innerText = `Page ${p+1}`;
      btn.addEventListener('click', async ()=>{
        const viewerArea = container.querySelector('.file-viewer');
        const targetPage = p+1;
        // toggle: if already showing this page, clear it
        if(viewerArea.dataset.current === String(targetPage)){
          viewerArea.innerHTML = '';
          delete viewerArea.dataset.current;
          return;
        }
        viewerArea.innerHTML = '';
        viewerArea.dataset.current = String(targetPage);
        const loading = document.createElement('div'); loading.className = 'pdf-loading'; loading.innerText = 'Loading...';
        viewerArea.appendChild(loading);
        if(window.pdfjsLib){
          const canvas = document.createElement('canvas'); canvas.className='pdf-canvas';
          viewerArea.appendChild(canvas);
          try{
            await renderPage(url, targetPage, canvas);
            if(loading.parentElement) loading.remove();
          }catch(e){
            if(loading.parentElement) loading.remove();
            viewerArea.innerHTML = `<object data="${url}#page=${targetPage}" type="application/pdf" width="100%" height="700px"><p>PDF preview not available.</p></object>`;
          }
        }else{
          // fallback to browser PDF viewer
          viewerArea.innerHTML = `<object data="${url}#page=${targetPage}" type="application/pdf" width="100%" height="700px"><p>PDF preview not available.</p></object>`;
        }
      });
      pagesBar.appendChild(btn);
    }
    header.appendChild(pagesBar);
    container.appendChild(header);
    const viewerArea = document.createElement('div'); viewerArea.className='file-viewer';
    container.appendChild(viewerArea);
    document.getElementById('viewer').appendChild(container);
  }
  // ensure logs reflect current range processed items
  refreshLogs();
}

async function renderPage(url, pageNum, canvas){
  if(!window.pdfjsLib){
    const p = canvas.parentElement;
    p.innerHTML = `<div style="color:#a00;padding:12px">PDF renderer unavailable.</div>`;
    return;
  }
  try{
    const loadingTask = pdfjsLib.getDocument(url);
    const pdf = await loadingTask.promise;
    if(pageNum > pdf.numPages) return;
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({scale:1.2});
    canvas.width = viewport.width; canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({canvasContext: ctx, viewport}).promise;
  }catch(err){
    const parent = canvas.parentElement;
    parent.innerHTML = `<div style="color:#a00;padding:12px">Failed to load PDF page: ${err.message}</div>`;
  }
}

function refreshLogs(){
  const logs = document.getElementById('logs');
  logs.innerHTML = '';
  if(!state.idxList || state.idxList.length===0) return;
  // show only processed items within the current range
  for(const idx of state.idxList){
    if(state.results[idx]){
      const div = document.createElement('div'); div.className = 'log-entry ' + (state.results[idx].status||'');
      div.innerHTML = `<span class="qnum">Q${idx+1}</span><span class="stat">${state.results[idx].status}</span>`;
      // clicking a log jumps back to that question within the current range
      div.style.cursor = 'pointer';
      div.addEventListener('click', ()=>{
        const pos = state.idxList.indexOf(idx);
        if(pos >= 0){ state.pos = pos; showCurrent(); }
      });
      logs.appendChild(div);
    }
  }
}

async function onRefresh(){
  if(!confirm('Clear all stored approvals/denials?')) return;
  await fetch('/api/reset', {method:'POST'});
  state.results = {};
  document.getElementById('status').innerText = 'Cleared results';
}

init();
