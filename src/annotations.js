import OpenSeadragon from 'openseadragon';
import { createOSDAnnotator, W3CImageFormat } from '@annotorious/openseadragon';
import { getImageURL, getCanvases } from './iiif.js';

// Import essential CSS styles
import '@annotorious/openseadragon/annotorious-openseadragon.css';

let currentViewer = null;
let currentAnno = null;
let currentCanvasId = null;
let currentManifestId = null;
let currentManifestUrl = null;
let currentArticleId = null;
let currentSelectedAnnotation = null;
let keyHandlersBound = false;
let cachedCanvases = null;
let viewAllMode = false;
let currentOCRAnnotations = [];
let ocrVisible = true;
let ocrPopupAnnotation = null;
let ocrPopupEl = null;
let currentRegionsViewer = null;
let currentTargetRegionsViewer = null;

function bindShiftHandlers(viewer, anno) {
  if (keyHandlersBound) {
    return;
  }

  const onKeyDown = (event) => {
    if (event.key !== 'Shift' || event.repeat) {
      return;
    }
    if (viewAllMode) return;

    console.log('Shift down: enable drawing, disable OSD navigation');
    viewer.setMouseNavEnabled(false);
    viewer.setControlsEnabled(false);
    viewer.setKeyboardNavEnabled(false);
    anno.setDrawingEnabled(true);
  };

  const onKeyUp = (event) => {
    if (event.key !== 'Shift') {
      return;
    }

    console.log('Shift up: disable drawing, enable OSD navigation');
    viewer.setMouseNavEnabled(true);
    viewer.setControlsEnabled(true);
    viewer.setKeyboardNavEnabled(true);
    anno.setDrawingEnabled(false);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  keyHandlersBound = true;

  viewer.__shiftCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    keyHandlersBound = false;
  };
}

function getOCRText(annotation) {
  const bodies = Array.isArray(annotation.body) ? annotation.body : [annotation.body];
  const tb = bodies.find(b => b?.type === 'TextualBody');
  return tb?.value ?? '';
}

function positionOCRPopup(annotation) {
  const selector = annotation.target?.selector?.value ?? '';
  const m = selector.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
  if (!m || !ocrPopupEl) return;
  const [x, y, w, h] = m.slice(1).map(Number);
  const vp = currentViewer.viewport.imageToViewportCoordinates(x + w / 2, y + h);
  const el = currentViewer.viewport.viewportToViewerElementCoordinates(vp);
  ocrPopupEl.style.left = `${el.x}px`;
  ocrPopupEl.style.top = `${el.y + 6}px`;
}

function hideOCRPopup() {
  ocrPopupAnnotation = null;
  if (ocrPopupEl) ocrPopupEl.style.display = 'none';
}

function enterOCREditMode(annotation, currentText) {
  ocrPopupEl.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ocr-popup-input';
  input.value = currentText;

  const actions = document.createElement('div');
  actions.className = 'ocr-popup-actions';

  const saveBtn = document.createElement('button');
  saveBtn.title = 'Save';
  saveBtn.innerHTML = '<i class="fa-solid fa-check"></i>';

  const cancelBtn = document.createElement('button');
  cancelBtn.title = 'Cancel';
  cancelBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showOCRPopup(annotation);
  });

  const doSave = async (e) => {
    if (e) e.stopPropagation();
    const newValue = input.value.trim();
    if (!newValue) return;
    await fetch(`/api/ocr/${currentArticleId}/word`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotationId: annotation.id, value: newValue }),
    });
    const idx = currentOCRAnnotations.findIndex(a => a.id === annotation.id);
    if (idx !== -1) {
      const updated = { ...currentOCRAnnotations[idx] };
      updated.body = (Array.isArray(updated.body) ? updated.body : [updated.body])
        .map(b => b?.type === 'TextualBody' ? { ...b, value: newValue } : b);
      currentOCRAnnotations[idx] = updated;
      ocrPopupAnnotation = updated;
    }
    refreshAnnotations();
    showOCRPopup(ocrPopupAnnotation);
  };

  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(e); });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  ocrPopupEl.appendChild(input);
  ocrPopupEl.appendChild(actions);
  input.focus();
  input.select();
}

function showOCRPopup(annotation) {
  ocrPopupAnnotation = annotation;
  const text = getOCRText(annotation);

  ocrPopupEl.innerHTML = '';

  const textDiv = document.createElement('div');
  textDiv.className = 'ocr-popup-text';
  textDiv.textContent = text;

  const actions = document.createElement('div');
  actions.className = 'ocr-popup-actions';

  const copyBtn = document.createElement('button');
  copyBtn.title = 'Copy text';
  copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
    setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1500);
  });

  const editBtn = document.createElement('button');
  editBtn.title = 'Edit text';
  editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enterOCREditMode(annotation, text);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'ocr-popup-delete';
  delBtn.title = 'Delete annotation';
  delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await fetch(`/api/ocr/${currentArticleId}/word`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotationId: annotation.id }),
    });
    currentOCRAnnotations = currentOCRAnnotations.filter(a => a.id !== annotation.id);
    currentAnno.removeAnnotation(annotation);
    hideOCRPopup();
  });

  actions.appendChild(copyBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  ocrPopupEl.appendChild(textDiv);
  ocrPopupEl.appendChild(actions);

  positionOCRPopup(annotation);
  ocrPopupEl.style.display = 'block';
}

function convertOCRAnnotation(ocrAnno) {
  const m = (typeof ocrAnno.target === 'string')
    ? ocrAnno.target.match(/#xywh=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
    : null;
  if (!m) return null;
  const body = Array.isArray(ocrAnno.body) ? ocrAnno.body : [ocrAnno.body];
  return {
    id: ocrAnno.id,
    type: 'Annotation',
    motivation: 'supplementing',
    body,
    target: {
      type: 'SpecificResource',
      selector: {
        type: 'FragmentSelector',
        conformsTo: 'http://www.w3.org/TR/media-frags/',
        value: `xywh=pixel:${m[1]},${m[2]},${m[3]},${m[4]}`
      }
    }
  };
}

function refreshAnnotations() {
  const articleAnnos = currentAnno.getAnnotations()
    .filter(a => a.motivation !== 'supplementing');
  currentAnno.setAnnotations([
    ...articleAnnos,
    ...(ocrVisible ? currentOCRAnnotations : [])
  ]);
}

async function loadOCRAnnotations(articleId) {
  const res = await fetch(`/api/ocr/article/${articleId}`);
  const data = await res.json();
  // Guard against canvas switch that happened while this fetch was in flight
  if (currentArticleId !== articleId) return;
  const converted = data.regions
    .flatMap(r => r.annotations.map(convertOCRAnnotation))
    .filter(Boolean);
  currentOCRAnnotations = converted;
  ocrVisible = true;
  refreshAnnotations();
  // Sync eye icon state for this article's row
  updateArticleRowOCRState(articleId, data.hasOCR);
}

function toggleOCR(articleId) {
  ocrVisible = !ocrVisible;
  refreshAnnotations();
  const li = document.querySelector(`#article-list li[data-article-id="${articleId}"]`);
  if (li) {
    const toggleBtn = li.querySelector('.ocr-toggle-btn');
    if (toggleBtn) toggleBtn.classList.toggle('ocr-hidden', !ocrVisible);
  }
}

async function toggleArticleText(id, li, btn) {
  let panel = li.querySelector('.article-text-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'article-text-panel';
    panel.style.display = 'none';

    const toolbar = document.createElement('div');
    toolbar.className = 'article-text-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'article-text-copy';
    copyBtn.title = 'Copy all text';
    copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = panel.querySelector('.article-text-content')?.textContent ?? '';
      navigator.clipboard.writeText(text);
      copyBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(() => { copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1500);
    });

    toolbar.appendChild(copyBtn);
    panel.appendChild(toolbar);

    const content = document.createElement('div');
    content.className = 'article-text-content';
    panel.appendChild(content);

    li.appendChild(panel);
  }

  const isVisible = panel.style.display !== 'none';
  if (isVisible) {
    panel.style.display = 'none';
    btn.querySelector('i').className = 'fa-solid fa-chevron-down';
  } else {
    panel.style.display = 'block';
    btn.querySelector('i').className = 'fa-solid fa-chevron-up';
    const content = panel.querySelector('.article-text-content');
    content.textContent = 'Loading…';
    const res = await fetch(`/api/articles/${id}/text`);
    content.textContent = await res.text();
  }
}

function updateArticleRowOCRState(articleId, hasOCR) {
  if (window.APP_MODE !== 'ocr') return;
  const li = document.querySelector(`#article-list li[data-article-id="${articleId}"]`);
  if (!li) return;
  const row = li.querySelector('.article-row');
  if (!row) return;

  // Don't replace a button that is currently spinning
  const existing = row.querySelector('.ocr-action-btn');
  if (existing?.disabled) return;

  // Remove existing OCR action button and chevron
  existing?.remove();
  row.querySelector('.article-text-btn')?.remove();

  if (hasOCR) {
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'ocr-action-btn article-text-btn';
    chevronBtn.title = 'Show article text';
    chevronBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    chevronBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleArticleText(articleId, li, chevronBtn); });
    row.appendChild(chevronBtn);
  }
}

function buildArticleRow(li, id, title, hasOCR = false) {
  // Preserve existing text panel before rebuilding the row
  const existingPanel = li.querySelector('.article-text-panel');

  const row = document.createElement('span');
  row.className = 'article-row';

  const a = document.createElement('a');
  a.href = '#';
  a.textContent = title;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    loadArticle(id, li);
  });

  const editBtn = document.createElement('button');
  editBtn.className = 'edit-btn';
  editBtn.title = 'Edit title';
  editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    enterEditMode(li, id, a.textContent);
  });

  row.appendChild(a);
  row.appendChild(editBtn);

  if (window.APP_MODE === 'ocr' && hasOCR) {
    const chevronBtn = document.createElement('button');
    chevronBtn.className = 'ocr-action-btn article-text-btn';
    chevronBtn.title = 'Show article text';
    chevronBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    chevronBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleArticleText(id, li, chevronBtn); });
    row.appendChild(chevronBtn);
  }

  li.innerHTML = '';
  li.appendChild(row);
  // Re-attach preserved text panel
  if (existingPanel) li.appendChild(existingPanel);
}

function enterEditMode(li, id, currentTitle) {
  const row = li.querySelector('.article-row');
  row.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-title-btn';
  saveBtn.title = 'Save title';
  saveBtn.innerHTML = '<i class="fa-solid fa-check"></i>';

  const doSave = () => {
    const newTitle = input.value.trim();
    if (!newTitle) return;
    saveTitleChange(li, id, newTitle);
  };

  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSave();
  });

  row.appendChild(input);
  row.appendChild(saveBtn);
  input.focus();
  input.select();
}

async function saveTitleChange(li, id, newTitle) {
  await fetch(`/api/annotations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  // Preserve hasOCR state — check the current OCR button type
  const hasOCR = !!li.querySelector('.ocr-toggle-btn');
  buildArticleRow(li, id, newTitle, hasOCR);
}

function appendArticleToList(id, title, select = false, hasOCR = false) {
  const list = document.getElementById('article-list');
  const li = document.createElement('li');
  li.dataset.articleId = id;
  li.dataset.canvasId = currentCanvasId;
  buildArticleRow(li, id, title, hasOCR);
  list.appendChild(li);

  if (select) {
    document.querySelectorAll('#article-list li.selected')
      .forEach(el => el.classList.remove('selected'));
    li.classList.add('selected');
  }
}

async function loadArticle(id, listItem) {
  if (window.APP_MODE === 'linking') {
    // On linking page: no OSD viewer — just select article and show regions
    document.querySelectorAll('#article-list li.selected')
      .forEach(el => el.classList.remove('selected'));
    listItem.classList.add('selected');
    currentArticleId = id;
    const canvasId = listItem.dataset.canvasId;
    showArticleRegions(id, canvasId);
    showAllManifestLinks();
    updateAddLinkBtn();
    return;
  }

  // Hide any open text panels and reset their chevrons
  document.querySelectorAll('#article-list .article-text-panel').forEach(panel => {
    panel.style.display = 'none';
    const chevron = panel.closest('li')?.querySelector('.article-text-btn i');
    if (chevron) chevron.className = 'fa-solid fa-chevron-down';
  });

  viewAllMode = false;
  const showAllBtn = document.getElementById('show-all-btn');
  if (showAllBtn) {
    showAllBtn.textContent = 'Show all regions';
    showAllBtn.classList.remove('active');
  }

  const response = await fetch(`/api/annotations/${id}`);
  const data = await response.json();
  currentOCRAnnotations = [];
  currentAnno.setAnnotations(data.annotations);
  currentArticleId = id;

  document.querySelectorAll('#article-list li.selected')
    .forEach(el => el.classList.remove('selected'));
  listItem.classList.add('selected');

  if (window.APP_MODE === 'ocr') loadOCRAnnotations(id);
}

async function loadArticles() {
  if (!currentCanvasId) return;
  const response = await fetch(`/api/articles?canvasId=${encodeURIComponent(currentCanvasId)}`);
  const articles = await response.json();
  document.getElementById('article-list').innerHTML = '';
  console.log("Found " + articles.length + " articles");
  articles.forEach(({ id, title, hasOCR }) => appendArticleToList(id, title, false, hasOCR));
}

function startNewArticle() {
  if (!currentAnno) return;
  currentAnno.setAnnotations([]);
  currentArticleId = null;
  currentOCRAnnotations = [];
  document.getElementById('new-article-form').style.display = 'flex';
  document.getElementById('new-article-btn').style.display = 'none';
  document.getElementById('article-title').focus();
}

async function saveArticle() {
  const titleInput = document.getElementById('article-title');
  const title = titleInput.value.trim();

  if (!title) {
    alert('Please enter an article title.');
    return;
  }
  if (!currentAnno || !currentCanvasId) {
    console.warn('No viewer loaded');
    return;
  }

  const annotations = currentAnno.getAnnotations()
    .filter(a => a.motivation !== 'supplementing')
    .map(a => ({ ...a, motivation: 'segmenting' }));

  const response = await fetch('/api/annotations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      canvasId: currentCanvasId,
      manifestId: currentManifestId,
      annotations,
    })
  });

  const result = await response.json();
  appendArticleToList(result.id, result.title, true, false);
  currentArticleId = result.id;
  titleInput.value = '';
  document.getElementById('new-article-form').style.display = 'none';
  document.getElementById('new-article-btn').style.display = '';
}

async function updateCurrentArticle() {
  if (!currentArticleId || !currentAnno) return;
  const annotations = currentAnno.getAnnotations()
    .filter(a => a.motivation !== 'supplementing')
    .map(a => ({ ...a, motivation: 'segmenting' }));
  await fetch(`/api/annotations/${currentArticleId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotations }),
  });
}

async function generateOCR(articleId, triggerBtn) {
  if (!currentAnno) return;

  // Switch to this article first if it isn't already selected
  if (currentArticleId !== articleId) {
    const li = document.querySelector(`#article-list li[data-article-id="${articleId}"]`);
    if (li) await loadArticle(articleId, li);
  }

  if (triggerBtn) {
    triggerBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    triggerBtn.disabled = true;
  }

  try {
    const annotations = currentAnno.getAnnotations()
      .filter(a => a.motivation !== 'supplementing');
    for (const annotation of annotations) {
      const selector = annotation?.target?.selector?.value ?? '';
      const m = selector.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
      if (!m) continue;
      const region = `${Math.round(m[1])},${Math.round(m[2])},${Math.round(m[3])},${Math.round(m[4])}`;
      await fetch(`/api/ocr/${articleId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotationId: annotation.id, region }),
      });
    }
    // Re-enable button before loadOCRAnnotations so updateArticleRowOCRState
    // can replace the wand with the eye icon
    if (triggerBtn) triggerBtn.disabled = false;
    // Load and display the generated OCR
    await loadOCRAnnotations(articleId);
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}

async function loadLanguages(manifestUrl) {
  const select = document.getElementById('ocr-lang-select');
  if (!select) return;
  const res = await fetch('/api/languages');
  const langs = await res.json();
  select.innerHTML = langs.map(l => `<option value="${l}">${l}</option>`).join('');
  const saved = localStorage.getItem('ocr_lang_' + manifestUrl);
  if (saved && langs.includes(saved)) select.value = saved;
}

async function generateAllOCR() {
  if (!currentManifestUrl) return;

  const btn = document.getElementById('generate-all-ocr-btn');
  const progressEl = document.getElementById('ocr-progress');
  const lang = document.getElementById('ocr-lang-select')?.value || null;

  if (lang) localStorage.setItem('ocr_lang_' + currentManifestUrl, lang);

  btn.disabled = true;

  const canvases = cachedCanvases || await getCanvases(currentManifestUrl);

  for (let ci = 0; ci < canvases.length; ci++) {
    const canvas = canvases[ci];
    const articlesRes = await fetch(`/api/articles?canvasId=${encodeURIComponent(canvas.id)}`);
    const articles = await articlesRes.json();

    for (let ai = 0; ai < articles.length; ai++) {
      const article = articles[ai];
      progressEl.textContent =
        `Page ${ci + 1} of ${canvases.length} — article ${ai + 1} of ${articles.length}: "${article.title}"`;

      const annoRes = await fetch(`/api/annotations/${article.id}`);
      const data = await annoRes.json();

      for (const annotation of data.annotations) {
        const selector = annotation?.target?.selector?.value ?? '';
        const m = selector.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
        if (!m) continue;
        const region = `${Math.round(m[1])},${Math.round(m[2])},${Math.round(m[3])},${Math.round(m[4])}`;
        await fetch(`/api/ocr/${article.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ annotationId: annotation.id, region, lang }),
        });
      }
    }
  }

  progressEl.textContent = 'Done.';
  btn.disabled = false;
  await loadArticles();
}

async function showAllAnnotations() {
  if (!currentAnno || !currentCanvasId) return;

  const btn = document.getElementById('show-all-btn');

  if (viewAllMode) {
    viewAllMode = false;
    currentAnno.setAnnotations([]);
    document.querySelectorAll('#article-list li.selected')
      .forEach(el => el.classList.remove('selected'));
    btn.textContent = 'Show all regions';
    btn.classList.remove('active');
    return;
  }

  const listRes = await fetch(`/api/articles?canvasId=${encodeURIComponent(currentCanvasId)}`);
  const articles = await listRes.json();

  const allAnnotations = [];
  for (const { id } of articles) {
    const res = await fetch(`/api/annotations/${id}`);
    const data = await res.json();
    allAnnotations.push(...data.annotations);
  }

  viewAllMode = true;
  currentArticleId = null;
  document.querySelectorAll('#article-list li.selected')
    .forEach(el => el.classList.remove('selected'));
  btn.textContent = 'Hide all regions';
  btn.classList.add('active');

  currentAnno.setAnnotations(allAnnotations);
}

async function renderThumbnailStrip(manifestUrl, activeCanvasId) {
  const strip = document.getElementById('thumbnail-strip');

  if (manifestUrl !== currentManifestUrl) {
    cachedCanvases = await getCanvases(manifestUrl);
    currentManifestUrl = manifestUrl;

    strip.innerHTML = '';
    for (const canvas of cachedCanvases) {
      const btn = document.createElement('button');
      btn.dataset.canvasId = canvas.id;
      if (canvas.thumbnailUrl) {
        const img = document.createElement('img');
        img.src = canvas.thumbnailUrl;
        img.alt = canvas.label;
        btn.appendChild(img);
      } else {
        btn.textContent = canvas.label;
      }
      btn.addEventListener('click', () => openManifest(manifestUrl, canvas.id));
      strip.appendChild(btn);
    }
  }

  strip.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.canvasId === activeCanvasId);
  });
}

async function openManifest(manifestUrl, canvasId) {
  console.log('Opening ' + manifestUrl);

  // If no canvas specified, default to the first canvas in the manifest
  if (!canvasId) {
    const canvases = await getCanvases(manifestUrl);
    if (!canvases.length) { console.error('No canvases found in manifest'); return; }
    canvasId = canvases[0].id;
  }

  if (currentViewer) {
    if (currentAnno) currentAnno.setAnnotations([]);
    if (currentViewer.__shiftCleanup) currentViewer.__shiftCleanup();
    currentViewer.destroy();
    currentViewer = null;
    currentAnno = null;
  }
  document.getElementById('annotation-delete-btn')?.remove();
  currentSelectedAnnotation = null;
  currentArticleId = null;
  currentOCRAnnotations = [];
  ocrVisible = true;
  ocrPopupEl = null;
  ocrPopupAnnotation = null;

  const newArticleForm = document.getElementById('new-article-form');
  if (newArticleForm) newArticleForm.style.display = 'none';
  const newArticleBtn = document.getElementById('new-article-btn');
  if (newArticleBtn) newArticleBtn.style.display = '';

  viewAllMode = false;
  const showAllBtn = document.getElementById('show-all-btn');
  if (showAllBtn) {
    showAllBtn.textContent = 'Show all regions';
    showAllBtn.classList.remove('active');
  }

  currentManifestId = manifestUrl;
  currentCanvasId = canvasId;

  let image_id = await getImageURL(manifestUrl, canvasId);

  if (image_id.endsWith('/')) {
    image_id = image_id + 'info.json';
  } else if (image_id.endsWith('.json')) {
    // assume it already points to info.json
  } else {
    image_id = image_id + '/info.json';
  }

  console.log('Using tile source:', image_id);

  const viewer = OpenSeadragon({
    element: document.getElementById('viewer'),
    tileSources: [image_id],
    drawer: 'canvas',
  });

  const anno = createOSDAnnotator(viewer, {
    drawingEnabled: false,
    drawingMode: 'drag',
    adapter: W3CImageFormat(),
    style: (annotation) => {
      return annotation.motivation === 'supplementing'
        ? { fill: '#0066cc', fillOpacity: 0.2, stroke: '#0066cc', strokeWidth: 1.5 }
        : { fill: '#ff0000', fillOpacity: 0.25 };
    }
  });

  if (typeof anno.setDrawingTool === 'function') {
    anno.setDrawingTool('rectangle');
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.id = 'annotation-delete-btn';
  deleteBtn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';
  deleteBtn.style.cssText = [
    'position: absolute',
    'display: none',
    'width: 22px',
    'height: 22px',
    'padding: 0',
    'border: none',
    'background: white',
    'border-radius: 50%',
    'color: #cc0000',
    'font-size: 22px',
    'line-height: 1',
    'cursor: pointer',
    'z-index: 1000',
    'transform: translate(-50%, -50%)',
  ].join(';');
  viewer.element.style.position = 'relative';
  viewer.element.appendChild(deleteBtn);

  // OCR popup (only on OCR page)
  if (window.APP_MODE === 'ocr') {
    ocrPopupEl = document.createElement('div');
    ocrPopupEl.id = 'ocr-popup';
    ocrPopupEl.addEventListener('mousedown', (e) => e.stopPropagation());
    ocrPopupEl.addEventListener('click', (e) => e.stopPropagation());
    viewer.element.appendChild(ocrPopupEl);
  }

  function positionDeleteButton(annotation) {
    const selectorValue = annotation?.target?.selector?.value;
    if (!selectorValue) return;

    const match = selectorValue.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    if (!match) return;

    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const w = parseFloat(match[3]);

    const imagePoint = new OpenSeadragon.Point(x + w, y);
    const viewportPoint = viewer.viewport.imageToViewportCoordinates(imagePoint);
    const elementPoint = viewer.viewport.viewportToViewerElementCoordinates(viewportPoint);

    deleteBtn.style.left = elementPoint.x + 'px';
    deleteBtn.style.top = elementPoint.y + 'px';
    deleteBtn.style.display = 'block';
  }

  anno.on('selectionChanged', (selected) => {
    if (selected && selected.length > 0) {
      const ann = selected[0];
      if (window.APP_MODE === 'ocr' && ann.motivation === 'supplementing') {
        showOCRPopup(ann);
        deleteBtn.style.display = 'none';
        currentSelectedAnnotation = null;
      } else if (!viewAllMode) {
        if (window.APP_MODE === 'ocr') hideOCRPopup();
        currentSelectedAnnotation = ann;
        positionDeleteButton(ann);
      }
    } else {
      currentSelectedAnnotation = null;
      deleteBtn.style.display = 'none';
      if (window.APP_MODE === 'ocr') hideOCRPopup();
    }
  });

  viewer.addHandler('update-viewport', () => {
    if (currentSelectedAnnotation) positionDeleteButton(currentSelectedAnnotation);
    if (window.APP_MODE === 'ocr' && ocrPopupAnnotation) positionOCRPopup(ocrPopupAnnotation);
  });

  deleteBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const annotationToDelete = currentSelectedAnnotation;
    if (!annotationToDelete) return;
    if (annotationToDelete.motivation === 'supplementing') return;
    currentAnno.removeAnnotation(annotationToDelete);
    currentSelectedAnnotation = null;
    deleteBtn.style.display = 'none';
    if (currentArticleId) {
      updateCurrentArticle();
    }
  });

  anno.on('createAnnotation', (annotation) => {
    console.log('Annotation created:', annotation);
  });

  anno.on('updateAnnotation', (annotation, previous) => {
    console.log('Annotation updated:', annotation, 'previous:', previous);
  });

  anno.on('deleteAnnotation', (annotation) => {
    console.log('Annotation deleted:', annotation);
  });

  bindShiftHandlers(viewer, anno);

  currentViewer = viewer;
  currentAnno = anno;

  loadArticles();
  renderThumbnailStrip(manifestUrl, canvasId);
  if (window.APP_MODE === 'ocr') loadLanguages(manifestUrl);
}

// ── Linking page functions ──────────────────────────────────────────────────

async function initLinkingPage(manifestUrl) {
  currentManifestUrl = manifestUrl;
  cachedCanvases = await getCanvases(manifestUrl);

  const sourcePageSelect = document.getElementById('source-page-select');
  const pageSelect = document.getElementById('target-page-select');
  cachedCanvases.forEach(canvas => {
    const opt = document.createElement('option');
    opt.value = canvas.id;
    opt.textContent = canvas.label;
    pageSelect.appendChild(opt);

    const srcOpt = document.createElement('option');
    srcOpt.value = canvas.id;
    srcOpt.textContent = canvas.label;
    sourcePageSelect.appendChild(srcOpt);
  });
  pageSelect.addEventListener('change', () => {
    if (currentTargetRegionsViewer) { currentTargetRegionsViewer.destroy(); currentTargetRegionsViewer = null; }
    document.getElementById('target-regions').innerHTML = '';
    if (pageSelect.value) loadTargetArticles(pageSelect.value);
  });
  sourcePageSelect.addEventListener('change', async () => {
    if (!sourcePageSelect.value) return;
    currentCanvasId = sourcePageSelect.value;
    await loadArticles();
    const firstLi = document.querySelector('#article-list li');
    if (firstLi) loadArticle(firstLi.dataset.articleId, firstLi);
  });

  document.getElementById('target-article-select').addEventListener('change', () => {
    updateAddLinkBtn();
    const articleId = document.getElementById('target-article-select').value;
    const canvasId = document.getElementById('target-page-select').value;
    showTargetArticleRegions(articleId, canvasId);
  });

  if (cachedCanvases.length) {
    currentCanvasId = cachedCanvases[0].id;
    sourcePageSelect.value = currentCanvasId;
    await loadArticles();
    const firstLi = document.querySelector('#article-list li');
    if (firstLi) loadArticle(firstLi.dataset.articleId, firstLi);
    showAllManifestLinks();
  }
}

function updateAddLinkBtn() {
  const btn = document.getElementById('add-link-btn');
  if (!btn) return;
  const targetId = document.getElementById('target-article-select')?.value;
  btn.disabled = !currentArticleId || !targetId || targetId === currentArticleId;
}

function sortRegionsReadingOrder(regions) {
  // Mirror of Python _sort_boxes_reading_order: union-find clustering by
  // horizontal overlap (>20% of narrower width), columns sorted left-to-right,
  // within each column sorted top-to-bottom.
  const n = regions.length;
  if (n <= 1) return regions;
  const group = regions.map((_, i) => i);
  function find(i) {
    while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; }
    return i;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = regions[i], b = regions[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      if (overlap > Math.min(a.w, b.w) * 0.2) group[find(i)] = find(j);
    }
  }
  const cols = {};
  regions.forEach((r, i) => { const root = find(i); (cols[root] = cols[root] || []).push(r); });
  return Object.values(cols)
    .sort((a, b) => Math.min(...a.map(r => r.x)) - Math.min(...b.map(r => r.x)))
    .flatMap(col => col.slice().sort((a, b) => a.y - b.y));
}

async function showArticleRegions(articleId, canvasId) {
  if (currentRegionsViewer) { currentRegionsViewer.destroy(); currentRegionsViewer = null; }
  const container = document.getElementById('article-regions');
  container.innerHTML = '';

  const [annoRes, imageBase] = await Promise.all([
    fetch(`/api/annotations/${articleId}`).then(r => r.json()),
    getImageURL(currentManifestUrl, canvasId).then(url => url.replace(/\/info\.json$/, '')),
  ]);

  const regions = annoRes.annotations.flatMap(annotation => {
    const sel = annotation?.target?.selector?.value ?? '';
    const m = sel.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    if (!m) return [];
    const [x, y, w, h] = m.slice(1).map(v => Math.round(parseFloat(v)));
    return [{ x, y, w, h }];
  });

  const sorted = sortRegionsReadingOrder(regions);
  if (!sorted.length) { container.textContent = 'No regions'; return; }

  const tileSources = sorted.map(({ x, y, w, h }) => ({
    type: 'image',
    url: `${imageBase}/${x},${y},${w},${h}/max/0/default.jpg`,
  }));

  currentRegionsViewer = OpenSeadragon({
    element: container,
    sequenceMode: true,
    tileSources,
    prefixUrl: '/images/',
    showNavigationControl: true,
    showSequenceControl: true,
    showRotationControl: false,
    showFlipControl: false,
    drawer: 'canvas',
  });

  currentRegionsViewer.addHandler('open', () => {
    console.log('Regions viewer opened');
    currentRegionsViewer.updateSize();
    currentRegionsViewer.viewport.goHome(true);
    currentRegionsViewer.forceRedraw();
  });
}

async function showTargetArticleRegions(articleId, canvasId) {
  if (currentTargetRegionsViewer) { currentTargetRegionsViewer.destroy(); currentTargetRegionsViewer = null; }
  const container = document.getElementById('target-regions');
  container.innerHTML = '';
  if (!articleId || !canvasId) return;

  const [annoRes, imageBase] = await Promise.all([
    fetch(`/api/annotations/${articleId}`).then(r => r.json()),
    getImageURL(currentManifestUrl, canvasId).then(url => url.replace(/\/info\.json$/, '')),
  ]);

  const regions = annoRes.annotations.flatMap(annotation => {
    const sel = annotation?.target?.selector?.value ?? '';
    const m = sel.match(/xywh=pixel:([\d.]+),([\d.]+),([\d.]+),([\d.]+)/);
    if (!m) return [];
    const [x, y, w, h] = m.slice(1).map(v => Math.round(parseFloat(v)));
    return [{ x, y, w, h }];
  });

  const sorted = sortRegionsReadingOrder(regions);
  if (!sorted.length) { container.textContent = 'No regions'; return; }

  const tileSources = sorted.map(({ x, y, w, h }) => ({
    type: 'image',
    url: `${imageBase}/${x},${y},${w},${h}/max/0/default.jpg`,
  }));

  currentTargetRegionsViewer = OpenSeadragon({
    element: container,
    sequenceMode: true,
    tileSources,
    prefixUrl: '/images/',
    showNavigationControl: true,
    showSequenceControl: true,
    showRotationControl: false,
    showFlipControl: false,
    drawer: 'canvas',
  });

  currentTargetRegionsViewer.addHandler('open', () => {
    currentTargetRegionsViewer.updateSize();
    currentTargetRegionsViewer.viewport.goHome(true);
    currentTargetRegionsViewer.forceRedraw();
  });
}

async function loadTargetArticles(canvasId) {
  const articleSelect = document.getElementById('target-article-select');
  articleSelect.innerHTML = '<option value="">— select article —</option>';
  const res = await fetch(`/api/articles?canvasId=${encodeURIComponent(canvasId)}`);
  const articles = await res.json();
  articles.forEach(({ id, title }) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = title;
    articleSelect.appendChild(opt);
  });
  updateAddLinkBtn();
}

async function showAllManifestLinks() {
  const list = document.getElementById('current-links-list');
  const res = await fetch(`/api/links?manifest=${encodeURIComponent(currentManifestUrl)}`);
  const entries = await res.json();

  if (!entries.length) {
    list.innerHTML = '<li style="font-size:0.85rem;color:#888;background:none;padding:0">None</li>';
    return;
  }
  list.innerHTML = entries.map(group => `
    <li>
      <span>${group.links.map(l => (l.canvasLabel ? l.canvasLabel + ' \u2014 ' : '') + l.title).join(' \u2194 ')}</span>
      <button class="remove-link-btn" onclick="removeArticleGroup('${group.id}')" title="Remove link">&times;</button>
    </li>
  `).join('');
}

async function addArticleLink() {
  const articleSelect = document.getElementById('target-article-select');
  const pageSelect = document.getElementById('target-page-select');
  const linkedId = articleSelect.value;
  const linkedCanvasId = pageSelect.value;
  const linkedCanvasLabel = cachedCanvases.find(c => c.id === linkedCanvasId)?.label ?? '';
  const sourceCanvasLabel = cachedCanvases.find(c => c.id === currentCanvasId)?.label ?? '';

  await fetch(`/api/articles/${currentArticleId}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedId, linkedCanvasLabel, sourceCanvasLabel, manifestUrl: currentManifestUrl }),
  });

  articleSelect.value = '';
  updateAddLinkBtn();
  showAllManifestLinks();
}

async function removeArticleGroup(groupId) {
  await fetch(`/api/links/${groupId}?manifest=${encodeURIComponent(currentManifestUrl)}`, { method: 'DELETE' });
  showAllManifestLinks();
}

window.openManifest = openManifest;
window.startNewArticle = startNewArticle;
window.saveArticle = saveArticle;
window.showAllAnnotations = showAllAnnotations;
window.generateOCR = generateOCR;
window.generateAllOCR = generateAllOCR;
window.initLinkingPage = initLinkingPage;
window.addArticleLink = addArticleLink;
window.removeArticleGroup = removeArticleGroup;

async function initExportPage(manifestUrl) {
  currentManifestUrl = manifestUrl;
  const baseUrlInput = document.getElementById('export-base-url-input');
  if (baseUrlInput) baseUrlInput.value = manifestUrl.replace(/\/[^/]+$/, '/');
  cachedCanvases = await getCanvases(manifestUrl);

  const allArticles = [];
  for (const canvas of cachedCanvases) {
    const res = await fetch(`/api/articles?canvasId=${encodeURIComponent(canvas.id)}`);
    const articles = await res.json();
    articles.forEach(a => allArticles.push({ ...a, canvasId: canvas.id, canvasLabel: canvas.label }));
  }

  const linksRes = await fetch(`/api/links?manifest=${encodeURIComponent(manifestUrl)}`);
  const groups = await linksRes.json();

  const linkedIds = new Set(groups.flatMap(g => g.links.map(l => l.id)));

  const rows = [];
  groups.forEach(g => rows.push({ type: 'group', group: g }));
  allArticles.forEach(a => { if (!linkedIds.has(a.id)) rows.push({ type: 'standalone', article: a }); });

  // Sort by first canvas index in the manifest
  const canvasIndexByLabel = new Map(cachedCanvases.map((c, i) => [c.label, i]));
  function firstPageIndex(row) {
    if (row.type === 'group') {
      return Math.min(...row.group.links.map(l => canvasIndexByLabel.get(l.canvasLabel) ?? Infinity));
    }
    return canvasIndexByLabel.get(row.article.canvasLabel) ?? Infinity;
  }
  rows.sort((a, b) => firstPageIndex(a) - firstPageIndex(b));

  const list = document.getElementById('export-article-list');
  if (!rows.length) {
    list.innerHTML = '<li style="color:#888;border:none;padding:4px 0">No articles found.</li>';
    return;
  }

  list.innerHTML = rows.map((row, i) => {
    if (row.type === 'group') {
      const g = row.group;
      const pages = g.links.map(l => l.canvasLabel).filter(Boolean).join(', ');
      const ids = JSON.stringify(g.links.map(l => l.id));
      return `<li data-ids='${ids}' onclick="toggleExportRow(this)">
        <input type="checkbox" class="export-checkbox" onclick="event.stopPropagation();toggleExportRow(this.closest('li'))">
        <div class="article-info">
          <span class="article-title">${g.title}</span>
          ${pages ? `<span class="article-pages">${pages}</span>` : ''}
        </div>
      </li>`;
    } else {
      const a = row.article;
      const ids = JSON.stringify([a.id]);
      return `<li data-ids='${ids}' onclick="toggleExportRow(this)">
        <input type="checkbox" class="export-checkbox" onclick="event.stopPropagation();toggleExportRow(this.closest('li'))">
        <div class="article-info">
          <span class="article-title">${a.title}</span>
          ${a.canvasLabel ? `<span class="article-pages">${a.canvasLabel}</span>` : ''}
        </div>
      </li>`;
    }
  }).join('');
}

function toggleExportRow(li) {
  const cb = li.querySelector('.export-checkbox');
  const checked = !cb.checked;
  cb.checked = checked;
  li.classList.toggle('selected', checked);
  const btn = document.getElementById('export-selected-btn');
  if (btn) btn.disabled = document.querySelectorAll('.export-checkbox:checked').length === 0;
}

function selectAllArticles() {
  document.querySelectorAll('#export-article-list li').forEach(li => {
    li.querySelector('.export-checkbox').checked = true;
    li.classList.add('selected');
  });
  const btn = document.getElementById('export-selected-btn');
  if (btn) btn.disabled = false;
}

function selectNoArticles() {
  document.querySelectorAll('#export-article-list li').forEach(li => {
    li.querySelector('.export-checkbox').checked = false;
    li.classList.remove('selected');
  });
  const btn = document.getElementById('export-selected-btn');
  if (btn) btn.disabled = true;
}

async function exportSelected() {
  const articleIds = [];
  document.querySelectorAll('#export-article-list li.selected').forEach(li => {
    articleIds.push(...JSON.parse(li.dataset.ids));
  });
  if (!articleIds.length) return;
  const baseUrl = document.getElementById('export-base-url-input')?.value ?? '';

  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifestUrl: currentManifestUrl, articleIds, baseUrl }),
  });

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'export.zip';
  a.click();
  URL.revokeObjectURL(url);
}

window.initExportPage = initExportPage;
window.toggleExportRow = toggleExportRow;
window.selectAllArticles = selectAllArticles;
window.selectNoArticles = selectNoArticles;
window.exportSelected = exportSelected;
