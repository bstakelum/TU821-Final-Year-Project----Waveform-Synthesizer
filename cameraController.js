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
  isCoarsePointer,
  roiElements,
  onCapture,
  onVideoSize,
}) {
  const ROI_MIN_GAP_RATIO = 0.01;
  const ROI_HANDLE_HIT_PADDING_CSS_PX = 18;
  const ROI_HANDLE_SIZE_CSS_PX = 14;
  const ROI_TOUCH_TARGET_PADDING_CSS_PX = 28;
  const ROI_MIN_HEIGHT_PX = 2;
  const ROI_MIN_WIDTH_PX = 2;

  const pctx = processingCanvas.getContext('2d');
  const captureCanvas = document.createElement('canvas');
  const cctx = captureCanvas.getContext('2d');

  let currentStream = null;
  let overlayAnimationId = null;
  let previewActive = true;
  let preferredFacing = 'environment'; // Start with the back camera if available.
  let roiControlsBound = false;
  let currentFrameRect = { x: 0, y: 0, width: 0, height: 0 };
  let roiTopPct = 0.0;
  let roiBottomPct = 1.0;
  let roiLeftPct = 0.0;
  let roiRightPct = 1.0;
  let roiPointerState = null;
  const roiTouchPoints = new Map();
  let roiTouchState = null;

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

      previewActive = true;
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
    previewActive = false;
    stopOverlayLoop();
    if (cameraControls) cameraControls.classList.add('hidden');
    if (startButton) startButton.textContent = 'Start Camera';
    pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
  }

  function setPreviewActive(isActive) {
    previewActive = !!isActive;

    if (!currentStream) {
      if (!previewActive) {
        stopOverlayLoop();
        pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
      }
      return;
    }

    if (previewActive) {
      syncPreviewFrameRect();
      startOverlayLoop();
      return;
    }

    stopOverlayLoop();
    pctx.clearRect(0, 0, processingCanvas.width, processingCanvas.height);
  }

  function isCameraRunning() {
    return !!currentStream;
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
  function syncROIDisplay() {}

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

    // Enforce aspect ratio: widthPct must equal heightPct so the ROI always
    // matches the output canvas shape. Boundary clamping above can produce
    // different values on each axis (e.g. both edges hit 1.0 but from different
    // offsets), so we re-enforce here after all other constraints are applied.
    // Take the smaller of the two axes and re-centre the larger one to fit.
    const arWidth = roiRightPct - roiLeftPct;
    const arHeight = roiBottomPct - roiTopPct;
    if (Math.abs(arWidth - arHeight) > 1e-9) {
      const targetSize = Math.min(arWidth, arHeight);
      if (arWidth > targetSize) {
        const cx = (roiLeftPct + roiRightPct) / 2;
        roiLeftPct = cx - targetSize / 2;
        roiRightPct = cx + targetSize / 2;
      } else {
        const cy = (roiTopPct + roiBottomPct) / 2;
        roiTopPct = cy - targetSize / 2;
        roiBottomPct = cy + targetSize / 2;
      }
    }
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

  function getOverlayMetrics() {
    const bounds = processingCanvas.getBoundingClientRect();
    const scaleX = bounds.width > 0 ? processingCanvas.width / bounds.width : 1;
    const scaleY = bounds.height > 0 ? processingCanvas.height / bounds.height : 1;
    const averageScale = (scaleX + scaleY) / 2;

    return {
      hitPaddingX: ROI_HANDLE_HIT_PADDING_CSS_PX * scaleX,
      hitPaddingY: ROI_HANDLE_HIT_PADDING_CSS_PX * scaleY,
      touchPaddingX: ROI_TOUCH_TARGET_PADDING_CSS_PX * scaleX,
      touchPaddingY: ROI_TOUCH_TARGET_PADDING_CSS_PX * scaleY,
      handleWidth: ROI_HANDLE_SIZE_CSS_PX * scaleX,
      handleHeight: ROI_HANDLE_SIZE_CSS_PX * scaleY,
      lineWidth: Math.max(2, Math.round(2 * averageScale)),
      dashLength: Math.max(4, Math.round(6 * averageScale)),
      dashGap: Math.max(3, Math.round(4 * averageScale)),
    };
  }

  function isTouchInteractionMode(event) {
    const coarsePointer = typeof isCoarsePointer === 'function'
      ? !!isCoarsePointer()
      : window.matchMedia('(pointer: coarse)').matches;

    if (!coarsePointer) return false;
    if (!event) return coarsePointer;
    return event.pointerType !== 'mouse';
  }

  function snapshotROI() {
    return {
      leftPct: roiLeftPct,
      topPct: roiTopPct,
      rightPct: roiRightPct,
      bottomPct: roiBottomPct,
    };
  }

  function getROIHitMode(pointerX, pointerY) {
    const roi = computeROI();
    const metrics = getOverlayMetrics();
    const nearLeft = Math.abs(pointerX - roi.x) <= metrics.hitPaddingX;
    const nearRight = Math.abs(pointerX - (roi.x + roi.width)) <= metrics.hitPaddingX;
    const nearTop = Math.abs(pointerY - roi.y) <= metrics.hitPaddingY;
    const nearBottom = Math.abs(pointerY - (roi.y + roi.height)) <= metrics.hitPaddingY;
    const insideX = pointerX >= roi.x && pointerX <= roi.x + roi.width;
    const insideY = pointerY >= roi.y && pointerY <= roi.y + roi.height;

    if (nearLeft && nearTop) return 'top-left';
    if (nearRight && nearTop) return 'top-right';
    if (nearLeft && nearBottom) return 'bottom-left';
    if (nearRight && nearBottom) return 'bottom-right';
    if (insideX && insideY) return 'move';

    return null;
  }

  function isPointerNearROI(pointerX, pointerY) {
    const roi = computeROI();
    const metrics = getOverlayMetrics();
    return pointerX >= roi.x - metrics.touchPaddingX
      && pointerX <= roi.x + roi.width + metrics.touchPaddingX
      && pointerY >= roi.y - metrics.touchPaddingY
      && pointerY <= roi.y + roi.height + metrics.touchPaddingY;
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

    if (mode === 'top-left' || mode === 'top-right' || mode === 'bottom-left' || mode === 'bottom-right') {
      // Apply each axis independently to find candidate sizes.
      if (mode.includes('left')) nextLeftPct += deltaXPct;
      if (mode.includes('right')) nextRightPct += deltaXPct;
      if (mode.includes('top')) nextTopPct += deltaYPct;
      if (mode.includes('bottom')) nextBottomPct += deltaYPct;

      // Enforce aspect ratio: widthPct must equal heightPct so the ROI always
      // matches the output canvas shape, eliminating letterbox bars on capture.
      // The dominant axis (larger absolute pixel delta) drives the target size.
      const candidateWidthPct = Math.max(0, nextRightPct - nextLeftPct);
      const candidateHeightPct = Math.max(0, nextBottomPct - nextTopPct);
      const targetSizePct = Math.abs(deltaXPx) >= Math.abs(deltaYPx)
        ? candidateWidthPct : candidateHeightPct;

      if (mode === 'top-left') {
        nextLeftPct = nextRightPct - targetSizePct;
        nextTopPct = nextBottomPct - targetSizePct;
      } else if (mode === 'top-right') {
        nextRightPct = nextLeftPct + targetSizePct;
        nextTopPct = nextBottomPct - targetSizePct;
      } else if (mode === 'bottom-left') {
        nextLeftPct = nextRightPct - targetSizePct;
        nextBottomPct = nextTopPct + targetSizePct;
      } else {
        nextRightPct = nextLeftPct + targetSizePct;
        nextBottomPct = nextTopPct + targetSizePct;
      }
    } else if (mode === 'move') {
      const roiWidthPct = startROI.rightPct - startROI.leftPct;
      const roiHeightPct = startROI.bottomPct - startROI.topPct;
      nextLeftPct = Math.max(0, Math.min(startROI.leftPct + deltaXPct, 1 - roiWidthPct));
      nextTopPct = Math.max(0, Math.min(startROI.topPct + deltaYPct, 1 - roiHeightPct));
      nextRightPct = nextLeftPct + roiWidthPct;
      nextBottomPct = nextTopPct + roiHeightPct;
    }

    clampROI(nextLeftPct, nextTopPct, nextRightPct, nextBottomPct);
  }

  function beginTouchMoveGesture(pointerId, pointer) {
    roiTouchState = {
      type: 'move',
      pointerIds: [pointerId],
      startCenterX: pointer.x,
      startCenterY: pointer.y,
      startROI: snapshotROI(),
    };
  }

  function beginTouchPinchGesture() {
    const points = Array.from(roiTouchPoints.entries()).slice(0, 2);
    if (points.length < 2) return;

    const [[firstId, firstPoint], [secondId, secondPoint]] = points;
    const centerX = (firstPoint.x + secondPoint.x) / 2;
    const centerY = (firstPoint.y + secondPoint.y) / 2;

    roiTouchState = {
      type: 'pinch',
      pointerIds: [firstId, secondId],
      startCenterX: centerX,
      startCenterY: centerY,
      startDX: secondPoint.x - firstPoint.x,
      startDY: secondPoint.y - firstPoint.y,
      startROI: snapshotROI(),
    };
  }

  function applyROIPinch(currentPoints, touchState) {
    if (!touchState || currentPoints.length < 2) return;

    const [firstPoint, secondPoint] = currentPoints;
    const centerX = (firstPoint.x + secondPoint.x) / 2;
    const centerY = (firstPoint.y + secondPoint.y) / 2;
    const canvasWidth = Math.max(1, processingCanvas.width);
    const canvasHeight = Math.max(1, processingCanvas.height);
    const deltaCenterXPct = (centerX - touchState.startCenterX) / canvasWidth;
    const deltaCenterYPct = (centerY - touchState.startCenterY) / canvasHeight;
    const startWidthPct = touchState.startROI.rightPct - touchState.startROI.leftPct;
    const startHeightPct = touchState.startROI.bottomPct - touchState.startROI.topPct;

    // Use the Euclidean distance between fingers as a uniform scale factor so
    // the ROI aspect ratio is preserved during pinch gestures.
    const MIN_AXIS_SPREAD_PX = 10;
    const currentDX = secondPoint.x - firstPoint.x;
    const currentDY = secondPoint.y - firstPoint.y;
    const startDist = Math.sqrt(touchState.startDX * touchState.startDX + touchState.startDY * touchState.startDY);
    const currentDist = Math.sqrt(currentDX * currentDX + currentDY * currentDY);
    const scale = startDist >= MIN_AXIS_SPREAD_PX ? currentDist / startDist : 1;
    const scaleX = scale;
    const scaleY = scale;

    const centerXPct = (touchState.startROI.leftPct + touchState.startROI.rightPct) / 2 + deltaCenterXPct;
    const centerYPct = (touchState.startROI.topPct + touchState.startROI.bottomPct) / 2 + deltaCenterYPct;

    clampROI(
      centerXPct - (startWidthPct * scaleX) / 2,
      centerYPct - (startHeightPct * scaleY) / 2,
      centerXPct + (startWidthPct * scaleX) / 2,
      centerYPct + (startHeightPct * scaleY) / 2,
    );
  }

  function handleTouchPointerDown(event, pointer) {
    if (!isPointerNearROI(pointer.x, pointer.y) && roiTouchPoints.size === 0) {
      return;
    }

    roiTouchPoints.set(event.pointerId, pointer);
    processingCanvas.setPointerCapture(event.pointerId);

    if (roiTouchPoints.size >= 2) {
      beginTouchPinchGesture();
    } else {
      beginTouchMoveGesture(event.pointerId, pointer);
    }

    event.preventDefault();
  }

  function handleTouchPointerMove(event, pointer) {
    if (!roiTouchPoints.has(event.pointerId)) return;

    roiTouchPoints.set(event.pointerId, pointer);

    if (roiTouchPoints.size >= 2) {
      if (roiTouchState?.type !== 'pinch') {
        beginTouchPinchGesture();
      }

      const pinchPoints = roiTouchState.pointerIds
        .map((pointerId) => roiTouchPoints.get(pointerId))
        .filter(Boolean);
      applyROIPinch(pinchPoints, roiTouchState);
    } else if (roiTouchState?.type === 'move' && roiTouchState.pointerIds[0] === event.pointerId) {
      applyROIDrag(
        'move',
        pointer.x - roiTouchState.startCenterX,
        pointer.y - roiTouchState.startCenterY,
        roiTouchState.startROI,
      );
    }

    syncROIDisplay();
    event.preventDefault();
  }

  function endTouchPointerInteraction(event) {
    if (processingCanvas.hasPointerCapture(event.pointerId)) {
      processingCanvas.releasePointerCapture(event.pointerId);
    }

    roiTouchPoints.delete(event.pointerId);

    if (roiTouchPoints.size >= 2) {
      beginTouchPinchGesture();
      return;
    }

    if (roiTouchPoints.size === 1) {
      const [[pointerId, pointer]] = Array.from(roiTouchPoints.entries());
      beginTouchMoveGesture(pointerId, pointer);
      return;
    }

    roiTouchState = null;
  }

  function bindROIInteractionHandlers() {
    if (!processingCanvas) return;

    processingCanvas.addEventListener('pointerdown', (event) => {
      if (!currentStream) return;

      const pointer = getPointerPosition(event);
      if (isTouchInteractionMode(event)) {
        handleTouchPointerDown(event, pointer);
        return;
      }

      const mode = getROIHitMode(pointer.x, pointer.y);
      if (!mode) return;

      roiPointerState = {
        pointerId: event.pointerId,
        mode,
        startX: pointer.x,
        startY: pointer.y,
        startROI: snapshotROI(),
      };

      processingCanvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    processingCanvas.addEventListener('pointermove', (event) => {
      const pointer = getPointerPosition(event);

      if (isTouchInteractionMode(event)) {
        handleTouchPointerMove(event, pointer);
        return;
      }

      if (!roiPointerState || roiPointerState.pointerId !== event.pointerId) {
        const hoverMode = currentStream ? getROIHitMode(pointer.x, pointer.y) : null;
        processingCanvas.style.cursor = hoverMode === 'move'
          ? 'move'
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
      if (isTouchInteractionMode(event)) {
        endTouchPointerInteraction(event);
        processingCanvas.style.cursor = 'default';
        return;
      }

      if (!roiPointerState || roiPointerState.pointerId !== event.pointerId) return;

      if (processingCanvas.hasPointerCapture(event.pointerId)) {
        processingCanvas.releasePointerCapture(event.pointerId);
      }

      roiPointerState = null;
      processingCanvas.style.cursor = 'default';
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
    const metrics = getOverlayMetrics();

    pctx.save();
    pctx.fillStyle = 'rgba(0,0,0,0.25)';
    pctx.beginPath();
    pctx.rect(0, 0, processingCanvas.width, processingCanvas.height);
    pctx.rect(roi.x, roi.y, roi.width, roi.height);
    pctx.fill('evenodd');
    pctx.restore();

    pctx.save();
    pctx.strokeStyle = '#ffcc00';
    pctx.lineWidth = metrics.lineWidth;
    pctx.setLineDash([metrics.dashLength, metrics.dashGap]);
    pctx.strokeRect(
      roi.x + Math.round(metrics.lineWidth / 2),
      roi.y + Math.round(metrics.lineWidth / 2),
      Math.max(1, roi.width - metrics.lineWidth),
      Math.max(1, roi.height - metrics.lineWidth),
    );
    pctx.restore();

    pctx.save();
    pctx.fillStyle = '#ffcc00';
    const halfHandleWidth = metrics.handleWidth / 2;
    const halfHandleHeight = metrics.handleHeight / 2;
    const x0 = roi.x;
    const x1 = roi.x + roi.width;
    const y0 = roi.y;
    const y1 = roi.y + roi.height;
    pctx.fillRect(x0 - halfHandleWidth, y0 - halfHandleHeight, metrics.handleWidth, metrics.handleHeight);
    pctx.fillRect(x1 - halfHandleWidth, y0 - halfHandleHeight, metrics.handleWidth, metrics.handleHeight);
    pctx.fillRect(x0 - halfHandleWidth, y1 - halfHandleHeight, metrics.handleWidth, metrics.handleHeight);
    pctx.fillRect(x1 - halfHandleWidth, y1 - halfHandleHeight, metrics.handleWidth, metrics.handleHeight);
    pctx.restore();
  }

  // Keep the live preview and ROI overlay updating.
  function startOverlayLoop() {
    function loop() {
      if (!currentStream || !previewActive) {
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
    cameraToggleButton.textContent = preferredFacing === 'user' ? 'Back Camera' : 'Front Camera';
  }

  // Try the chosen camera first, then fall back to any camera.
  async function getPreferredCameraStream() {
    const facing = preferredFacing || 'user';

    const attempts = [
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
    setPreviewActive,
    isCameraRunning,
    getCurrentVideoTrackSettings,
    refreshPreviewLayout: syncPreviewFrameRect,
  };
}
