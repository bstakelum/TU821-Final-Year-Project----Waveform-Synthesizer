// Main client script:
// 1) controls camera lifecycle, 2) captures ROI, 3) extracts waveform, 4) renders waveform.

// DOM Elements
const video = document.getElementById("video");
const startButton = document.getElementById("startCamera");
const captureButton = document.getElementById("captureFrame");

const processingCanvas = document.getElementById("processingCanvas");
const waveformCanvas = document.getElementById("waveformCanvas");

const pctx = processingCanvas.getContext("2d");
const wctx = waveformCanvas.getContext("2d");
// Offscreen capture buffer to avoid extracting from overlay graphics.
const captureCanvas = document.createElement('canvas');
const cctx = captureCanvas.getContext('2d');

const playSynthButton = document.getElementById('playSynth');
const synthFreqInput = document.getElementById('synthFreq');
const synthFreqVal = document.getElementById('synthFreqVal');
const audioStatusEl = document.getElementById('audioStatus');
const debugCompareEl = document.getElementById('debugCompare');
const processedPreviewCanvas = document.getElementById('processedPreviewCanvas');
const processedPreviewCtx = processedPreviewCanvas ? processedPreviewCanvas.getContext('2d') : null;

let currentStream = null;
const cameraControls = document.getElementById('cameraControls');

let audioContext = null;
let masterGainNode = null;
let synthOscillator = null;
let currentPeriodicWave = null;
let latestAudioWaveform = null;
let captureCount = 0;

// Threshold mode toggle for preprocessing.
// `true` = adaptive-thresholded binary image (white trace on black background).
// `false` = contrast-enhanced grayscale image (extraction still uses brightest-pixel search).
const useCVthreshold = true;
// Foreground acceptance threshold for CV binary mode.
const cvThresholdCutoff = 127;
// Adaptive threshold tuning parameters (must keep block size odd).
const cvAdaptiveBlockSize = 31;
const cvAdaptiveC = 13;

function setAudioStatus(text) {
  if (audioStatusEl) audioStatusEl.textContent = text;
}

function setDebugComparisonText(text) {
  if (debugCompareEl) debugCompareEl.textContent = text;
}

function renderProcessedPreview(imageData) {
  if (!processedPreviewCanvas || !processedPreviewCtx || !imageData) return;

  if (processedPreviewCanvas.width !== imageData.width || processedPreviewCanvas.height !== imageData.height) {
    processedPreviewCanvas.width = imageData.width;
    processedPreviewCanvas.height = imageData.height;
  }

  processedPreviewCtx.putImageData(imageData, 0, 0);
}

function getSynthFrequency() {
  if (!synthFreqInput) return 220;
  return Number(synthFreqInput.value) || 220;
}

function updateSynthFreqDisplay() {
  if (synthFreqVal) synthFreqVal.textContent = `${Math.round(getSynthFrequency())} Hz`;
}

function ensureAudioEngine() {
  // Lazy-init AudioContext so creation is tied to user interaction.
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Single master gain node acts as click-safe output stage.
  if (!masterGainNode) {
    masterGainNode = audioContext.createGain();
    masterGainNode.gain.value = 0;
    masterGainNode.connect(audioContext.destination);
  }
}

function buildPeriodicWaveFromSamples(samples) {
  if (!audioContext || !samples || samples.length < 4) return null;

  const sampleCount = samples.length;
  const harmonicCount = Math.min(128, Math.floor(sampleCount / 2));
  if (harmonicCount < 1) return null;

  const real = new Float32Array(harmonicCount + 1);
  const imag = new Float32Array(harmonicCount + 1);
  const norm = 2 / sampleCount;

  // Compute Fourier-series coefficients from the captured single-cycle waveform.
  for (let harmonic = 1; harmonic <= harmonicCount; harmonic++) {
    let cosineSum = 0;
    let sineSum = 0;
    for (let i = 0; i < sampleCount; i++) {
      const phase = (2 * Math.PI * harmonic * i) / sampleCount;
      const sample = samples[i];
      cosineSum += sample * Math.cos(phase);
      sineSum += sample * Math.sin(phase);
    }
    real[harmonic] = norm * cosineSum;
    imag[harmonic] = norm * sineSum;
  }

  return audioContext.createPeriodicWave(real, imag);
}

function prepareWaveformForAudio(sourceWaveform) {
  if (!sourceWaveform || sourceWaveform.length === 0) return null;

  // Copy into a clean finite buffer and track peak for normalization.
  const prepared = new Float32Array(sourceWaveform.length);
  let peak = 0;
  for (let i = 0; i < sourceWaveform.length; i++) {
    const value = Number.isFinite(sourceWaveform[i]) ? sourceWaveform[i] : 0;
    prepared[i] = value;
    const absValue = Math.abs(value);
    if (absValue > peak) peak = absValue;
  }

  if (peak < 1e-6) return null;

  if (peak > 1) {
    const invPeak = 1 / peak;
    for (let i = 0; i < prepared.length; i++) {
      prepared[i] *= invPeak;
    }
  }

  return prepared;
}

function updateSynthWaveform(waveform) {
  // Convert extracted visual waveform into a playable single-cycle table.
  latestAudioWaveform = prepareWaveformForAudio(waveform);
  if (!latestAudioWaveform) {
    currentPeriodicWave = null;
    if (!synthOscillator) setAudioStatus('Audio: no usable waveform');
    return;
  }

  if (audioContext) {
    currentPeriodicWave = buildPeriodicWaveFromSamples(latestAudioWaveform);
    if (synthOscillator && currentPeriodicWave) {
      synthOscillator.setPeriodicWave(currentPeriodicWave);
    }
  }

  if (!synthOscillator) setAudioStatus('Audio: waveform ready');
}

async function startSynth() {
  if (synthOscillator) return;
  if (!latestAudioWaveform) {
    setAudioStatus('Audio: capture a waveform first');
    return;
  }

  ensureAudioEngine();
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  if (!currentPeriodicWave) {
    currentPeriodicWave = buildPeriodicWaveFromSamples(latestAudioWaveform);
  }

  // Build oscillator on demand so each start gets fresh node state.
  synthOscillator = audioContext.createOscillator();
  synthOscillator.frequency.value = getSynthFrequency();
  if (currentPeriodicWave) {
    synthOscillator.setPeriodicWave(currentPeriodicWave);
  }
  synthOscillator.connect(masterGainNode);

  // Short fade-in to avoid clicks at note start.
  const now = audioContext.currentTime;
  masterGainNode.gain.cancelScheduledValues(now);
  masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
  masterGainNode.gain.linearRampToValueAtTime(0.08, now + 0.03);

  synthOscillator.start();
  synthOscillator.onended = () => {
    if (synthOscillator) return;
    setAudioStatus('Audio: idle');
  };

  if (playSynthButton) playSynthButton.textContent = 'Stop';
  setAudioStatus('Audio: playing');
}

function stopSynth() {
  if (!audioContext || !synthOscillator) return;

  // Keep reference so we can null active state before scheduled stop.
  const osc = synthOscillator;
  synthOscillator = null;
  // Short fade-out to avoid clicks at note stop.
  const now = audioContext.currentTime;

  masterGainNode.gain.cancelScheduledValues(now);
  masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
  masterGainNode.gain.linearRampToValueAtTime(0, now + 0.03);

  osc.stop(now + 0.04);
  osc.disconnect();
  if (playSynthButton) playSynthButton.textContent = 'Play';
  setAudioStatus('Audio: idle');
}

async function toggleSynth() {
  // Single control button toggles between running/stopped synth states.
  if (synthOscillator) {
    stopSynth();
    return;
  }
  await startSynth();
}

if (playSynthButton) {
  playSynthButton.addEventListener('click', () => {
    toggleSynth().catch((err) => {
      console.error('Audio start error:', err);
      setAudioStatus('Audio: failed to start');
    });
  });
}

if (synthFreqInput) {
  synthFreqInput.addEventListener('input', () => {
    updateSynthFreqDisplay();
    if (synthOscillator && audioContext) {
      synthOscillator.frequency.setTargetAtTime(getSynthFrequency(), audioContext.currentTime, 0.01);
    }
  });
}

updateSynthFreqDisplay();

// ROI percentages (0..1)
let roiTopPct = 0.0;
let roiBottomPct = 1.0;
let roiLeftPct = 0.0;
let roiRightPct = 1.0;

// DOM references for ROI controls (populated in bindROIControls)
let roiTopInput, roiBottomInput, roiLeftInput, roiRightInput;
let roiTopValSpan, roiBottomValSpan, roiLeftValSpan, roiRightValSpan;

// Bind ROI sliders when DOM is ready
function bindROIControls() {
  roiTopInput = document.getElementById('roiTop');
  roiBottomInput = document.getElementById('roiBottom');
  roiLeftInput = document.getElementById('roiLeft');
  roiRightInput = document.getElementById('roiRight');
  roiTopValSpan = document.getElementById('roiTopVal');
  roiBottomValSpan = document.getElementById('roiBottomVal');
  roiLeftValSpan = document.getElementById('roiLeftVal');
  roiRightValSpan = document.getElementById('roiRightVal');

  function updateDisplays() {
    if (roiTopValSpan) roiTopValSpan.textContent = Math.round(roiTopPct * 100) + '%';
    if (roiBottomValSpan) roiBottomValSpan.textContent = Math.round(roiBottomPct * 100) + '%';
    if (roiLeftValSpan) roiLeftValSpan.textContent = Math.round(roiLeftPct * 100) + '%';
    if (roiRightValSpan) roiRightValSpan.textContent = Math.round(roiRightPct * 100) + '%';
    if (roiTopInput) roiTopInput.value = Math.round(roiTopPct * 100);
    if (roiBottomInput) roiBottomInput.value = Math.round(roiBottomPct * 100);
    if (roiLeftInput) roiLeftInput.value = Math.round(roiLeftPct * 100);
    if (roiRightInput) roiRightInput.value = Math.round(roiRightPct * 100);
  }

  if (roiTopInput && roiBottomInput && roiLeftInput && roiRightInput) {
    roiTopInput.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 100;
      roiTopPct = Math.min(val, roiBottomPct - 0.01);
      updateDisplays();
    });

    roiBottomInput.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 100;
      roiBottomPct = Math.max(val, roiTopPct + 0.01);
      updateDisplays();
    });

    roiLeftInput.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 100;
      // clamp so left < right - allow tiny separation
      roiLeftPct = Math.min(val, roiRightPct - 0.01);
      updateDisplays();
    });

    roiRightInput.addEventListener('input', (e) => {
      const val = Number(e.target.value) / 100;
      roiRightPct = Math.max(val, roiLeftPct + 0.01);
      updateDisplays();
    });

    // Reset button
    const resetBtn = document.getElementById('resetROI');
    if (resetBtn) resetBtn.addEventListener('click', resetROI);

    updateDisplays();
  }
}

function updateROIDisplayOnly() {
  if (roiTopValSpan) roiTopValSpan.textContent = Math.round(roiTopPct * 100) + '%';
  if (roiBottomValSpan) roiBottomValSpan.textContent = Math.round(roiBottomPct * 100) + '%';
  if (roiLeftValSpan) roiLeftValSpan.textContent = Math.round(roiLeftPct * 100) + '%';
  if (roiRightValSpan) roiRightValSpan.textContent = Math.round(roiRightPct * 100) + '%';
  if (roiTopInput) roiTopInput.value = Math.round(roiTopPct * 100);
  if (roiBottomInput) roiBottomInput.value = Math.round(roiBottomPct * 100);
  if (roiLeftInput) roiLeftInput.value = Math.round(roiLeftPct * 100);
  if (roiRightInput) roiRightInput.value = Math.round(roiRightPct * 100);
}

function resetROI() {
  // default ROI values
  roiTopPct = 0.0;
  roiBottomPct = 1.0;
  roiLeftPct = 0.0;
  roiRightPct = 1.0;
  updateROIDisplayOnly();
}

// Camera Setup (start/stop toggle)
// Prefer front-facing camera helper
async function getFrontCameraStream() {
  // Use the preferred facing mode (front/back)
  const facing = preferredFacing || 'user';
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } }, audio: false });
  } catch (e) {}

  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
  } catch (e) {}

  // Fallback: request any camera
  return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
}

startButton.addEventListener("click", async () => {
  if (!currentStream) {
    await startCamera();
  } else {
    stopCamera();
  }
});

// Start camera helper (uses preferred facing)
async function startCamera() {
  if (currentStream) return;
  try {
    const stream = await getPreferredCameraStream();
    currentStream = stream;
    video.srcObject = stream;
    startOverlayLoop();
    if (cameraControls) cameraControls.classList.remove('hidden');
    startButton.textContent = 'Stop Camera';
  } catch (err) {
    console.error('Camera access error:', err);
  }
}

// Stop camera helper
function stopCamera() {
  if (currentStream) {
    try { currentStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  }
  currentStream = null;
  video.srcObject = null;
  stopOverlayLoop();
  if (cameraControls) cameraControls.classList.add('hidden');
  startButton.textContent = 'Start Camera';
  pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
}

// Once video data is available 
video.addEventListener("loadedmetadata", () => {
  processingCanvas.width = video.videoWidth;
  processingCanvas.height = video.videoHeight;
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;

  // Keep one-to-one horizontal sampling between camera frame and synthesis display.
  waveformCanvas.width = processingCanvas.width;
  waveformCanvas.height = 256;
  bindROIControls();
  // initialize camera toggle UI
  updateCameraToggleUI();
});

// Capture Frame (process current ROI from the live overlay)
captureButton.addEventListener("click", () => {
  processImage();
});

// Compute ROI rectangle (full width, centered vertical region)
function computeROI() {
  const x = Math.floor(processingCanvas.width * roiLeftPct);
  const y = Math.floor(processingCanvas.height * roiTopPct);
  const w = Math.floor(processingCanvas.width * (roiRightPct - roiLeftPct));
  const h = Math.max(2, Math.floor(processingCanvas.height * (roiBottomPct - roiTopPct)));
  return { x, y, width: w, height: h };
}

// Draw dashed ROI overlay on the processing canvas
function drawOverlay() {
  const roi = computeROI();

  // dim outside area
  pctx.save();
  pctx.fillStyle = 'rgba(0,0,0,0.25)';
  pctx.fillRect(0, 0, processingCanvas.width, roi.y);
  pctx.fillRect(0, roi.y + roi.height, processingCanvas.width, processingCanvas.height - (roi.y + roi.height));
  pctx.restore();

  // dashed rectangle
  pctx.save();
  pctx.strokeStyle = '#ffcc00';
  pctx.lineWidth = 2;
  pctx.setLineDash([6, 4]);
  pctx.strokeRect(roi.x + 1, roi.y + 1, roi.width - 2, roi.height - 2);
  pctx.restore();
}

let overlayAnimationId = null;
function startOverlayLoop() {
  function loop() {
    // draw current video frame into processing canvas
    pctx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
    drawOverlay();
    overlayAnimationId = requestAnimationFrame(loop);
  }
  if (overlayAnimationId == null) loop();
}

function stopOverlayLoop() {
  if (overlayAnimationId != null) {
    cancelAnimationFrame(overlayAnimationId);
    overlayAnimationId = null;
  }
}

// OpenCV integration
let hasOpenCV = false;

function setOpenCVStatus(text) {
  const el = document.getElementById('opencvStatus');
  if (el) el.textContent = text;
}

// Poll for OpenCV runtime availability before enabling capture processing.
function waitForCV(timeout = 8000) {
  const start = performance.now();
  return new Promise((resolve) => {
    (function poll() {
      if (typeof cv !== 'undefined') {
        // If runtime already initialized, accept immediately
        if (cv && cv.getBuildInformation) {
          resolve(true);
          return;
        }

        // Otherwise wait for onRuntimeInitialized
        cv['onRuntimeInitialized'] = () => resolve(true);
        return;
      }
      if (performance.now() - start > timeout) {
        resolve(false);
        return;
      }
      setTimeout(poll, 200);
    })();
  });
}

async function initOpenCV() {
  setOpenCVStatus('OpenCV: checking…');

  const scriptPresent = Array.from(document.scripts).some(s => s.src && s.src.includes('opencv.js'));
  if (!scriptPresent) {
    console.warn('OpenCV.js script tag not found.');
    setOpenCVStatus('OpenCV: not included');
    hasOpenCV = false;
    return;
  }

  const ok = await waitForCV(8000);
  if (ok) {
    hasOpenCV = true;
    setOpenCVStatus('OpenCV: ready');
    console.log('OpenCV.js ready');
  } else {
    hasOpenCV = false;
    setOpenCVStatus('OpenCV: not available');
    console.warn('OpenCV.js did not initialize in time.');
  }
}

initOpenCV();

// Camera preference toggle (front/back)
let preferredFacing = 'user'; // 'user' (front) or 'environment' (back)

function updateCameraToggleUI() {
  const btn = document.getElementById('cameraToggle');
  if (!btn) return;
  btn.textContent = preferredFacing === 'user' ? 'Front' : 'Back';
}

// Toggle camera preference and restart camera if already active
const cameraToggleBtn = document.getElementById('cameraToggle');
if (cameraToggleBtn) {
  cameraToggleBtn.addEventListener('click', async () => {
    preferredFacing = preferredFacing === 'user' ? 'environment' : 'user';
    updateCameraToggleUI();
    if (currentStream) {
      // restart camera with new facing preference
      stopCamera();
      await startCamera();
    }
  });
}

function preprocessImageOpenCV(imageData) {
  if (!hasOpenCV || typeof cv === 'undefined') return null;

  let src = null;
  let gray = null;
  let denoised = null;
  let background = null;
  let flattened = null;
  let contrastEnhanced = null;
  let thresholded = null;
  let opened = null;
  let closed = null;
  let rgba = null;
  let clahe = null;
  let openKernel = null;
  let closeKernel = null;

  try {
    src = cv.matFromImageData(imageData);
    gray = new cv.Mat();
    denoised = new cv.Mat();
    background = new cv.Mat();
    flattened = new cv.Mat();
    contrastEnhanced = new cv.Mat();
    thresholded = new cv.Mat();
    opened = new cv.Mat();
    closed = new cv.Mat();
    rgba = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // Step 1: light denoise to suppress fine sensor texture.
    cv.GaussianBlur(gray, denoised, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);

    // Step 2: estimate low-frequency illumination (shadows/gradients).
    cv.GaussianBlur(denoised, background, new cv.Size(31, 31), 0, 0, cv.BORDER_DEFAULT);

    // Step 3: remove illumination bias while keeping trace polarity for the extractor.
    cv.addWeighted(denoised, 1.0, background, -1.0, 128.0, flattened);

    // Step 4: boost local contrast without strong global noise amplification.
    clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
    clahe.apply(flattened, contrastEnhanced);

    // Step 5: optional CV adaptive thresholding for binary extraction mode.
    if (useCVthreshold) {
      cv.adaptiveThreshold(
        contrastEnhanced,
        thresholded,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        cvAdaptiveBlockSize,
        cvAdaptiveC
      );
      openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      // Remove isolated white dots (salt noise).
      cv.morphologyEx(thresholded, opened, cv.MORPH_OPEN, openKernel);
      closeKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      // Reconnect short breaks in the trace after opening.
      cv.morphologyEx(opened, closed, cv.MORPH_CLOSE, closeKernel);
      cv.cvtColor(closed, rgba, cv.COLOR_GRAY2RGBA);
    } else {
      cv.cvtColor(contrastEnhanced, rgba, cv.COLOR_GRAY2RGBA);
    }

    return new ImageData(
      new Uint8ClampedArray(rgba.data),
      imageData.width,
      imageData.height
    );
  } catch (err) {
    console.warn('OpenCV preprocessing failed.', err);
    return null;
  } finally {
    if (closeKernel) closeKernel.delete();
    if (openKernel) openKernel.delete();
    if (clahe) clahe.delete();
    if (rgba) rgba.delete();
    if (closed) closed.delete();
    if (opened) opened.delete();
    if (thresholded) thresholded.delete();
    if (contrastEnhanced) contrastEnhanced.delete();
    if (flattened) flattened.delete();
    if (background) background.delete();
    if (denoised) denoised.delete();
    if (gray) gray.delete();
    if (src) src.delete();
  }
}

// --- end OpenCV enhancements ---

// Image Processing
function processImage() {
  const roi = computeROI();
  // Read only the selected ROI from a clean frame (without overlay graphics).
  cctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  const imageData = cctx.getImageData(roi.x, roi.y, roi.width, roi.height);
  const processedImageData = preprocessImageOpenCV(imageData);
  if (!processedImageData) {
    setOpenCVStatus('OpenCV: preprocessing failed');
    captureCount++;
    setDebugComparisonText(`Capture ${captureCount}\nOpenCV: preprocessing failed`);
    return;
  }

  renderProcessedPreview(processedImageData);

  extractWaveformLoop(processedImageData);
}

function analyzeWaveformReadonly(waveform) {
  const total = waveform.length || 1;
  let validCount = 0;
  let nanCount = 0;
  let longestNaNRun = 0;
  let currentNaNRun = 0;
  let jumpSum = 0;
  let jumpCount = 0;
  let lastValidValue = null;

  for (let i = 0; i < waveform.length; i++) {
    const value = waveform[i];
    if (Number.isNaN(value)) {
      nanCount++;
      currentNaNRun++;
      if (currentNaNRun > longestNaNRun) longestNaNRun = currentNaNRun;
      continue;
    }

    validCount++;
    currentNaNRun = 0;
    if (lastValidValue !== null) {
      jumpSum += Math.abs(value - lastValidValue);
      jumpCount++;
    }
    lastValidValue = value;
  }

  const interpCopy = Float32Array.from(waveform);
  interpolateWaveform(interpCopy);
  let postInterpNaN = 0;
  for (let i = 0; i < interpCopy.length; i++) {
    if (Number.isNaN(interpCopy[i])) postInterpNaN++;
  }

  return {
    total,
    validCount,
    validPct: (validCount / total) * 100,
    nanCount,
    longestNaNRun,
    avgJump: jumpCount > 0 ? jumpSum / jumpCount : 0,
    postInterpNaN,
  };
}

function formatWaveformMetrics(metrics) {
  return `valid ${metrics.validPct.toFixed(1)}% (${metrics.validCount}/${metrics.total}), NaN ${metrics.nanCount}, longest gap ${metrics.longestNaNRun}, avg jump ${metrics.avgJump.toFixed(4)}, NaN after interp ${metrics.postInterpNaN}`;
}

// Main extraction loop
function extractWaveformLoop(imageData) {
  const { width, height, data } = imageData;
  // One normalized amplitude value per x-column.
  const waveform = new Float32Array(width);

  const maxYDelta = 40; // max allowed vertical jump (pixels) from previous column when valid
  let lastValidYPos = null;

  // Scan each column independently to choose one y position.
  for (let x = 0; x < width; x++) {
    let yPos = -1; // -1 means "no valid pixel found"
    let maxBrightness = -1;

    // Search top->bottom for the brightest candidate that also stays near last valid y.
    for (let y = 0; y < height; y++) {
      const index = (y * width + x) * 4;
      const brightness = data[index];
      const withinContinuity = lastValidYPos === null || Math.abs(lastValidYPos - y) <= maxYDelta;

      if (brightness > maxBrightness && withinContinuity) {
        maxBrightness = brightness;
        yPos = y;
      }
    }

    // Accept this column when the brightest candidate is strong enough.
    const columnIsValid = yPos > 0 && maxBrightness >= cvThresholdCutoff;

    if (columnIsValid) {
      // Convert pixel y (0..height) to normalized amplitude (+1..-1).
      waveform[x] = 1 - (yPos / height) * 2;
      // Track continuity anchor for the next column.
      lastValidYPos = yPos;
    } else {
      waveform[x] = NaN; // set column as NaN to be skipped
    }
  }

  const metrics = analyzeWaveformReadonly(waveform);
  captureCount++;
  setDebugComparisonText(`Capture ${captureCount}\nOpenCV waveform: ${formatWaveformMetrics(metrics)}`);

  interpolateWaveform(waveform);
  zeroAndCenterWaveform(waveform);
  updateSynthWaveform(waveform);
  drawWaveform(waveform);
}

function zeroAndCenterWaveform(waveform) {
  let sum = 0;
  let count = 0;

  // Replace unresolved points with zero so downstream output is finite.
  for (let i = 0; i < waveform.length; i++) {
    if (isNaN(waveform[i])) {
      waveform[i] = 0;
    }
    sum += waveform[i];
    count++;
  }

  // Remove DC offset so the waveform is centered around zero.
  const mean = count > 0 ? sum / count : 0;
  for (let i = 0; i < waveform.length; i++) {
    waveform[i] = waveform[i] - mean;
  }
}

// Draw Waveform
function drawWaveform(waveform) {
  wctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  wctx.strokeStyle = "#ffffff";
  wctx.lineWidth = 2;

  // Draw contiguous non-NaN segments and break the line at NaN gaps.
  let isDrawing = false;

  for (let i = 0; i < waveform.length; i++) {
    const value = waveform[i];
    
    if (isNaN(value)) {
      if (isDrawing) {
        wctx.stroke();
        isDrawing = false;
      }
      continue;
    }

    const x = (i / waveform.length) * waveformCanvas.width;
    const y = (1 - (value + 1) / 2) * waveformCanvas.height;

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

function interpolateWaveform(waveform) {
  // - only fill gaps up to `maxGap` columns wide
  const maxGap = 30; // horizontal gap (columns)
  let i = 0;
  while (i < waveform.length) {
    // Skip columns that already have a valid waveform point.
    if (!isNaN(waveform[i])) {
      i++;
      continue;
    }

    // We found a NaN run. `start` is the last valid index before the gap.
    const start = i - 1;

    // Move `i` to the first valid index after this NaN run.
    while (i < waveform.length && isNaN(waveform[i])) {
      i++;
    }

    // `end` is first valid index after gap; `gap` is number of NaN slots between start/end.
    const end = i;
    const gap = end - start - 1;

    // Interpolate only when both endpoints exist and the gap is small enough.
    if (start >= 0 && end < waveform.length && gap <= maxGap) {
      const startValue = waveform[start];
      const endValue = waveform[end];
      for (let j = 1; j <= gap; j++) {
        // j/(gap+1) gives evenly spaced positions between the two endpoints.
        waveform[start + j] = startValue + (endValue - startValue) * (j / (gap + 1));
      }
    }
  }
}

// Backwards-compatible alias used by the toggle handler
async function getPreferredCameraStream() {
  // Kept as a stable wrapper in case call sites still use the previous name.
  return await getFrontCameraStream();
}