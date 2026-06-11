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
  selectedPages: new Set(),
  sessionCreated: [], // Track newly added questions
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

function formatInstanceJSON(obj) {
  if (Array.isArray(obj)) return obj.map(formatInstanceJSON);
  if (obj && typeof obj === 'object') {
    const newObj = {};
    if ('question' in obj) newObj.question = obj.question;
    if ('source' in obj) newObj.source = obj.source;
    if ('pages' in obj) newObj.pages = obj.pages;
    if ('relevant' in obj) newObj.relevant = formatInstanceJSON(obj.relevant);
    for (let k in obj) {
      if (!(k in newObj)) newObj[k] = obj[k];
    }
    return newObj;
  }
  return obj;
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
  document.getElementById('pdf-multi-select').addEventListener('click', toggleMultiSelect);
  document.getElementById('pdf-prev').addEventListener('click', onPdfPrev);
  document.getElementById('pdf-next').addEventListener('click', onPdfNext);
  document.getElementById('pdf-ai').addEventListener('click', onPdfAi);
  document.getElementById('pdf-json-view').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/questions');
      const data = await res.json();
      document.getElementById('ai-result-title').innerText = 'ground_truth.json';
      document.getElementById('ai-json-display').textContent = JSON.stringify(formatInstanceJSON(data), null, 2);
      document.getElementById('add-btn-container').style.display = 'none';
      document.getElementById('ai-result-container').style.display = 'flex';
    } catch (e) {
      alert('Failed to load JSON: ' + e.message);
    }
  });
  document.getElementById('close-ai-btn').addEventListener('click', () => {
    document.getElementById('ai-result-container').style.display = 'none';
  });
  document.getElementById('add-instance-btn').addEventListener('click', onAddInstance);
  document.getElementById('export-instances-btn').addEventListener('click', async () => {
    if (confirm("Would you like to add the added instances?")) {
      try {
        const res = await fetch('/api/export-questions', {method: 'POST'});
        const data = await res.json();
        if (data.success) {
          alert(`Exported ${data.count} instances to ground_truth.json!`);
          state.sessionCreated = [];
          refreshCreateLogs();
          await loadData();
        } else {
          alert('Failed to export: ' + data.error);
        }
      } catch (e) {
        alert('Error exporting: ' + e.message);
      }
    }
  });
  document.getElementById('delete-denied').addEventListener('click', onDeleteDenied);
}

function toggleMultiSelect() {
  if (!state.currentPdfFile) return;
  if (state.selectedPages.has(state.currentPdfPage)) {
    state.selectedPages.delete(state.currentPdfPage);
  } else {
    state.selectedPages.add(state.currentPdfPage);
  }
  updateMultiSelectBtn();
}

function updateMultiSelectBtn() {
  const btn = document.getElementById('pdf-multi-select');
  if (state.selectedPages.has(state.currentPdfPage)) {
    btn.style.color = '#4CAF50';
    btn.style.borderColor = '#4CAF50';
    btn.innerText = 'Selected ✓';
  } else {
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.innerText = 'Multi-select';
  }
}

async function onPdfAi() {
  if(!state.currentPdfFile) return;
  
  const btn = document.getElementById('pdf-ai');
  const originalText = btn.innerText;
  btn.innerText = "Generating...";
  btn.disabled = true;
  
  try {
    let pagesToSend = [];
    if (state.selectedPages.size > 0) {
      // Use selected pages
      pagesToSend = Array.from(state.selectedPages).sort((a, b) => a - b);
    } else {
      // Default to current page if nothing selected
      pagesToSend = [state.currentPdfPage];
    }
    
    // We pass 1-indexed to backend since render_pdf_page uses 1-indexed
    const apiPages = pagesToSend.map(p => p + 1);
    
    const response = await fetch(`/api/generate-question`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: state.currentPdfFile, pages: apiPages })
    });
    
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Failed to generate question');
    
    const baseFilename = state.currentPdfFile.split('/').pop();
    const relevantArray = pagesToSend.map(p => ({
      source: baseFilename,
      pages: [p]
    }));
    
    const newInstance = {
      question: data.question,
      relevant: relevantArray
    };
    
    const resultContainer = document.getElementById('ai-result-container');
    const display = document.getElementById('ai-json-display');
    
    document.getElementById('ai-result-title').innerText = 'Generated Instance';
    document.getElementById('add-btn-container').style.display = 'flex';
    
    display.textContent = JSON.stringify(newInstance, null, 2);
    resultContainer.style.display = 'flex';
    
  } catch (err) {
    alert(`AI Generation failed: ${err.message}`);
  } finally {
    btn.innerText = originalText;
    btn.disabled = false;
  }
}

async function onAddInstance() {
  const text = document.getElementById('ai-json-display').textContent;
  if (!text) return;
  
  const btn = document.getElementById('add-instance-btn');
  btn.disabled = true;
  btn.innerText = "Adding...";
  
  try {
    const instance = JSON.parse(text);
    const res = await fetch('/api/add-question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(instance)
    });
    
    const data = await res.json();
    if (data.success) {
      state.sessionCreated.push({
        globalIndex: data.global_index,
        question: instance
      });
      refreshCreateLogs();
      document.getElementById('ai-result-container').style.display = 'none';
    } else {
      throw new Error(data.error || 'Failed to add');
    }
  } catch (e) {
    alert('Error adding instance: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = "Add";
  }
}

function refreshCreateLogs() {
  const logs = document.getElementById('create-logs');
  if (!logs) return;
  logs.innerHTML = '';
  
  for (const item of state.sessionCreated) {
    const q = item.question;
    const gIdx = item.globalIndex;
    
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.style.cursor = 'pointer';
    div.innerHTML = `<span class="qnum" style="font-weight:bold;">Q${gIdx + 1}</span> <span class="stat">Added</span>`;
    
    div.addEventListener('click', () => {
      document.getElementById('ai-result-title').innerText = `Added Instance Q${gIdx + 1}`;
      document.getElementById('add-btn-container').style.display = 'none';
      document.getElementById('ai-json-display').textContent = JSON.stringify(formatInstanceJSON(q), null, 2);
      document.getElementById('ai-result-container').style.display = 'flex';
    });
    
    logs.appendChild(div);
  }
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
    const encodedFilename = filename.split('/').map(encodeURIComponent).join('/');
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
    
    let hasPdfs = false;
    
    if(data.folders){
      // Sort folders so '/' is at the top
      const folderKeys = Object.keys(data.folders).sort((a, b) => a === '/' ? -1 : (b === '/' ? 1 : a.localeCompare(b)));
      
      for (const folder of folderKeys) {
        const pdfs = data.folders[folder];
        if (pdfs.length === 0) continue;
        hasPdfs = true;
        
        if (folder === '/') {
          for (const file of pdfs) {
            list.appendChild(createPdfItem(file, file));
          }
        } else {
          const folderDiv = document.createElement('div');
          folderDiv.className = 'pdf-folder';
          
          const folderHeader = document.createElement('div');
          folderHeader.className = 'pdf-folder-header';
          folderHeader.innerHTML = `<span>📁 ${folder}</span><span class="folder-arrow">▼</span>`;
          
          const folderContent = document.createElement('div');
          folderContent.className = 'pdf-folder-content';
          folderContent.style.display = 'none'; // Collapsed by default
          
          folderHeader.addEventListener('click', () => {
            const isCollapsed = folderContent.style.display === 'none';
            folderContent.style.display = isCollapsed ? 'block' : 'none';
            folderHeader.querySelector('.folder-arrow').innerText = isCollapsed ? '▲' : '▼';
          });
          
          for (const file of pdfs) {
            const fullPath = folder + '/' + file;
            folderContent.appendChild(createPdfItem(file, fullPath));
          }
          
          folderDiv.appendChild(folderHeader);
          folderDiv.appendChild(folderContent);
          list.appendChild(folderDiv);
        }
      }
    }
    
    if(!hasPdfs){
      list.innerHTML = '<p style="color:#999; padding:8px; font-size:12px;">No PDF files yet</p>';
    }
  }catch(e){
    console.error('Failed to load PDF list:', e);
  }
}

function createPdfItem(displayName, fullPath) {
  const item = document.createElement('div');
  item.className = 'pdf-item';
  item.dataset.path = fullPath;
  item.innerHTML = `<span class="pdf-item-name">${displayName}</span>`;
  item.addEventListener('click', () => viewPdf(fullPath));
  return item;
}

async function viewPdf(filename){
  state.currentPdfFile = filename;
  state.currentPdfPage = 0;
  if (state.selectedPages) state.selectedPages.clear();
  
  // Update active state
  document.querySelectorAll('.pdf-item').forEach(item => {
    if(item.dataset.path === filename){
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
    const encodedFilename = state.currentPdfFile.split('/').map(encodeURIComponent).join('/');
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
    updateMultiSelectBtn();
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
