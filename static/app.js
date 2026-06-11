const state = {
  questions: [],
  results: {},
  idxList: [],
  pos: 0,
  isRangeMode: false,
  fullRangeIdxList: [],
  currentPage: 'verify', // 'verify' or 'create'
  pdfStates: {}, // Track open PDFs per question
  pdfIndex: 0, // Current PDF being viewed for enter key
  // Creation page state
  currentPdfFile: null,
  currentPdfPage: 0,
  pdfPageCount: 0,
};

async function init(){
  bindUI();
  await loadData();
  // Add keyboard navigation
  document.addEventListener('keydown', onKeyDown);
  // Load PDF list for creation page
  loadPdfList();
}

async function loadData(){
  const res = await fetch('/api/questions');
  state.questions = await res.json();
  const r = await fetch('/api/results');
  state.results = await r.json();
  
  // Initialize full range (1-95 or total count)
  const totalQuestions = state.questions.length;
  state.fullRangeIdxList = Array.from({length: totalQuestions}, (_, i) => i);
  
  // If we were in range mode, try to preserve it or reset if invalid
  if(state.isRangeMode){
    const rangeInput = document.getElementById('range').value.trim();
    if(rangeInput) {
      const range = parseRange(rangeInput);
      state.idxList = [];
      for(let i=range[0]; i<=range[1] && i<totalQuestions; i++) state.idxList.push(i);
    } else {
      state.idxList = [...state.fullRangeIdxList];
      state.isRangeMode = false;
    }
  } else {
    state.idxList = [...state.fullRangeIdxList];
  }
  
  // Keep pos within bounds
  if(state.pos >= state.idxList.length) {
    state.pos = Math.max(0, state.idxList.length - 1);
  }
  
  document.getElementById('total').innerText = ` / ${state.questions.length} total`;
  document.getElementById('range').placeholder = `1-${state.questions.length}`;
  
  // Refresh UI
  if(state.idxList.length > 0) {
    showCurrent();
  } else {
    clearViewer();
    document.getElementById('qnum').innerText = 'No Questions Available';
    document.getElementById('question').innerText = '';
    document.getElementById('status').innerText = '';
  }
  refreshLogs();
}

function bindUI(){
  document.getElementById('range').addEventListener('change', onRangeChange);
  document.getElementById('page').addEventListener('change', onPageInput);
  document.getElementById('next').addEventListener('click', onNext);
  document.getElementById('prev').addEventListener('click', onPrev);
  document.getElementById('refresh').addEventListener('click', onRefresh);
  document.getElementById('q-approve').addEventListener('click', ()=>onSet('approved'));
  document.getElementById('q-deny').addEventListener('click', ()=>onSet('denied'));
  document.getElementById('page-toggle').addEventListener('click', togglePage);
  document.getElementById('upload-btn').addEventListener('click', ()=>document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', onFileSelect);
  document.getElementById('pdf-prev').addEventListener('click', onPdfPrev);
  document.getElementById('pdf-next').addEventListener('click', onPdfNext);
  document.getElementById('delete-denied').addEventListener('click', onDeleteDenied);
}

async function onDeleteDenied() {
  if (confirm("Would you like to delete the denied instances?")) {
    try {
      const res = await fetch('/api/delete-denied', {method: 'POST'});
      const data = await res.json();
      if (data.success) {
        alert(`Deleted ${data.deleted_count} denied instances.`);
        await loadData();
      } else {
        alert('Failed to delete denied instances.');
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }
}

function parseRange(str){
  const parts = (str||'').split('-').map(s=>parseInt(s.trim())).filter(n=>!isNaN(n));
  if(parts.length===2) return [parts[0]-1, parts[1]-1];
  if(parts.length===1) return [parts[0]-1, parts[0]-1];
  return [0, state.questions.length-1];
}

function onRangeChange(){
  const rangeInput = document.getElementById('range').value.trim();
  if(!rangeInput) {
    // If range is cleared, go back to full range
    state.idxList = [...state.fullRangeIdxList];
    state.isRangeMode = false;
    state.pos = 0;
    showCurrent();
    refreshLogs();
    return;
  }
  
  const range = parseRange(rangeInput);
  state.idxList = [];
  for(let i=range[0]; i<=range[1] && i<state.questions.length; i++) state.idxList.push(i);
  state.isRangeMode = true;
  state.pos = 0;
  showCurrent();
  refreshLogs();
}

function onPageInput(){
  const pageInputValue = document.getElementById('page').value.trim();
  if(!pageInputValue) return;
  
  const pageNum = parseInt(pageInputValue, 10);
  if(isNaN(pageNum) || pageNum < 1 || pageNum > state.questions.length) {
    alert(`Please enter a valid page number between 1 and ${state.questions.length}`);
    return;
  }
  
  // Jump to the specific page in the full range
  state.idxList = [...state.fullRangeIdxList];
  state.isRangeMode = false;
  state.pos = pageNum - 1;
  
  // Clear the page input
  document.getElementById('page').value = '';
  
  showCurrent();
  refreshLogs();
}

function onKeyDown(event){
  if(state.currentPage === 'verify') {
    if(event.key === 'a' || event.key === 'A') {
      event.preventDefault();
      onSet('approved');
    } else if(event.key === 'd' || event.key === 'D') {
      event.preventDefault();
      onSet('denied');
    } else if(event.key === 'Enter') {
      event.preventDefault();
      openNextPdf();
    } else if(event.key === 'ArrowRight') {
      event.preventDefault();
      onNext();
    } else if(event.key === 'ArrowLeft') {
      event.preventDefault();
      onPrev();
    }
  } else if (state.currentPage === 'create') {
    if(event.key === 'ArrowRight') {
      event.preventDefault();
      onPdfNext();
    } else if(event.key === 'ArrowLeft') {
      event.preventDefault();
      onPdfPrev();
    }
  }
  // ArrowUp and ArrowDown are left for natural scrolling
}

function openNextPdf(){
  const idx = state.idxList[state.pos];
  const q = state.questions[idx];
  if(!q.relevant || q.relevant.length === 0) return;
  
  // Flatten list of all pages across all PDFs
  const allPages = [];
  for(let i = 0; i < q.relevant.length; i++){
    for(let p of q.relevant[i].pages){
      allPages.push({pdfIndex: i, pageNum: p});
    }
  }
  
  if(allPages.length === 0) return;
  
  // Get current PDF state for this question
  if(!state.pdfStates[idx]) state.pdfStates[idx] = 0;
  
  const current = state.pdfStates[idx];
  if(current < allPages.length){
    const {pdfIndex, pageNum} = allPages[current];
    const file = q.relevant[pdfIndex].source;
    
    // Find the button and click it
    const buttons = document.querySelectorAll('.page-btn');
    if(buttons.length > 0){
      // Click the button for this page
      const globalPageIndex = allPages.slice(0, current).reduce((sum, p, i) => sum + (i === pdfIndex ? 1 : 0), 0);
      for(let btn of buttons){
        const btnText = btn.innerText;
        if(btnText.includes(`Page ${pageNum + 1}`)){
          btn.click();
          state.pdfStates[idx] = current + 1;
          return;
        }
      }
    }
  } else {
    // Reset cycle
    state.pdfStates[idx] = 0;
  }
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
  // Auto-advance to the next question if available
  if(state.pos < state.idxList.length-1){
    state.pos++;
    showCurrent();
  } else {
    document.getElementById('status').innerText = 'Done';
  }
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
    const container = document.createElement('div'); container.className='pdf-block';
    const header = document.createElement('div'); header.className='file-header';
    const title = document.createElement('div'); title.className='pdf-title'; title.innerText = file;
    // right side: page buttons area
    const headerRight = document.createElement('div'); headerRight.className = 'header-right';
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
        try{
          await renderPageWithPyMuPDF(file, targetPage, viewerArea);
          if(loading.parentElement) loading.remove();
        }catch(e){
          if(loading.parentElement) loading.remove();
          viewerArea.innerHTML = `<div style="color:#a00;padding:12px">Failed to load PDF page: ${e.message}</div>`;
        }
      });
      pagesBar.appendChild(btn);
    }
    headerRight.appendChild(pagesBar);
    header.appendChild(title);
    header.appendChild(headerRight);
    container.appendChild(header);
    const viewerArea = document.createElement('div'); viewerArea.className='file-viewer';
    container.appendChild(viewerArea);
    document.getElementById('viewer').appendChild(container);
  }
  // ensure logs reflect current range processed items
  refreshLogs();
}

async function renderPageWithPyMuPDF(filename, pageNum, viewerArea){
  try{
    const encodedFilename = encodeURIComponent(filename);
    const response = await fetch(`/api/pdf-page/${encodedFilename}/${pageNum}`);
    
    if(!response.ok){
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to render page');
    }
    
    const data = await response.json();
    
    if(!data.success){
      throw new Error(data.error || 'Failed to render page');
    }
    
    // Create image element to display the rendered page
    const img = document.createElement('img');
    img.src = data.image;
    img.className = 'pdf-page-image';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.border = '1px solid #ccc';
    img.style.display = 'block';
    
    viewerArea.appendChild(img);
  }catch(err){
    const parent = viewerArea;
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

/* Page Toggle and Ground Truth Creation Functions */

function togglePage(){
  state.currentPage = state.currentPage === 'verify' ? 'create' : 'verify';
  
  // Toggle page sections
  document.querySelectorAll('.page-section').forEach(section => section.classList.remove('active'));
  if(state.currentPage === 'verify'){
    document.getElementById('verify-controls').classList.add('active');
    document.getElementById('verify-page').classList.add('active');
  } else {
    document.getElementById('create-controls').classList.add('active');
    document.getElementById('create-page').classList.add('active');
  }
}

async function loadPdfList(){
  try{
    const res = await fetch('/api/pdf-list');
    const data = await res.json();
    const list = document.getElementById('pdf-list');
    list.innerHTML = '';
    
    if(data.files && data.files.length > 0){
      for(const file of data.files){
        const item = document.createElement('div');
        item.className = 'pdf-item';
        item.innerHTML = `<span class="pdf-item-name">${file}</span>`;
        item.addEventListener('click', () => viewPdf(file));
        list.appendChild(item);
      }
    } else {
      list.innerHTML = '<p style="color:#999; padding:8px; font-size:12px;">No PDF files yet</p>';
    }
  }catch(e){
    console.error('Failed to load PDF list:', e);
  }
}

async function viewPdf(filename){
  state.currentPdfFile = filename;
  state.currentPdfPage = 0;
  
  // Update active state
  document.querySelectorAll('.pdf-item').forEach(item => {
    if(item.querySelector('.pdf-item-name').innerText === filename){
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  // Load first page
  await displayPdfPage(0);
}

async function displayPdfPage(pageNum){
  if(!state.currentPdfFile) return;
  
  try{
    const encodedFilename = encodeURIComponent(state.currentPdfFile);
    const response = await fetch(`/api/pdf-page/${encodedFilename}/${pageNum + 1}`);
    
    if(!response.ok) throw new Error('Failed to load page');
    
    const data = await response.json();
    if(!data.success) throw new Error(data.error || 'Failed to load page');
    
    const viewer = document.getElementById('pdf-viewer');
    viewer.innerHTML = '';
    
    const img = document.createElement('img');
    img.src = data.image;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.objectFit = 'contain';
    viewer.appendChild(img);
    
    state.currentPdfPage = pageNum;
    document.getElementById('pdf-page-info').innerText = `Page ${pageNum + 1}`;
  }catch(e){
    document.getElementById('pdf-viewer').innerHTML = `<p style="color:#a00; padding:12px;">Failed to load PDF page: ${e.message}</p>`;
  }
}

function onPdfPrev(){
  if(state.currentPdfPage > 0){
    displayPdfPage(state.currentPdfPage - 1);
  }
}

function onPdfNext(){
  if(state.currentPdfFile){
    // Try to load next page - if it fails, we're at the end
    displayPdfPage(state.currentPdfPage + 1);
  }
}

function setupDropzone(){
  // Removed - no longer used
}

async function onFileSelect(e){
  uploadPdfs(e.target.files);
  e.target.value = ''; // Reset file input
}

async function uploadPdfs(files){
  if(files.length === 0) return;
  
  const formData = new FormData();
  for(let file of files){
    if(file.type === 'application/pdf' || file.name.endsWith('.pdf')){
      formData.append('files', file);
    }
  }
  
  try{
    const res = await fetch('/api/upload-pdf', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    if(data.success){
      alert(`Uploaded: ${data.uploaded.join(', ')}`);
      loadPdfList();
    } else {
      alert(`Error: ${data.error}`);
    }
  }catch(e){
    alert(`Upload failed: ${e.message}`);
  }
}
