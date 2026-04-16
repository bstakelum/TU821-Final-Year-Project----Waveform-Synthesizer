// Wire up the download button after the page is ready.
window.addEventListener('DOMContentLoaded', () => {
  const downloadWaveformButton = document.getElementById('downloadWaveform');
  if (downloadWaveformButton && synthEngine) {
    function updateDownloadButtonState() {
      const length = synthEngine.getPreparedWavetableLength?.() ?? 0;
      downloadWaveformButton.disabled = length === 0;
    }
    downloadWaveformButton.addEventListener('click', () => {
      const length = synthEngine.getPreparedWavetableLength?.() ?? 0;
      if (length > 0 && synthEngine.exportWaveformToCSV) {
        synthEngine.exportWaveformToCSV(
          synthEngine.preparedWavetable || null,
          'waveform.csv'
        );
      }
    });
    // Keep the button state in sync whenever a new waveform is loaded.
    const origUpdateWaveform = synthEngine.updateWaveform;
    synthEngine.updateWaveform = function(waveform) {
      origUpdateWaveform.call(this, waveform);
      updateDownloadButtonState();
    };
    // Set the button state on first load.
    updateDownloadButtonState();
  }
});
// Main app file. It connects the camera, image cleanup, waveform extraction, drawing, and audio playback.
import { createCameraController } from './cameraController.js';
import { createImageProcessor } from './imageProcessing.js';
import { extractWaveformFromImageData } from './waveformExtractor.js';
import { createSynthAudioEngine } from './audioEngine.js';
// Main UI elements.
const waveformCanvas = document.getElementById('waveformCanvas');
const wctx = waveformCanvas.getContext('2d');
const processedPreviewCanvas = document.getElementById('processedPreviewCanvas');
const processedPreviewContext = processedPreviewCanvas?.getContext('2d') ?? null;
const waveformPeriodNoteEl = document.getElementById('waveformPeriodNote');
const waveformPeriodInput = document.getElementById('waveformPeriodMs');
const waveformPeriodValue = document.getElementById('waveformPeriodValue');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const processingCanvas = document.getElementById('processingCanvas');
const mobileGenerationView = document.getElementById('mobileGenerationView');
const mobileAnalysisView = document.getElementById('mobileAnalysisView');
const analysisStartCameraButton = document.getElementById('analysisStartCamera');
const video = document.getElementById('video');
const videoWrapper = video?.closest('.video-wrapper') ?? null;
const spectrumScaleSelect = document.getElementById('spectrumScale');
const testSignalButton = document.getElementById('testSignal');
const testSignalTypeSelect = document.getElementById('testSignalType');
const testSignalPeriodsInput = document.getElementById('testSignalPeriods');

const DEFAULT_STARTUP_WIDTH = 640;
const DEFAULT_STARTUP_HEIGHT = 480;
const MOBILE_CAMERA_ASPECT_RATIO = 1;
const DESKTOP_CAMERA_ASPECT_RATIO = 4 / 3;
const DEVICE_MODE_MEDIA_QUERY = window.matchMedia('(pointer: coarse), (max-width: 900px)');
// Create the audio and spectrum module.
const synthEngine = createSynthAudioEngine({
  playButton: document.getElementById('playSynth'),
  spectrumCanvas,
});

const DEFAULT_PANEL_DURATION_SECONDS = 0.01;
const MIN_PANEL_PERIOD_MS = 1;
const MAX_PANEL_PERIOD_MS = 15;
const MOBILE_VIEW_MODES = {
  GENERATION: 'generation',
  ANALYSIS: 'analysis',
};

// Give the canvases a sensible size before the camera reports its real size.
initializeCanvasSizes(DEFAULT_STARTUP_WIDTH, getDefaultStartupHeight());
applyResponsiveDeviceMode();
setMobileView(MOBILE_VIEW_MODES.GENERATION);
updateWaveformPeriodNote();

// Create the image cleanup pipeline.
const imageProcessor = createImageProcessor({});
// Create the camera controller.
const cameraController = createCameraController({
  video,
  processingCanvas,
  startButton: document.getElementById('startCamera'),
  captureButton: document.getElementById('captureFrame'),
  cameraControls: document.getElementById('cameraControls'),
  cameraToggleButton: document.getElementById('cameraToggle'),
  resetROIButton: document.getElementById('resetROI'),
  roiElements: {},
  getTargetAspectRatio: getPreferredCameraAspectRatio,
  isCoarsePointer: () => DEVICE_MODE_MEDIA_QUERY.matches,
  onVideoSize: ({ width, height }) => {
    initializeCanvasSizes(width, height);
  },
  onCapture: processCapturedImage,
});

cameraController.init();
initializeInfoBoxViewportBounds();
bindResponsiveDeviceMode();
// Hook up the spectrum controls and test signal button.
if (spectrumScaleSelect) {
  spectrumScaleSelect.addEventListener('change', (event) => {
    synthEngine.setSpectrumScale(event.target.value);
  });
  synthEngine.setSpectrumScale(spectrumScaleSelect.value);
}

if (testSignalButton) {
  testSignalButton.addEventListener('click', handleTestSignalClick);
}

if (analysisStartCameraButton) {
  analysisStartCameraButton.addEventListener('click', async () => {
    enterGenerationView();
  });
}

if (waveformPeriodInput) {
  const initialSeconds = Number.isFinite(synthEngine.getPanelDurationSeconds?.())
    ? synthEngine.getPanelDurationSeconds()
    : DEFAULT_PANEL_DURATION_SECONDS;
  let initialMs = Math.round(initialSeconds * 1000 * 10) / 10;
  initialMs = Math.max(MIN_PANEL_PERIOD_MS, Math.min(MAX_PANEL_PERIOD_MS, initialMs));
  waveformPeriodInput.value = initialMs;
  if (waveformPeriodValue) waveformPeriodValue.textContent = initialMs;

  waveformPeriodInput.min = MIN_PANEL_PERIOD_MS;
  waveformPeriodInput.max = MAX_PANEL_PERIOD_MS;

  waveformPeriodInput.addEventListener('input', () => {
    let val = Math.max(MIN_PANEL_PERIOD_MS, Math.min(MAX_PANEL_PERIOD_MS, waveformPeriodInput.value));
    applyWaveformPanelPeriodMs(val);
    if (waveformPeriodValue) waveformPeriodValue.textContent = val;
  });
}

function initializeCanvasSizes(width, height) {
  const safeWidth = Math.max(320, Math.round(width));
  const safeHeight = Math.max(180, Math.round(height));

  syncVideoWrapperAspectRatio(safeWidth, safeHeight);

  waveformCanvas.width = safeWidth;
  waveformCanvas.height = safeHeight;

  if (processedPreviewCanvas) {
    processedPreviewCanvas.width = safeWidth;
    processedPreviewCanvas.height = safeHeight;
  }

  if (spectrumCanvas) {
    spectrumCanvas.width = safeWidth;
    spectrumCanvas.height = Math.max(120, Math.min(180, Math.round(safeHeight * 0.5)));
  }

  if (processingCanvas) {
    processingCanvas.width = safeWidth;
    processingCanvas.height = safeHeight;
  }
}

function getPreferredCameraAspectRatio() {
  return DEVICE_MODE_MEDIA_QUERY.matches ? MOBILE_CAMERA_ASPECT_RATIO : DESKTOP_CAMERA_ASPECT_RATIO;
}

function getDefaultStartupHeight() {
  const startupAspectRatio = getPreferredCameraAspectRatio();
  return Math.max(DEFAULT_STARTUP_HEIGHT, Math.round(DEFAULT_STARTUP_WIDTH / startupAspectRatio));
}

function applyResponsiveDeviceMode() {
  const mode = DEVICE_MODE_MEDIA_QUERY.matches ? 'mobile' : 'desktop';
  document.documentElement.dataset.deviceMode = mode;
  document.documentElement.dataset.mobileView = mode === 'mobile'
    ? (document.documentElement.dataset.mobileView === MOBILE_VIEW_MODES.ANALYSIS
      ? MOBILE_VIEW_MODES.ANALYSIS
      : MOBILE_VIEW_MODES.GENERATION)
    : 'desktop';
}

function bindResponsiveDeviceMode() {
  const handleModeChange = () => {
    applyResponsiveDeviceMode();
    cameraController.refreshPreviewLayout?.();
  };

  if (typeof DEVICE_MODE_MEDIA_QUERY.addEventListener === 'function') {
    DEVICE_MODE_MEDIA_QUERY.addEventListener('change', handleModeChange);
  } else if (typeof DEVICE_MODE_MEDIA_QUERY.addListener === 'function') {
    DEVICE_MODE_MEDIA_QUERY.addListener(handleModeChange);
  }

  window.addEventListener('orientationchange', handleModeChange);
}

function syncVideoWrapperAspectRatio(width, height) {
  if (!videoWrapper || width <= 0 || height <= 0) return;
  videoWrapper.style.setProperty('--video-aspect-ratio', `${width} / ${height}`);
}

function initializeInfoBoxViewportBounds() {
  const infoTriggers = document.querySelectorAll('.info-inline');

  function clampInfoBoxToViewport(infoInline) {
    const infoBox = infoInline.querySelector('.info-box');
    if (!infoBox) return;
    const viewportPadding = 12;

    infoBox.style.setProperty('--info-box-shift', '0px');

    const triggerRect = infoInline.getBoundingClientRect();
    const boxWidth = infoBox.offsetWidth;
    const triggerCenterX = triggerRect.left + (triggerRect.width / 2);
    const minCenterX = viewportPadding + (boxWidth / 2);
    const maxCenterX = window.innerWidth - viewportPadding - (boxWidth / 2);
    const clampedCenterX = Math.min(maxCenterX, Math.max(minCenterX, triggerCenterX));
    const shift = clampedCenterX - triggerCenterX;

    infoBox.style.setProperty('--info-box-shift', `${Math.round(shift)}px`);
  }

  infoTriggers.forEach((infoInline) => {
    infoInline.addEventListener('mouseenter', () => clampInfoBoxToViewport(infoInline));
    infoInline.addEventListener('focusin', () => clampInfoBoxToViewport(infoInline));
  });

  window.addEventListener('resize', () => {
    infoTriggers.forEach(clampInfoBoxToViewport);
  });
}

function updateWaveformPeriodNote() {
  if (!waveformPeriodNoteEl) return;

  const currentSeconds = Number.isFinite(synthEngine.getPanelDurationSeconds?.())
    ? synthEngine.getPanelDurationSeconds()
    : DEFAULT_PANEL_DURATION_SECONDS;

  const msText = formatMilliseconds(currentSeconds * 1000);
  waveformPeriodNoteEl.textContent = `Period: ${msText} ms`;
  if (waveformPeriodInput && waveformPeriodValue) {
    waveformPeriodInput.value = msText;
    waveformPeriodValue.textContent = msText;
  }
}

function applyWaveformPanelPeriodMs(periodMsValue) {
  if (!waveformPeriodInput) return;

  let msValue = Number(periodMsValue);
  msValue = Math.max(MIN_PANEL_PERIOD_MS, Math.min(MAX_PANEL_PERIOD_MS, msValue));
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

function handleTestSignalClick() {
  const sampleCount = Math.max(512, waveformCanvas.width || 1024);

  const waveformType = testSignalTypeSelect?.value || 'sine';
  const baseCycles = clampNumber(testSignalPeriodsInput?.value, 0.5, 64, 1);

  const testWaveform = createTestWaveform(sampleCount, {
    baseCycles,
    waveformType,
    targetPeak: 0.9,
  });

  synthEngine.updateWaveform(testWaveform);

  clearProcessedPreview();
  drawWaveform(testWaveform);
  enterAnalysisView();
}

// Make a simple test waveform so the app can be checked without the camera.
function createTestWaveform(length, {
  baseCycles = 1,
  waveformType = 'sine',
  targetPeak = 0.9,
} = {}) {
  const out = new Float32Array(length);
  const safeCycles = Math.max(0.1, Number(baseCycles) || 1);

  for (let i = 0; i < length; i++) {
    const t = i / length;
    const angle = 2 * Math.PI * safeCycles * t;
    let value = 0;

    switch (waveformType) {
      case 'cosine':
        value = Math.cos(angle);
        break;
      case 'square':
        value = Math.sign(Math.sin(angle));
        break;
      case 'triangle':
        value = (2 / Math.PI) * Math.asin(Math.sin(angle));
        break;
      case 'sawtooth':
        value = (2 / Math.PI) * Math.atan(Math.tan(angle / 2));
        break;
      case 'sine':
      default:
        value = Math.sin(angle);
        break;
    }

    out[i] = value;
  }

  // Keep the test signal at a predictable level.
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

// Turn one captured frame into a waveform and update the app.
function processCapturedImage(imageData, roi) {
  const processedImageData = imageProcessor.preprocessImage(imageData);
  if (!processedImageData) {
    return;
  }

  drawProcessedPreview(processedImageData);

  const waveform = extractWaveformFromImageData(processedImageData, { roi });

  if (!waveform || waveform.length === 0) {
    return;
  }

  synthEngine.updateWaveform(waveform);
  drawWaveform(waveform);
  enterAnalysisView();
}

function drawProcessedPreview(imageData) {
  if (!processedPreviewCanvas || !processedPreviewContext || !imageData) return;

  if (processedPreviewCanvas.width !== imageData.width || processedPreviewCanvas.height !== imageData.height) {
    processedPreviewCanvas.width = imageData.width;
    processedPreviewCanvas.height = imageData.height;
  }

  processedPreviewContext.putImageData(imageData, 0, 0);
}

function clearProcessedPreview() {
  if (!processedPreviewCanvas || !processedPreviewContext) return;
  processedPreviewContext.clearRect(0, 0, processedPreviewCanvas.width, processedPreviewCanvas.height);
}

function isMobileViewMode() {
  return document.documentElement.dataset.deviceMode === 'mobile';
}

function setMobileView(mode) {
  if (!isMobileViewMode()) return;
  document.documentElement.dataset.mobileView = mode;
}

function enterAnalysisView() {
  if (!isMobileViewMode()) return;
  cameraController.setPreviewActive?.(false);
  setMobileView(MOBILE_VIEW_MODES.ANALYSIS);
}

function enterGenerationView({ startCamera = false } = {}) {
  if (!isMobileViewMode()) return;
  setMobileView(MOBILE_VIEW_MODES.GENERATION);
  if (cameraController.isCameraRunning?.()) {
    cameraController.setPreviewActive?.(true);
    cameraController.refreshPreviewLayout?.();
  } else if (startCamera) {
    void cameraController.startCamera?.();
  }
}

// Draw the waveform in the main analysis panel.
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
