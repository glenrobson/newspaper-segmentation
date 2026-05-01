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

  const btn = document.createElement('button');
  btn.className = 'ocr-action-btn';
  if (hasOCR) {
    btn.classList.add('ocr-toggle-btn');
    btn.title = 'Toggle OCR';
    btn.innerHTML = '<i class="fa-solid fa-eye"></i>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleOCR(articleId); });
  } else {
    btn.classList.add('ocr-generate-btn');
    btn.title = 'Generate OCR';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    btn.addEventListener('click', (e) => { e.stopPropagation(); generateOCR(articleId, btn); });
  }
  row.appendChild(btn);

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

  // OCR action button (eye if hasOCR, wand if not)
  const ocrBtn = document.createElement('button');
  ocrBtn.className = 'ocr-action-btn';
  if (hasOCR) {
    ocrBtn.classList.add('ocr-toggle-btn');
    ocrBtn.title = 'Toggle OCR';
    ocrBtn.innerHTML = '<i class="fa-solid fa-eye"></i>';
    ocrBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleOCR(id); });
  } else {
    ocrBtn.classList.add('ocr-generate-btn');
    ocrBtn.title = 'Generate OCR';
    ocrBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
    ocrBtn.addEventListener('click', (e) => { e.stopPropagation(); generateOCR(id, ocrBtn); });
  }

  row.appendChild(a);
  row.appendChild(editBtn);
  row.appendChild(ocrBtn);

  if (hasOCR) {
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
  buildArticleRow(li, id, title, hasOCR);
  list.appendChild(li);

  if (select) {
    document.querySelectorAll('#article-list li.selected')
      .forEach(el => el.classList.remove('selected'));
    li.classList.add('selected');
  }
}

async function loadArticle(id, listItem) {
  // Hide any open text panels and reset their chevrons
  document.querySelectorAll('#article-list .article-text-panel').forEach(panel => {
    panel.style.display = 'none';
    const chevron = panel.closest('li')?.querySelector('.article-text-btn i');
    if (chevron) chevron.className = 'fa-solid fa-chevron-down';
  });

  viewAllMode = false;
  const showAllBtn = document.getElementById('show-all-btn');
  showAllBtn.textContent = 'Show all regions';
  showAllBtn.classList.remove('active');

  const response = await fetch(`/api/annotations/${id}`);
  const data = await response.json();
  currentOCRAnnotations = [];
  currentAnno.setAnnotations(data.annotations);
  currentArticleId = id;

  document.querySelectorAll('#article-list li.selected')
    .forEach(el => el.classList.remove('selected'));
  listItem.classList.add('selected');

  loadOCRAnnotations(id);
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

  document.getElementById('new-article-form').style.display = 'none';
  document.getElementById('new-article-btn').style.display = '';

  viewAllMode = false;
  const showAllBtn = document.getElementById('show-all-btn');
  showAllBtn.textContent = 'Show all regions';
  showAllBtn.classList.remove('active');

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

  // OCR popup
  ocrPopupEl = document.createElement('div');
  ocrPopupEl.id = 'ocr-popup';
  ocrPopupEl.addEventListener('mousedown', (e) => e.stopPropagation());
  ocrPopupEl.addEventListener('click', (e) => e.stopPropagation());
  viewer.element.appendChild(ocrPopupEl);

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
      if (ann.motivation === 'supplementing') {
        showOCRPopup(ann);
        deleteBtn.style.display = 'none';
        currentSelectedAnnotation = null;
      } else if (!viewAllMode) {
        hideOCRPopup();
        currentSelectedAnnotation = ann;
        positionDeleteButton(ann);
      }
    } else {
      currentSelectedAnnotation = null;
      deleteBtn.style.display = 'none';
      hideOCRPopup();
    }
  });

  viewer.addHandler('update-viewport', () => {
    if (currentSelectedAnnotation) positionDeleteButton(currentSelectedAnnotation);
    if (ocrPopupAnnotation) positionOCRPopup(ocrPopupAnnotation);
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
}

window.openManifest = openManifest;
window.startNewArticle = startNewArticle;
window.saveArticle = saveArticle;
window.showAllAnnotations = showAllAnnotations;
window.generateOCR = generateOCR;
