// Camera controller:
// - turns the camera on/off and switches front/back camera
// - handles ROI sliders and draws the ROI box overlay
// - captures a clean full frame and reports ROI bounds for later processing
// Build and return the camera controller used by the app.
export function createCameraController({
  video,
  processingCanvas,
  startButton,
  captureButton,
  cameraControls,
  cameraToggleButton,
  resetROIButton,
  roiElements,
  onCapture,
  onVideoSize,
}) {
  const pctx = processingCanvas.getContext('2d');
  const captureCanvas = document.createElement('canvas');
  const cctx = captureCanvas.getContext('2d');

  let currentStream = null;
  let overlayAnimationId = null;
  let preferredFacing = 'user';

  let roiTopPct = 0.0;
  let roiBottomPct = 1.0;
  let roiLeftPct = 0.0;
  let roiRightPct = 1.0;

  const {
    topInput,
    bottomInput,
    leftInput,
    rightInput,
    topVal,
    bottomVal,
    leftVal,
    rightVal,
  } = roiElements;

  // Keep the slider values and text labels in sync with the current ROI.
  function updateROIDisplayOnly() {
    if (topVal) topVal.textContent = Math.round(roiTopPct * 100) + '%';
    if (bottomVal) bottomVal.textContent = Math.round(roiBottomPct * 100) + '%';
    if (leftVal) leftVal.textContent = Math.round(roiLeftPct * 100) + '%';
    if (rightVal) rightVal.textContent = Math.round(roiRightPct * 100) + '%';

    if (topInput) topInput.value = Math.round(roiTopPct * 100);
    if (bottomInput) bottomInput.value = Math.round(roiBottomPct * 100);
    if (leftInput) leftInput.value = Math.round(roiLeftPct * 100);
    if (rightInput) rightInput.value = Math.round(roiRightPct * 100);
  }

  // Reset ROI to full frame.
  function resetROI() {
    roiTopPct = 0.0;
    roiBottomPct = 1.0;
    roiLeftPct = 0.0;
    roiRightPct = 1.0;
    updateROIDisplayOnly();
  }

  // Connect ROI sliders and keep valid top/bottom and left/right limits.
  function bindROIControls() {
    // Refresh slider labels and values after ROI changes.
    function updateDisplays() {
      if (topVal) topVal.textContent = Math.round(roiTopPct * 100) + '%';
      if (bottomVal) bottomVal.textContent = Math.round(roiBottomPct * 100) + '%';
      if (leftVal) leftVal.textContent = Math.round(roiLeftPct * 100) + '%';
      if (rightVal) rightVal.textContent = Math.round(roiRightPct * 100) + '%';
      if (topInput) topInput.value = Math.round(roiTopPct * 100);
      if (bottomInput) bottomInput.value = Math.round(roiBottomPct * 100);
      if (leftInput) leftInput.value = Math.round(roiLeftPct * 100);
      if (rightInput) rightInput.value = Math.round(roiRightPct * 100);
    }

    if (topInput && bottomInput && leftInput && rightInput) {
      topInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiTopPct = Math.min(val, roiBottomPct - 0.01);
        updateDisplays();
      });

      bottomInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiBottomPct = Math.max(val, roiTopPct + 0.01);
        updateDisplays();
      });

      leftInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiLeftPct = Math.min(val, roiRightPct - 0.01);
        updateDisplays();
      });

      rightInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiRightPct = Math.max(val, roiLeftPct + 0.01);
        updateDisplays();
      });

      updateDisplays();
    }

    if (resetROIButton) {
      resetROIButton.addEventListener('click', resetROI);
    }
  }

  // Convert ROI percentages into pixel coordinates.
  function computeROI() {
    const x = Math.floor(processingCanvas.width * roiLeftPct);
    const y = Math.floor(processingCanvas.height * roiTopPct);
    const w = Math.floor(processingCanvas.width * (roiRightPct - roiLeftPct));
    const h = Math.max(2, Math.floor(processingCanvas.height * (roiBottomPct - roiTopPct)));
    return { x, y, width: w, height: h };
  }

  // Draw a shaded overlay so the selected ROI is easy to see.
  function drawOverlay() {
    const roi = computeROI();

    pctx.save();
    pctx.fillStyle = 'rgba(0,0,0,0.25)';
    pctx.fillRect(0, 0, processingCanvas.width, roi.y);
    pctx.fillRect(0, roi.y + roi.height, processingCanvas.width, processingCanvas.height - (roi.y + roi.height));
    pctx.restore();

    pctx.save();
    pctx.strokeStyle = '#ffcc00';
    pctx.lineWidth = 2;
    pctx.setLineDash([6, 4]);
    pctx.strokeRect(roi.x + 1, roi.y + 1, roi.width - 2, roi.height - 2);
    pctx.restore();
  }

  // Keep the live overlay updating while the camera is running.
  function startOverlayLoop() {
    // Draw one overlay frame, then schedule the next one.
    function loop() {
      pctx.drawImage(video, 0, 0, processingCanvas.width, processingCanvas.height);
      drawOverlay();
      overlayAnimationId = requestAnimationFrame(loop);
    }

    if (overlayAnimationId == null) loop();
  }

  // Stop drawing the live overlay.
  function stopOverlayLoop() {
    if (overlayAnimationId != null) {
      cancelAnimationFrame(overlayAnimationId);
      overlayAnimationId = null;
    }
  }

  // Update button text so it shows which camera side is selected.
  function updateCameraToggleUI() {
    if (!cameraToggleButton) return;
    cameraToggleButton.textContent = preferredFacing === 'user' ? 'Front' : 'Back';
  }

  // Try the selected camera side first, then fall back to any camera.
  async function getFrontCameraStream() {
    const facing = preferredFacing || 'user';

    try {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing } }, audio: false });
    } catch (e) {}

    try {
      return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: false });
    } catch (e) {}

    return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }

  // Start the camera and begin drawing the overlay.
  async function startCamera() {
    if (currentStream) return;

    try {
      const stream = await getPreferredCameraStream();
      currentStream = stream;
      video.srcObject = stream;
      startOverlayLoop();
      if (cameraControls) cameraControls.classList.remove('hidden');
      if (startButton) startButton.textContent = 'Stop Camera';
    } catch (err) {
      console.error('Camera access error:', err);
    }
  }

  // Stop the camera and clear the overlay.
  function stopCamera() {
    if (currentStream) {
      try {
        currentStream.getTracks().forEach((track) => track.stop());
      } catch (e) {}
    }

    currentStream = null;
    video.srcObject = null;
    stopOverlayLoop();
    if (cameraControls) cameraControls.classList.add('hidden');
    if (startButton) startButton.textContent = 'Start Camera';
    pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
  }

  // Capture a clean frame without overlay graphics.
  // ROI bounds are returned too, so later steps can ignore pixels outside ROI
  // while keeping the same full-frame pixel layout.
  function captureCurrentFrameImageData() {
    cctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    const imageData = cctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
    const roi = computeROI();
    return { imageData, roi };
  }

  // Small wrapper so internal naming stays consistent.
  async function getPreferredCameraStream() {
    return await getFrontCameraStream();
  }

  // Set up UI events once and initialize canvas sizes when video metadata is ready.
  function init() {
    if (startButton) {
      startButton.addEventListener('click', async () => {
        if (!currentStream) {
          await startCamera();
        } else {
          stopCamera();
        }
      });
    }

    if (captureButton) {
      captureButton.addEventListener('click', () => {
        const captureResult = captureCurrentFrameImageData();
        if (!captureResult || !captureResult.imageData) return;
        if (typeof onCapture === 'function') {
          onCapture(captureResult.imageData, captureResult.roi);
        }
      });
    }

    if (cameraToggleButton) {
      cameraToggleButton.addEventListener('click', async () => {
        preferredFacing = preferredFacing === 'user' ? 'environment' : 'user';
        updateCameraToggleUI();
        if (currentStream) {
          stopCamera();
          await startCamera();
        }
      });
    }

    video.addEventListener('loadedmetadata', () => {
      processingCanvas.width = video.videoWidth;
      processingCanvas.height = video.videoHeight;
      captureCanvas.width = video.videoWidth;
      captureCanvas.height = video.videoHeight;
      bindROIControls();
      updateCameraToggleUI();

      if (typeof onVideoSize === 'function') {
        onVideoSize({ width: video.videoWidth, height: video.videoHeight });
      }
    });
  }

  return {
    init,
    startCamera,
    stopCamera,
  };
}
