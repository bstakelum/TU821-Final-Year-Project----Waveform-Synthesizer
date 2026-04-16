// Camera controller:
// - starts and stops the camera
// - manages the ROI sliders and overlay
// - captures the current frame for waveform extraction
export function createCameraController({
  video,
  processingCanvas,
  startButton,
  captureButton,
  cameraControls,
  cameraToggleButton,
  resetROIButton,
  getTargetAspectRatio,
  roiElements,
  onCapture,
  onVideoSize,
}) {
  const ROI_MIN_GAP_RATIO = 0.01;
  const ROI_HANDLE_HIT_PADDING_PX = 18;
  const ROI_HANDLE_SIZE_PX = 10;
  const ROI_MIN_HEIGHT_PX = 2;
  const ROI_MIN_WIDTH_PX = 2;

  const pctx = processingCanvas.getContext('2d');
  const captureCanvas = document.createElement('canvas');
  const cctx = captureCanvas.getContext('2d');

  let currentStream = null;
  let overlayAnimationId = null;
  let preferredFacing = 'user';
  let roiControlsBound = false;
  let currentFrameRect = { x: 0, y: 0, width: 0, height: 0 };
  let roiTopPct = 0.0;
  let roiBottomPct = 1.0;
  let roiLeftPct = 0.0;
  let roiRightPct = 1.0;
  let roiPointerState = null;

  const {
    topInput,
    bottomInput,
    leftInput,
    rightInput,
    topVal,
    bottomVal,
    leftVal,
    rightVal,
  } = roiElements || {};

  // Hook up the buttons and sliders.
  function init() {
    bindROIControls();
    bindROIInteractionHandlers();
    updateCameraToggleUI();

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
      syncPreviewFrameRect();
    });
  }

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

  function stopCamera() {
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
    }

    currentStream = null;
    video.srcObject = null;
    stopOverlayLoop();
    if (cameraControls) cameraControls.classList.add('hidden');
    if (startButton) startButton.textContent = 'Start Camera';
    pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
  }

  function getVideoSourceSize() {
    const sourceWidth = Math.max(0, Math.round(video.videoWidth || 0));
    const sourceHeight = Math.max(0, Math.round(video.videoHeight || 0));
    return { sourceWidth, sourceHeight };
  }

  function getEffectiveAspectRatio(sourceWidth, sourceHeight) {
    const fallbackAspectRatio = sourceWidth > 0 && sourceHeight > 0
      ? sourceWidth / sourceHeight
      : (4 / 3);
    const requestedAspectRatio = typeof getTargetAspectRatio === 'function'
      ? Number(getTargetAspectRatio())
      : NaN;

    return Number.isFinite(requestedAspectRatio) && requestedAspectRatio > 0
      ? requestedAspectRatio
      : fallbackAspectRatio;
  }

  function getFrameRectForAspectRatio(sourceWidth, sourceHeight, targetAspectRatio) {
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const sourceAspectRatio = sourceWidth / sourceHeight;
    if (!Number.isFinite(targetAspectRatio) || targetAspectRatio <= 0 || Math.abs(sourceAspectRatio - targetAspectRatio) < 0.01) {
      return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
    }

    if (sourceAspectRatio > targetAspectRatio) {
      const croppedWidth = Math.max(1, Math.round(sourceHeight * targetAspectRatio));
      const offsetX = Math.max(0, Math.floor((sourceWidth - croppedWidth) / 2));
      return { x: offsetX, y: 0, width: croppedWidth, height: sourceHeight };
    }

    const croppedHeight = Math.max(1, Math.round(sourceWidth / targetAspectRatio));
    const offsetY = Math.max(0, Math.floor((sourceHeight - croppedHeight) / 2));
    return { x: 0, y: offsetY, width: sourceWidth, height: croppedHeight };
  }

  function syncPreviewFrameRect() {
    const { sourceWidth, sourceHeight } = getVideoSourceSize();
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return;
    }

    const targetAspectRatio = getEffectiveAspectRatio(sourceWidth, sourceHeight);
    currentFrameRect = getFrameRectForAspectRatio(sourceWidth, sourceHeight, targetAspectRatio);

    processingCanvas.width = currentFrameRect.width;
    processingCanvas.height = currentFrameRect.height;
    captureCanvas.width = currentFrameRect.width;
    captureCanvas.height = currentFrameRect.height;

    if (typeof onVideoSize === 'function') {
      onVideoSize({ width: currentFrameRect.width, height: currentFrameRect.height });
    }
  }

  function captureCurrentFrameImageData() {
    if (video.readyState < 2 || captureCanvas.width === 0 || captureCanvas.height === 0) {
      return null;
    }
    // Copy the current video frame into an offscreen canvas.
    cctx.drawImage(
      video,
      currentFrameRect.x,
      currentFrameRect.y,
      currentFrameRect.width,
      currentFrameRect.height,
      0,
      0,
      captureCanvas.width,
      captureCanvas.height,
    );
    const imageData = cctx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);
    const roi = computeROI();
    return { imageData, roi };
  }

  function getCurrentVideoTrackSettings() {
    if (!currentStream) return null;
    const tracks = currentStream.getVideoTracks();
    if (!tracks || tracks.length === 0) return null;
    const track = tracks[0];
    if (!track || typeof track.getSettings !== 'function') return null;
    return track.getSettings();
  }

  // Keep the slider values and labels in sync.
  function syncROIDisplay() {
    if (topVal) topVal.textContent = Math.round(roiTopPct * 100) + '%';
    if (bottomVal) bottomVal.textContent = Math.round(roiBottomPct * 100) + '%';
    if (leftVal) leftVal.textContent = Math.round(roiLeftPct * 100) + '%';
    if (rightVal) rightVal.textContent = Math.round(roiRightPct * 100) + '%';

    if (topInput) topInput.value = Math.round(roiTopPct * 100);
    if (bottomInput) bottomInput.value = Math.round(roiBottomPct * 100);
    if (leftInput) leftInput.value = Math.round(roiLeftPct * 100);
    if (rightInput) rightInput.value = Math.round(roiRightPct * 100);
  }

  function clampROI(nextLeftPct, nextTopPct, nextRightPct, nextBottomPct) {
    const minWidthRatio = processingCanvas.width > 0
      ? Math.max(ROI_MIN_GAP_RATIO, ROI_MIN_WIDTH_PX / processingCanvas.width)
      : ROI_MIN_GAP_RATIO;
    const minHeightRatio = processingCanvas.height > 0
      ? Math.max(ROI_MIN_GAP_RATIO, ROI_MIN_HEIGHT_PX / processingCanvas.height)
      : ROI_MIN_GAP_RATIO;

    let leftPct = Math.max(0, Math.min(nextLeftPct, 1 - minWidthRatio));
    let topPct = Math.max(0, Math.min(nextTopPct, 1 - minHeightRatio));
    let rightPct = Math.min(1, Math.max(nextRightPct, minWidthRatio));
    let bottomPct = Math.min(1, Math.max(nextBottomPct, minHeightRatio));

    if (rightPct - leftPct < minWidthRatio) {
      if (leftPct !== roiLeftPct) {
        rightPct = Math.min(1, leftPct + minWidthRatio);
      } else {
        leftPct = Math.max(0, rightPct - minWidthRatio);
      }
    }

    if (bottomPct - topPct < minHeightRatio) {
      if (topPct !== roiTopPct) {
        bottomPct = Math.min(1, topPct + minHeightRatio);
      } else {
        topPct = Math.max(0, bottomPct - minHeightRatio);
      }
    }

    roiLeftPct = leftPct;
    roiTopPct = topPct;
    roiRightPct = rightPct;
    roiBottomPct = bottomPct;
  }

  // Reset the ROI to the full frame.
  function resetROI() {
    roiTopPct = 0.0;
    roiBottomPct = 1.0;
    roiLeftPct = 0.0;
    roiRightPct = 1.0;
    syncROIDisplay();
  }

  // Connect ROI controls.
  function bindROIControls() {
    if (roiControlsBound) {
      syncROIDisplay();
      return;
    }

    if (topInput && bottomInput && leftInput && rightInput) {
      topInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiTopPct = Math.min(val, roiBottomPct - ROI_MIN_GAP_RATIO);
        syncROIDisplay();
      });

      bottomInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiBottomPct = Math.max(val, roiTopPct + ROI_MIN_GAP_RATIO);
        syncROIDisplay();
      });

      leftInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiLeftPct = Math.min(val, roiRightPct - ROI_MIN_GAP_RATIO);
        syncROIDisplay();
      });

      rightInput.addEventListener('input', (event) => {
        const val = Number(event.target.value) / 100;
        roiRightPct = Math.max(val, roiLeftPct + ROI_MIN_GAP_RATIO);
        syncROIDisplay();
      });
    }

    if (resetROIButton) {
      resetROIButton.addEventListener('click', resetROI);
    }

    roiControlsBound = true;
    syncROIDisplay();
  }

  function getPointerPosition(event) {
    const bounds = processingCanvas.getBoundingClientRect();
    const scaleX = bounds.width > 0 ? processingCanvas.width / bounds.width : 1;
    const scaleY = bounds.height > 0 ? processingCanvas.height / bounds.height : 1;

    return {
      x: (event.clientX - bounds.left) * scaleX,
      y: (event.clientY - bounds.top) * scaleY,
    };
  }

  function getROIHitMode(pointerX, pointerY) {
    const roi = computeROI();
    const nearLeft = Math.abs(pointerX - roi.x) <= ROI_HANDLE_HIT_PADDING_PX;
    const nearRight = Math.abs(pointerX - (roi.x + roi.width)) <= ROI_HANDLE_HIT_PADDING_PX;
    const nearTop = Math.abs(pointerY - roi.y) <= ROI_HANDLE_HIT_PADDING_PX;
    const nearBottom = Math.abs(pointerY - (roi.y + roi.height)) <= ROI_HANDLE_HIT_PADDING_PX;
    const insideX = pointerX >= roi.x && pointerX <= roi.x + roi.width;
    const insideY = pointerY >= roi.y && pointerY <= roi.y + roi.height;

    if (nearLeft && nearTop) return 'top-left';
    if (nearRight && nearTop) return 'top-right';
    if (nearLeft && nearBottom) return 'bottom-left';
    if (nearRight && nearBottom) return 'bottom-right';
    if (nearLeft && insideY) return 'left';
    if (nearRight && insideY) return 'right';
    if (nearTop && insideX) return 'top';
    if (nearBottom && insideX) return 'bottom';
    if (insideX && insideY) return 'move';

    return null;
  }

  function applyROIDrag(mode, deltaXPx, deltaYPx, startROI) {
    const width = Math.max(1, processingCanvas.width);
    const height = Math.max(1, processingCanvas.height);
    const deltaXPct = deltaXPx / width;
    const deltaYPct = deltaYPx / height;

    let nextLeftPct = startROI.leftPct;
    let nextTopPct = startROI.topPct;
    let nextRightPct = startROI.rightPct;
    let nextBottomPct = startROI.bottomPct;

    if (mode.includes('left')) nextLeftPct += deltaXPct;
    if (mode.includes('right')) nextRightPct += deltaXPct;
    if (mode.includes('top')) nextTopPct += deltaYPct;
    if (mode.includes('bottom')) nextBottomPct += deltaYPct;

    if (mode === 'move') {
      const roiWidthPct = startROI.rightPct - startROI.leftPct;
      const roiHeightPct = startROI.bottomPct - startROI.topPct;
      nextLeftPct = Math.max(0, Math.min(startROI.leftPct + deltaXPct, 1 - roiWidthPct));
      nextTopPct = Math.max(0, Math.min(startROI.topPct + deltaYPct, 1 - roiHeightPct));
      nextRightPct = nextLeftPct + roiWidthPct;
      nextBottomPct = nextTopPct + roiHeightPct;
    }

    clampROI(nextLeftPct, nextTopPct, nextRightPct, nextBottomPct);
  }

  function bindROIInteractionHandlers() {
    if (!processingCanvas) return;

    processingCanvas.addEventListener('pointerdown', (event) => {
      if (!currentStream) return;

      const pointer = getPointerPosition(event);
      const mode = getROIHitMode(pointer.x, pointer.y);
      if (!mode) return;

      roiPointerState = {
        pointerId: event.pointerId,
        mode,
        startX: pointer.x,
        startY: pointer.y,
        startROI: {
          leftPct: roiLeftPct,
          topPct: roiTopPct,
          rightPct: roiRightPct,
          bottomPct: roiBottomPct,
        },
      };

      processingCanvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    processingCanvas.addEventListener('pointermove', (event) => {
      const pointer = getPointerPosition(event);

      if (!roiPointerState || roiPointerState.pointerId !== event.pointerId) {
        const hoverMode = currentStream ? getROIHitMode(pointer.x, pointer.y) : null;
        processingCanvas.style.cursor = hoverMode === 'move'
          ? 'move'
          : hoverMode === 'left' || hoverMode === 'right'
            ? 'ew-resize'
            : hoverMode === 'top' || hoverMode === 'bottom'
              ? 'ns-resize'
              : hoverMode === 'top-left' || hoverMode === 'bottom-right'
                ? 'nwse-resize'
                : hoverMode === 'top-right' || hoverMode === 'bottom-left'
                  ? 'nesw-resize'
                  : 'default';
        return;
      }

      applyROIDrag(
        roiPointerState.mode,
        pointer.x - roiPointerState.startX,
        pointer.y - roiPointerState.startY,
        roiPointerState.startROI,
      );
      syncROIDisplay();
      event.preventDefault();
    });

    const endPointerInteraction = (event) => {
      if (!roiPointerState || roiPointerState.pointerId !== event.pointerId) return;

      if (processingCanvas.hasPointerCapture(event.pointerId)) {
        processingCanvas.releasePointerCapture(event.pointerId);
      }

      roiPointerState = null;
      processingCanvas.style.cursor = currentStream ? 'default' : 'default';
    };

    processingCanvas.addEventListener('pointerup', endPointerInteraction);
    processingCanvas.addEventListener('pointercancel', endPointerInteraction);
    processingCanvas.addEventListener('pointerleave', (event) => {
      if (!roiPointerState) {
        processingCanvas.style.cursor = 'default';
      } else if (roiPointerState.pointerId === event.pointerId) {
        endPointerInteraction(event);
      }
    });
  }

  // Convert the ROI from percentages into pixel coordinates.
  function computeROI() {
    const x = Math.floor(processingCanvas.width * roiLeftPct);
    const y = Math.floor(processingCanvas.height * roiTopPct);
    const w = Math.floor(processingCanvas.width * (roiRightPct - roiLeftPct));
    const h = Math.max(ROI_MIN_HEIGHT_PX, Math.floor(processingCanvas.height * (roiBottomPct - roiTopPct)));
    return { x, y, width: w, height: h };
  }

  // Draw a shaded overlay around the selected area.
  function drawOverlay() {
    const roi = computeROI();

    pctx.save();
    pctx.fillStyle = 'rgba(0,0,0,0.25)';
    pctx.beginPath();
    pctx.rect(0, 0, processingCanvas.width, processingCanvas.height);
    pctx.rect(roi.x, roi.y, roi.width, roi.height);
    pctx.fill('evenodd');
    pctx.restore();

    pctx.save();
    pctx.strokeStyle = '#ffcc00';
    pctx.lineWidth = 2;
    pctx.setLineDash([6, 4]);
    pctx.strokeRect(roi.x + 1, roi.y + 1, roi.width - 2, roi.height - 2);
    pctx.restore();

    pctx.save();
    pctx.fillStyle = '#ffcc00';
    const halfHandle = ROI_HANDLE_SIZE_PX / 2;
    const x0 = roi.x;
    const x1 = roi.x + roi.width;
    const y0 = roi.y;
    const y1 = roi.y + roi.height;
    pctx.fillRect(x0 - halfHandle, y0 - halfHandle, ROI_HANDLE_SIZE_PX, ROI_HANDLE_SIZE_PX);
    pctx.fillRect(x1 - halfHandle, y0 - halfHandle, ROI_HANDLE_SIZE_PX, ROI_HANDLE_SIZE_PX);
    pctx.fillRect(x0 - halfHandle, y1 - halfHandle, ROI_HANDLE_SIZE_PX, ROI_HANDLE_SIZE_PX);
    pctx.fillRect(x1 - halfHandle, y1 - halfHandle, ROI_HANDLE_SIZE_PX, ROI_HANDLE_SIZE_PX);
    pctx.restore();
  }

  // Keep the live preview and ROI overlay updating.
  function startOverlayLoop() {
    function loop() {
      if (!currentStream) {
        overlayAnimationId = null;
        return;
      }

      if (video.readyState < 2 || processingCanvas.width === 0 || processingCanvas.height === 0) {
        overlayAnimationId = requestAnimationFrame(loop);
        return;
      }

      pctx.drawImage(
        video,
        currentFrameRect.x,
        currentFrameRect.y,
        currentFrameRect.width,
        currentFrameRect.height,
        0,
        0,
        processingCanvas.width,
        processingCanvas.height,
      );
      drawOverlay();
      overlayAnimationId = requestAnimationFrame(loop);
    }

    if (overlayAnimationId == null) loop();
  }

  // Stop the live overlay loop.
  function stopOverlayLoop() {
    if (overlayAnimationId != null) {
      cancelAnimationFrame(overlayAnimationId);
      overlayAnimationId = null;
    }
  }

  // Show which camera side will be used next.
  function updateCameraToggleUI() {
    if (!cameraToggleButton) return;
    cameraToggleButton.textContent = preferredFacing === 'user' ? 'Front' : 'Back';
  }

  // Try the chosen camera first, then fall back to any camera.
  async function getPreferredCameraStream() {
    const facing = preferredFacing || 'user';

    const attempts = [
      // Fallback to any resolution
      { video: { facingMode: { exact: facing } }, audio: false },
      { video: { facingMode: { ideal: facing } }, audio: false },
      { video: true, audio: false },
    ];

    for (const constraints of attempts) {
      const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(() => null);
      if (stream) return stream;
    }

    throw new Error('Unable to acquire camera stream');
  }

  return {
    init,
    startCamera,
    stopCamera,
    getCurrentVideoTrackSettings,
    refreshPreviewLayout: syncPreviewFrameRect,
  };
}
