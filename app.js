// Main app file. It connects the camera, image cleanup, waveform extraction, drawing, and audio playback.
import { createCameraController } from './cameraController.js';
import { createImageProcessor } from './imageProcessing.js';
import { extractWaveformFromImageData } from './waveformExtractor.js';
import { createSynthAudioEngine } from './audioEngine.js';
// Main UI elements.
const waveformCanvas = document.getElementById('waveformCanvas');
const wctx = waveformCanvas.getContext('2d');
const waveformPeriodNoteEl = document.getElementById('waveformPeriodNote');
const waveformPeriodInput = document.getElementById('waveformPeriodMs');
const waveformPeriodValue = document.getElementById('waveformPeriodValue');
const spectrumCanvas = document.getElementById('spectrumCanvas');
const processingCanvas = document.getElementById('processingCanvas');

const mobileGenerationView = document.getElementById('mobileGenerationView');
const mobileAnalysisView = document.getElementById('mobileAnalysisView');
const analysisStartCameraButton = document.getElementById('analysisStartCamera');
const openAnalysisViewButton = document.getElementById('openAnalysisView');
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

const MIN_PANEL_PERIOD_MS = 1;
const MAX_PANEL_PERIOD_MS = 20;
const MOBILE_VIEW_MODES = {
  GENERATION: 'generation',
  ANALYSIS: 'analysis',
};
let lastRenderedWaveform = null;

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

if (openAnalysisViewButton) {
  openAnalysisViewButton.addEventListener('click', () => {
    enterAnalysisView();
  });
}

if (waveformPeriodInput) {
  const initialSeconds = synthEngine.getPanelDurationSeconds();
  let initialMs = Math.max(MIN_PANEL_PERIOD_MS, Math.min(MAX_PANEL_PERIOD_MS, secondsToMs(initialSeconds)));
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

  if (spectrumCanvas) {
    spectrumCanvas.width = safeWidth;
    spectrumCanvas.height = Math.max(120, Math.min(180, Math.round(safeHeight * 0.5)));
  }

  if (processingCanvas) {
    processingCanvas.width = safeWidth;
    processingCanvas.height = safeHeight;
  }

  restoreAnalysisVisuals();
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

  const currentSeconds = synthEngine.getPanelDurationSeconds();
  const msValue = secondsToMs(currentSeconds);
  waveformPeriodNoteEl.textContent = `Period: ${msValue} ms`;
  if (waveformPeriodInput && waveformPeriodValue) {
    waveformPeriodInput.value = msValue;
    waveformPeriodValue.textContent = msValue;
  }
}

function applyWaveformPanelPeriodMs(periodMsValue) {
  if (!waveformPeriodInput) return;

  let msValue = Math.max(MIN_PANEL_PERIOD_MS, Math.min(MAX_PANEL_PERIOD_MS, Number(periodMsValue)));
  const requestedSeconds = msToSeconds(msValue);
  const appliedSeconds = synthEngine.setPanelDurationSeconds(requestedSeconds);
  waveformPeriodInput.value = secondsToMs(appliedSeconds);
  updateWaveformPeriodNote();
}


function secondsToMs(seconds) {
  return Math.round(seconds * 1000);
}

function msToSeconds(ms) {
  return Math.round(Number(ms)) / 1000;
}

function handleTestSignalClick() {
  const sampleCount = Math.max(512, waveformCanvas.width || 1024);

  const waveformType = testSignalTypeSelect?.value || 'sine';
  const baseCycles = clampNumber(testSignalPeriodsInput?.value, 1, 20, 1);

  const testWaveform = createTestWaveform(sampleCount, {
    baseCycles,
    waveformType,
    targetPeak: 0.9,
  });

  updateAnalysisWaveform(testWaveform);
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

  // Square wave: the last sample sits one sample before the loop-back point
  // (t = (N-1)/N, still inside the negative half-cycle). Force it to zero so
  // the cycle visually closes at the centre line, matching sample[0].
  if (waveformType === 'square' && out.length > 0) {
    out[out.length - 1] = 0;
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
  const _t0 = performance.now();
  const _heapBefore = performance.memory
    ? parseFloat((performance.memory.usedJSHeapSize / 1048576).toFixed(2)) : null;

  const _t1 = performance.now();
  const processedImageData = imageProcessor.preprocessImage(imageData, roi);
  const _imageProcMs = parseFloat((performance.now() - _t1).toFixed(2));

  if (!processedImageData) {
    utOnCaptureAttempt(null, { imageProc_ms: _imageProcMs });
    return;
  }

  const _t2 = performance.now();
  const waveform = extractWaveformFromImageData(processedImageData);
  const _extractMs = parseFloat((performance.now() - _t2).toFixed(2));

  if (!waveform || waveform.length === 0) {
    utOnCaptureAttempt(waveform, { imageProc_ms: _imageProcMs, waveformExtract_ms: _extractMs });
    return;
  }

  lastRenderedWaveform = waveform;

  const _t3 = performance.now();
  synthEngine.updateWaveform(lastRenderedWaveform);
  const _synthUpdateMs = parseFloat((performance.now() - _t3).toFixed(2));

  const _t4 = performance.now();
  drawWaveform(lastRenderedWaveform);
  const _waveformDrawMs = parseFloat((performance.now() - _t4).toFixed(2));

  const _heapAfter = performance.memory
    ? parseFloat((performance.memory.usedJSHeapSize / 1048576).toFixed(2)) : null;
  const _pipelineMs = parseFloat((performance.now() - _t0).toFixed(2));

  const _ap = synthEngine.getLastPerfMs();
  const perf = {
    pipeline_ms:        _pipelineMs,
    imageProc_ms:       _imageProcMs,
    waveformExtract_ms: _extractMs,
    synthUpdate_ms:     _synthUpdateMs,
    waveformDraw_ms:    _waveformDrawMs,
    fft_ms:             _ap.fftMs,
    spectrumDraw_ms:    _ap.spectrumDrawMs,
    wavetablePrep_ms:   _ap.wavetablePrepMs,
    heapUsedMB_before:  _heapBefore,
    heapUsedMB_after:   _heapAfter,
  };

  utOnCaptureAttempt(waveform, perf);
  enterAnalysisView();
}

function updateAnalysisWaveform(waveform) {
  if (!waveform || waveform.length === 0) {
    return;
  }

  // Both extractWaveformFromImageData and createTestWaveform return freshly
  // allocated Float32Arrays — storing the reference directly is safe.
  lastRenderedWaveform = waveform;
  synthEngine.updateWaveform(lastRenderedWaveform);
  drawWaveform(lastRenderedWaveform);
}

function restoreAnalysisVisuals() {
  if (lastRenderedWaveform && lastRenderedWaveform.length > 0) {
    drawWaveform(lastRenderedWaveform);
  }

  if ((synthEngine.getPreparedWavetableLength?.() ?? 0) > 0) {
    synthEngine.setPanelDurationSeconds(synthEngine.getPanelDurationSeconds());
  }
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

  // Draw 0 reference line only.
  wctx.save();
  wctx.strokeStyle = 'rgba(255,255,255,0.5)';
  wctx.lineWidth = 1;
  wctx.setLineDash([4, 4]);
  const zeroY = plotHeight / 2;
  wctx.beginPath();
  wctx.moveTo(0, zeroY);
  wctx.lineTo(plotWidth, zeroY);
  wctx.stroke();
  wctx.restore();

  // Draw tick labels: +1 near top, 0 at midpoint, -1 near bottom.
  wctx.save();
  wctx.fillStyle = 'rgba(255,255,255,0.5)';
  wctx.font = '11px monospace';
  wctx.textAlign = 'left';
  for (const level of [1, 0, -1]) {
    const yRaw = ((1 - (level + 1) / 2)) * plotHeight;
    const label = String(level);
    const yLabel = level === 1 ? yRaw + 12 : yRaw - 3;
    wctx.fillText(label, 4, yLabel);
  }
  wctx.restore();

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

// USER TESTING TRACKER
// Silently collects session metrics for remote user testing.
// Remove this section after FYP submission.

const userTestData = {
  sessionStart: new Date().toISOString(),
  device: DEVICE_MODE_MEDIA_QUERY.matches ? 'mobile' : 'desktop',
  browser: navigator.userAgent,
  sessionDurationMs: null,

  // Session-level totals — one counter per trackable UI element.
  totals: {
    captureAttempts: 0,
    successfulCaptures: 0,
    playPresses: 0,
    periodAdjustments: 0,
    spectrumScaleSwitches: 0,
    roiAdjustments: 0,
    roiResets: 0,
    infoLabelClicks: 0,
    infoLabelHovers: 0,
    testSignalGenerations: 0,
  },

  infoLabelInteractions: {}, // per-label hover + click detail
  testSignalUses: [],        // { shape, uiAfterCapture } per generation
  captures: [],              // { index, timestamp, msSinceLastCapture, wasNull, userRating, uiAfterCapture }
};

const _sessionStartTime = performance.now();

// Interactions accumulated since the last capture or test signal entry was recorded.
// These represent what the user did AFTER seeing the previous result.
// Flushed into that entry's uiAfterCapture field when the next event fires.
let _pendingInteractions = {
  playPresses: 0,
  periodAdjustments: 0,
  spectrumScaleSwitches: 0,
  roiAdjustments: 0,
  roiResets: 0,
  infoLabelClicks: 0,
  infoLabelHovers: 0,
};

// The most recent capture or testSignal entry, awaiting its uiAfterCapture fill.
let _lastEventEntry = null;
let _lastCaptureTime = null; // performance.now() at the previous capture attempt
let _perfSamples = [];    // pipeline perf objects collected separately from capture entries

// Copy pending interactions into the previous entry and reset the counters.
// Called at the start of each new capture attempt or test signal generation,
// and at download time to capture any trailing interactions after the last event.
function _flushPendingToLastEntry() {
  if (_lastEventEntry !== null) {
    _lastEventEntry.uiAfterCapture = { ..._pendingInteractions };
  }
  for (const key of Object.keys(_pendingInteractions)) {
    _pendingInteractions[key] = 0;
  }
}

// Record a per-capture entry. uiAfterCapture starts null and is filled when the next event fires.
function utRecordCapture(wasNull, userRating, msSinceLastCapture) {
  const entry = {
    index: userTestData.totals.captureAttempts,
    timestamp: new Date().toISOString(),
    msSinceLastCapture: msSinceLastCapture ?? null,
    wasNull,
    userRating: userRating ?? null,
    uiAfterCapture: null,
  };
  userTestData.captures.push(entry);
  _lastEventEntry = entry;
}

// Show the single-question rating bar below the waveform after a successful capture.
function utShowCaptureRatingPrompt(msSinceLastCapture) {
  // Record immediately with "No rating" — updated if the user clicks a rating button.
  utRecordCapture(false, 'No rating', msSinceLastCapture);

  const bar = document.getElementById('utRatingBar');
  if (!bar) return;

  bar.style.display = 'flex';

  // Clone buttons to remove any previous listeners.
  bar.querySelectorAll('.ut-rating-btn').forEach(btn => {
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      bar.style.display = 'none';
      // Update the already-recorded entry with the actual rating.
      if (_lastEventEntry) _lastEventEntry.userRating = fresh.dataset.value;
    });
  });
}

// Download all collected test data as a plain-text file.
function utDownloadResults() {
  // Flush any trailing interactions after the last capture into that entry.
  _flushPendingToLastEntry();

  const _ap = synthEngine.drainAllPerfSamples?.() ?? { fft: [], spectrumDraw: [], wavetablePrep: [] };

  function _stats(arr) {
    const a = arr.filter(Number.isFinite);
    if (!a.length) return null;
    const n = a.length;
    const sorted = [...a].sort((x, y) => x - y);
    const mean = a.reduce((s, v) => s + v, 0) / n;
    const stddev = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
    const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
    return {
      n,
      mean:   parseFloat(mean.toFixed(3)),
      stddev: parseFloat(stddev.toFixed(3)),
      min:    parseFloat(sorted[0].toFixed(3)),
      max:    parseFloat(sorted[n - 1].toFixed(3)),
      p95:    parseFloat(p95.toFixed(3)),
    };
  }

  const _cp = _perfSamples;
  userTestData.perfSummary = {
    pipeline_ms:        _stats(_cp.map(p => p?.pipeline_ms).filter(Number.isFinite)),
    imageProc_ms:       _stats(_cp.map(p => p?.imageProc_ms).filter(Number.isFinite)),
    waveformExtract_ms: _stats(_cp.map(p => p?.waveformExtract_ms).filter(Number.isFinite)),
    synthUpdate_ms:     _stats(_cp.map(p => p?.synthUpdate_ms).filter(Number.isFinite)),
    waveformDraw_ms:    _stats(_cp.map(p => p?.waveformDraw_ms).filter(Number.isFinite)),
    fft_ms:             _stats(_ap.fft),
    spectrumDraw_ms:    _stats(_ap.spectrumDraw),
    wavetablePrep_ms:   _stats(_ap.wavetablePrep),
  };

  userTestData.sessionDurationMs = parseFloat((performance.now() - _sessionStartTime).toFixed(2));

  const blob = new Blob([JSON.stringify(userTestData, null, 2)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'user_testing_results.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

// Wire up tracker hooks once the DOM is ready.
window.addEventListener('DOMContentLoaded', () => {
  const playBtn = document.getElementById('playSynth');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      userTestData.totals.playPresses++;
      _pendingInteractions.playPresses++;
    });
  }

  const periodInput = document.getElementById('waveformPeriodMs');
  if (periodInput) {
    periodInput.addEventListener('change', () => {
      userTestData.totals.periodAdjustments++;
      _pendingInteractions.periodAdjustments++;
    });
  }

  // Info label interactions — track hover and click separately per label, and in pending totals.
  document.querySelectorAll('.info-trigger').forEach(btn => {
    const label = btn.getAttribute('aria-label') || btn.textContent.trim();
    const record = (type) => {
      if (!userTestData.infoLabelInteractions[label]) {
        userTestData.infoLabelInteractions[label] = { hover: 0, click: 0 };
      }
      userTestData.infoLabelInteractions[label][type]++;
      if (type === 'click') {
        userTestData.totals.infoLabelClicks++;
        _pendingInteractions.infoLabelClicks++;
      } else {
        userTestData.totals.infoLabelHovers++;
        _pendingInteractions.infoLabelHovers++;
      }
    };
    btn.addEventListener('click',      () => record('click'));
    btn.addEventListener('mouseenter', () => record('hover'));
  });

  // Test signal generator — flush pending into previous entry, then record this generation.
  const testSignalBtn = document.getElementById('testSignal');
  const testSignalTypeEl = document.getElementById('testSignalType');
  if (testSignalBtn) {
    testSignalBtn.addEventListener('click', () => {
      _flushPendingToLastEntry();
      userTestData.totals.testSignalGenerations++;
      const entry = { shape: testSignalTypeEl?.value ?? null, uiAfterCapture: null };
      userTestData.testSignalUses.push(entry);
      _lastEventEntry = entry;
    });
  }

  const procCanvas = document.getElementById('processingCanvas');
  if (procCanvas) {
    procCanvas.addEventListener('pointerup', () => {
      userTestData.totals.roiAdjustments++;
      _pendingInteractions.roiAdjustments++;
    });
  }

  const resetROIBtn = document.getElementById('resetROI');
  if (resetROIBtn) {
    resetROIBtn.addEventListener('click', () => {
      userTestData.totals.roiResets++;
      _pendingInteractions.roiResets++;
    });
  }

  const scaleSelect = document.getElementById('spectrumScale');
  if (scaleSelect) {
    scaleSelect.addEventListener('change', () => {
      userTestData.totals.spectrumScaleSwitches++;
      _pendingInteractions.spectrumScaleSwitches++;
    });
  }

  const downloadTestBtn = document.getElementById('downloadTestResults');
  if (downloadTestBtn) {
    downloadTestBtn.addEventListener('click', utDownloadResults);
  }
});

// Called from processCapturedImage — flush post-previous-capture interactions, then record this attempt.
function utOnCaptureAttempt(waveform, perf) {
  _flushPendingToLastEntry();

  const now = performance.now();
  const msSinceLast = _lastCaptureTime !== null
    ? parseFloat((now - _lastCaptureTime).toFixed(2))
    : null;
  _lastCaptureTime = now;

  userTestData.totals.captureAttempts++;
  if (perf) _perfSamples.push(perf);

  if (!waveform || waveform.length === 0) {
    utRecordCapture(true, null, msSinceLast);
    return;
  }

  userTestData.totals.successfulCaptures++;
  utShowCaptureRatingPrompt(msSinceLast);
}
