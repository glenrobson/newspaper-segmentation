import OpenSeadragon from 'openseadragon';
import { createOSDAnnotator } from '@annotorious/openseadragon';
import { getImageURL } from './iiif.js';

// Import essential CSS styles
import '@annotorious/openseadragon/annotorious-openseadragon.css';

let currentViewer = null;
let currentAnno = null;
let keyHandlersBound = false;

function draw() {
    console.log('Drawing mode enabled');
    console.log("Is mouse enabled? " + currentViewer.isMouseNavEnabled());
    currentViewer.setMouseNavEnabled(false);
    currentViewer.setControlsEnabled(false);
    currentViewer.setKeyboardNavEnabled(false);
    currentAnno.setDrawingEnabled(true);
    console.log("Is mouse enabled? " + currentViewer.isMouseNavEnabled());
}

function bindShiftHandlers(viewer, anno) {
  if (keyHandlersBound) {
    return;
  }

  const onKeyDown = (event) => {
    if (event.key !== 'Shift' || event.repeat) {
      return;
    }

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

  // Store cleanup on the viewer so we can remove listeners later
  viewer.__shiftCleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    keyHandlersBound = false;
  };
}

async function openManifest(manifestUrl, canvasId) {
  console.log('Opening ' + manifestUrl);

  let image_id = await getImageURL(manifestUrl, canvasId);

  if (image_id.endsWith('/')) {
    image_id = image_id + 'info.json';
  } else if (image_id.endsWith('.json')) {
    // assume it already points to info.json
  } else {
    image_id = image_id + '/info.json';
  }

  console.log('Using tile source:', image_id);

  // Initialize OpenSeadragon viewer
  const viewer = OpenSeadragon({
    element: document.getElementById('viewer'),
    tileSources: [image_id],
    debugMode:  true,
  });

  // Initialize annotator
  const anno = createOSDAnnotator(viewer, {
    drawingEnabled: false,
    style: {
      fill: '#ff0000',
      fillOpacity: 0.25
    }
  });

  // Optional: choose a drawing tool explicitly
  if (typeof anno.setDrawingTool === 'function') {
    anno.setDrawingTool('rectangle');
  }

  // Attach listeners to handle annotation events
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
}

window.openManifest = openManifest;
window.draw = draw;
