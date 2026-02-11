// DOM Elements
const video = document.getElementById("video");
const startButton = document.getElementById("startCamera");
const captureButton = document.getElementById("captureFrame");

const processingCanvas = document.getElementById("processingCanvas");
const waveformCanvas = document.getElementById("waveformCanvas");

const pctx = processingCanvas.getContext("2d");
const wctx = waveformCanvas.getContext("2d");

let currentStream = null;
const cameraControls = document.getElementById('cameraControls');

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

  waveformCanvas.width = 512;
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
  const h = Math.floor(processingCanvas.height * (roiBottomPct - roiTopPct));
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
    console.warn('OpenCV.js script tag not found — continuing without OpenCV');
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
    console.warn('OpenCV.js did not initialize in time — continuing with fallback pipeline');
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

function savitzkyGolaySmooth(waveform) {
  // simple SG window=5, order=2 coefficients: [-3,12,17,12,-3]/35
  const n = waveform.length;
  const out = waveform.slice();
  for (let i = 2; i < n - 2; i++) {
    const a = waveform[i - 2], b = waveform[i - 1], c = waveform[i], d = waveform[i + 1], e = waveform[i + 2];
    if ([a, b, c, d, e].some(v => isNaN(v))) continue;
    out[i] = (-3 * a + 12 * b + 17 * c + 12 * d - 3 * e) / 35;
  }
  return out;
}

function extractWaveformOpenCV(imageData) {
  try {
    const width = imageData.width;
    const height = imageData.height;

    const src = cv.matFromImageData(imageData);
    let gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    // CLAHE to improve local contrast
    let claheDst = new cv.Mat();
    try {
      const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
      clahe.apply(gray, claheDst);
      clahe.delete();
    } catch (e) {
      // fallback if CLAHE not supported
      gray.copyTo(claheDst);
    }

    // Adaptive threshold (black trace on white background -> invert so trace is white)
    let thresh = new cv.Mat();
    cv.adaptiveThreshold(claheDst, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 7);

    // Morphology to remove small specks
    let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    let morph = new cv.Mat();
    cv.morphologyEx(thresh, morph, cv.MORPH_OPEN, kernel);

    // Find contours and choose the largest external contour (likely the trace)
    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(morph, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    let mask = new cv.Mat.zeros(morph.rows, morph.cols, cv.CV_8UC1);
    let largestArea = 0;
    let largestIdx = -1;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area > largestArea) {
        largestArea = area;
        largestIdx = i;
      }
    }
    if (largestIdx >= 0) {
      const color = new cv.Scalar(255);
      cv.drawContours(mask, contours, largestIdx, color, -1);
    }

    // Build waveform by column: compute centroid (mean y) of mask pixels per column
    const waveform = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < height; y++) {
        if (mask.ucharPtr(y, x)[0] > 0) {
          sumY += y;
          count++;
        }
      }
      if (count > 0) {
        const meanY = sumY / count;
        waveform[x] = 1 - (meanY / height) * 2;
      } else {
        waveform[x] = NaN;
      }
    }

    // optional smoothing (preserves edges better than naive averaging)
    const smoothed = savitzkyGolaySmooth(waveform);

    // Cleanup
    src.delete(); gray.delete(); claheDst.delete(); thresh.delete(); kernel.delete(); morph.delete(); contours.delete(); hierarchy.delete(); mask.delete();

    return smoothed;
  } catch (err) {
    console.error('OpenCV extraction failed:', err);
    return null;
  }
}

// --- end OpenCV enhancements ---

// Image Processing
function processImage() {
  const roi = computeROI();
  const imageData = pctx.getImageData(roi.x, roi.y, roi.width, roi.height);
  const data = imageData.data;

  // Convert to grayscale with contrast enhancement
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Standard grayscale conversion
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;

    // Apply contrast enhancement (S-curve adjustment)
    // This darkens darks and brightens brights
    gray = gray / 255;
    gray = gray < 0.5 ? 2 * gray * gray : 1 - 2 * (1 - gray) * (1 - gray);
    gray = gray * 255;

    data[i] = data[i + 1] = data[i + 2] = gray;
  }

  // Put the processed grayscale back into the ROI so user can inspect it briefly
  pctx.putImageData(imageData, roi.x, roi.y);

  extractWaveform(imageData);
}

// Waveform Extraction
function extractWaveform(imageData) {
  // If OpenCV is available and initialized, use the enhanced pipeline
  if (hasOpenCV) {
    const wf = extractWaveformOpenCV(imageData);
    if (wf) {
      // still run lightweight interpolation to fill small NaN gaps
      interpolateWaveform(wf);
      drawWaveform(wf);
      return;
    }
    // fall through to JS pipeline on failure
  }
  // Fallback to the simple per-column darkest-pixel method
  extractWaveformFallback(imageData);
}

// Fallback extraction (original simple method)
function extractWaveformFallback(imageData) {
  const { width, height, data } = imageData;
  const waveform = new Float32Array(width);

  const threshold = 120; // pick a value between 0 (black) and 255 (white)

  for (let x = 0; x < width; x++) {
    let minBrightness = 255;
    let yPos = -1; // -1 means "no dark pixel found"

    for (let y = 0; y < height; y++) {
      const index = (y * width + x) * 4;
      const brightness = data[index];

      if (brightness < minBrightness) {
        minBrightness = brightness;
        yPos = y;
      }
    }

    // Only include this column if the darkest pixel is below threshold
    if (minBrightness < threshold) {
      waveform[x] = 1 - (yPos / height) * 2;
    } else {
      waveform[x] = NaN; // set column as NaN to be skipped
    }
  }

  interpolateWaveform(waveform);
  drawWaveform(waveform);
}

// Draw Waveform
function drawWaveform(waveform) {
  wctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  wctx.strokeStyle = "#00ffcc";
  wctx.lineWidth = 2;

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
  // - only interpolate when the vertical difference between endpoints is small (maxDelta)
  const maxGap = 30; // horizontal gap (columns)
  const maxDelta = 0.2; // maximum allowed endpoint difference in waveform units (-1..1)
  let lastValidIndex = null;

  for (let i = 0; i < waveform.length; i++) {
    const val = waveform[i];
    if (!isNaN(val)) {
      if (lastValidIndex !== null && lastValidIndex + 1 !== i) {
        const gap = i - lastValidIndex;
        if (gap <= maxGap) {
          const startValue = waveform[lastValidIndex];
          const endValue = waveform[i];
          if (!isNaN(startValue) && !isNaN(endValue) && Math.abs(endValue - startValue) <= maxDelta) {
            for (let j = 1; j < gap; j++) {
              waveform[lastValidIndex + j] = startValue + (endValue - startValue) * (j / gap);
            }
          }
        }
      }
      lastValidIndex = i;
    }
  }
}

// Backwards-compatible alias used by the toggle handler
async function getPreferredCameraStream() {
  return await getFrontCameraStream();
}