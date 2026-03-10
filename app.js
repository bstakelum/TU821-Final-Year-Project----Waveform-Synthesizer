// Main app orchestrator:
// - wires camera capture, image preprocessing, waveform extraction, drawing, and synthesis
// - handles test-signal generation and panel-period UI controls
// - updates extraction debug text with source/wavetable/ROI/stream details
import { createCameraController } from './cameraController.js';
import { createImageProcessor } from './imageProcessing.js';
import { extractWaveformFromImageData } from './waveformExtractor.js';
import { createSynthAudioEngine } from './audioEngine.js';

const waveformCanvas = document.getElementById('waveformCanvas');
const wctx = waveformCanvas.getContext('2d');
const waveformPeriodNoteEl = document.getElementById('waveformPeriodNote');
const waveformPeriodInput = document.getElementById('waveformPeriodMs');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const processingCanvas = document.getElementById('processingCanvas');
const processedPreviewCanvas = document.getElementById('processedPreviewCanvas');
const debugCompareEl = document.getElementById('debugCompare');
const spectrumScaleSelect = document.getElementById('spectrumScale');
const testSignalButton = document.getElementById('testSignal');
const testSignalTypeSelect = document.getElementById('testSignalType');
const testSignalPeriodsInput = document.getElementById('testSignalPeriods');

const waveformForegroundCutoff = 200;
const DEFAULT_STARTUP_WIDTH = 1024;
const DEFAULT_STARTUP_HEIGHT = 768;
const DEFAULT_STARTUP_ASPECT = DEFAULT_STARTUP_HEIGHT / DEFAULT_STARTUP_WIDTH;

const synthEngine = createSynthAudioEngine({
  playButton: document.getElementById('playSynth'),
  spectrumCanvas,
});

const DEFAULT_PANEL_DURATION_SECONDS = 0.01;

// Pre-seed canvas dimensions so layout/aspect looks correct before camera metadata exists.
const startupSize = getStartupCanvasSize();
initializeCanvasSizes(startupSize.width, startupSize.height);
updateWaveformPeriodNote();
requestAnimationFrame(() => {
  const syncedSize = getStartupCanvasSize();
  initializeCanvasSizes(syncedSize.width, syncedSize.height);
});

const imageProcessor = createImageProcessor({
  previewCanvas: processedPreviewCanvas,
});

const cameraController = createCameraController({
  video: document.getElementById('video'),
  processingCanvas,
  startButton: document.getElementById('startCamera'),
  captureButton: document.getElementById('captureFrame'),
  cameraControls: document.getElementById('cameraControls'),
  cameraToggleButton: document.getElementById('cameraToggle'),
  resetROIButton: document.getElementById('resetROI'),
  roiElements: {
    topInput: document.getElementById('roiTop'),
    bottomInput: document.getElementById('roiBottom'),
    leftInput: document.getElementById('roiLeft'),
    rightInput: document.getElementById('roiRight'),
    topVal: document.getElementById('roiTopVal'),
    bottomVal: document.getElementById('roiBottomVal'),
    leftVal: document.getElementById('roiLeftVal'),
    rightVal: document.getElementById('roiRightVal'),
  },
  onVideoSize: ({ width, height }) => {
    initializeCanvasSizes(width, height);
  },
  onCapture: processCapturedImage,
});

cameraController.init();

if (spectrumScaleSelect) {
  spectrumScaleSelect.addEventListener('change', (event) => {
    synthEngine.setSpectrumScale(event.target.value);
  });
  synthEngine.setSpectrumScale(spectrumScaleSelect.value);
}

if (testSignalButton) {
  testSignalButton.addEventListener('click', handleTestSignalClick);
}

if (waveformPeriodInput) {
  const initialSeconds = Number.isFinite(synthEngine.getPanelDurationSeconds?.())
    ? synthEngine.getPanelDurationSeconds()
    : DEFAULT_PANEL_DURATION_SECONDS;
  waveformPeriodInput.value = formatMilliseconds(initialSeconds * 1000);

  waveformPeriodInput.addEventListener('change', () => {
    applyWaveformPanelPeriodMs(waveformPeriodInput.value);
  });
}

function initializeCanvasSizes(width, height) {
  const safeWidth = Math.max(320, Math.round(width));
  const safeHeight = Math.max(180, Math.round(height));

  waveformCanvas.width = safeWidth;
  waveformCanvas.height = safeHeight;

  if (spectrumCanvas) {
    spectrumCanvas.width = safeWidth;
    spectrumCanvas.height = Math.max(120, Math.min(180, Math.round(safeHeight * 0.32)));
  }

  if (processingCanvas) {
    processingCanvas.width = safeWidth;
    processingCanvas.height = safeHeight;
  }

  if (processedPreviewCanvas) {
    processedPreviewCanvas.width = safeWidth;
    processedPreviewCanvas.height = safeHeight;
  }
}

function updateWaveformPeriodNote() {
  if (!waveformPeriodNoteEl) return;

  const currentSeconds = Number.isFinite(synthEngine.getPanelDurationSeconds?.())
    ? synthEngine.getPanelDurationSeconds()
    : DEFAULT_PANEL_DURATION_SECONDS;

  const msText = formatMilliseconds(currentSeconds * 1000);
  waveformPeriodNoteEl.textContent = `Period: ${msText} ms`;
}

function applyWaveformPanelPeriodMs(periodMsValue) {
  if (!waveformPeriodInput) return;

  const msValue = Number(periodMsValue);
  const requestedSeconds = Number.isFinite(msValue)
    ? (msValue / 1000)
    : DEFAULT_PANEL_DURATION_SECONDS;

  const appliedSeconds = synthEngine.setPanelDurationSeconds?.(requestedSeconds) ?? DEFAULT_PANEL_DURATION_SECONDS;
  waveformPeriodInput.value = formatMilliseconds(appliedSeconds * 1000);
  updateWaveformPeriodNote();
}

function formatMilliseconds(ms) {
  const rounded = Math.round(ms * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : `${rounded.toFixed(1)}`;
}

function getStartupCanvasSize() {
  const measuredWidth = Math.round(
    waveformCanvas?.getBoundingClientRect?.().width
      || waveformCanvas?.clientWidth
      || 0,
  );
  const width = Math.max(320, measuredWidth || DEFAULT_STARTUP_WIDTH);
  const height = Math.max(180, Math.round(width * DEFAULT_STARTUP_ASPECT));
  return { width, height };
}

function handleTestSignalClick() {
  const sampleCount = Math.max(512, waveformCanvas.width || 1024);

  const waveformType = testSignalTypeSelect?.value === 'cosine' ? 'cosine' : 'sine';
  const baseCycles = clampNumber(testSignalPeriodsInput?.value, 0.5, 64, 1);

  const testWaveform = createTestWaveform(sampleCount, {
    baseCycles,
    waveformType,
    targetPeak: 0.9,
  });

  synthEngine.updateWaveform(testWaveform);
  updateExtractionDebugWavetableInfo(testWaveform.length, null, null);
  drawWaveform(testWaveform);
}

function updateExtractionDebugWavetableInfo(sourceLength, roi, imageDataLength) {
  if (!debugCompareEl) return;

  const wavetableLength = synthEngine.getPreparedWavetableLength?.() ?? 0;
  const imageDataText = Number.isFinite(imageDataLength)
    ? ` | imageData length ${imageDataLength}`
    : '';
  const roiText = roi
    ? ` | ROI ${roi.width}x${roi.height}`
    : '';
  const cameraSettingsText = getCameraSettingsDebugText();

  debugCompareEl.textContent = `Extraction Debug: source length ${sourceLength} samples | prepared wavetable length ${wavetableLength} samples${imageDataText}${roiText}${cameraSettingsText}`;
}

function getCameraSettingsDebugText() {
  const settings = cameraController.getCurrentVideoTrackSettings?.();
  if (!settings) return '';

  const width = Number.isFinite(settings.width) ? settings.width : null;
  const height = Number.isFinite(settings.height) ? settings.height : null;
  const fps = Number.isFinite(settings.frameRate) ? settings.frameRate : null;

  const sizeText = width && height ? `${width}x${height}` : null;
  const fpsText = fps ? `${Math.round(fps)}fps` : null;

  if (!sizeText && !fpsText) return '';
  if (sizeText && fpsText) return ` | Stream ${sizeText} @ ${fpsText}`;
  if (sizeText) return ` | Stream ${sizeText}`;
  return ` | Stream ${fpsText}`;
}

// Build a fundamental test waveform over the panel sample space.
function createTestWaveform(length, {
  baseCycles = 1,
  waveformType = 'sine',
  targetPeak = 0.9,
} = {}) {
  const out = new Float32Array(length);
  const safeCycles = Math.max(0.1, Number(baseCycles) || 1);
  const useCosine = waveformType === 'cosine';

  for (let i = 0; i < length; i++) {
    const t = i / length;
    const angle = 2 * Math.PI * safeCycles * t;
    out[i] = useCosine ? Math.cos(angle) : Math.sin(angle);
  }

  // Normalize to a predictable peak level for stable playback loudness.
  let maxAbs = 0;
  for (let i = 0; i < length; i++) {
    const abs = Math.abs(out[i]);
    if (abs > maxAbs) maxAbs = abs;
  }

  const peak = Math.max(0.01, Math.min(1, Number(targetPeak) || 0.9));
  if (maxAbs > 0) {
    const gain = peak / maxAbs;
    for (let i = 0; i < length; i++) {
      out[i] *= gain;
    }
  }

  return out;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

// Process one captured frame and turn it into a drawable/playable waveform.
function processCapturedImage(imageData, roi) {
  const processedImageData = imageProcessor.preprocessImage(imageData);
  if (!processedImageData) {
    return;
  }

  imageProcessor.renderProcessedPreview(processedImageData);

  const waveform = extractWaveformFromImageData(processedImageData, {
    foregroundCutoff: waveformForegroundCutoff,
    roi,
  });

  if (!waveform || waveform.length === 0) {
    return;
  }

  synthEngine.updateWaveform(waveform);
  updateExtractionDebugWavetableInfo(waveform.length, roi, imageData?.data?.length);
  drawWaveform(waveform);
}

// Draw the extracted waveform line on the waveform canvas.
function drawWaveform(waveform) {
  wctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  const plotWidth = Math.max(10, waveformCanvas.width);
  const plotHeight = Math.max(20, waveformCanvas.height);

  wctx.strokeStyle = '#ffffff';
  wctx.lineWidth = 2;

  let isDrawing = false;
  const xDenominator = Math.max(1, waveform.length - 1);

  for (let i = 0; i < waveform.length; i++) {
    const value = waveform[i];
    if (Number.isNaN(value)) {
      if (isDrawing) {
        wctx.stroke();
        isDrawing = false;
      }
      continue;
    }

    const x = (i / xDenominator) * (plotWidth - 1);
    const y = ((1 - (value + 1) / 2)) * plotHeight;

    if (!isDrawing) {
      wctx.beginPath();
      wctx.moveTo(x, y);
      isDrawing = true;
    } else {
      wctx.lineTo(x, y);
    }
  }

  if (isDrawing) {
    wctx.stroke();
  }
}
