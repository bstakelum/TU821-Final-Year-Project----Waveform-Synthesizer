// Image processing:
// - cleans up the captured frame so the waveform line stands out more clearly
// - keeps the same input/output shape for the rest of the app
// - can show a preview of the processed image for debugging

// Build and return the image processing helper used by the app.
export function createImageProcessor({
  statusEl,
  previewCanvas,
} = {}) {
  const previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;

  const defaultConfig = {
    flattenKernelRadius: 5,
    flattenBias: 118,
    contrastLowPercentile: 2,
    contrastHighPercentile: 98,
    minIsolatedNeighborCount: 8,
    erodeMinForegroundCount: 6,
  };

  const ADAPTIVE_THRESHOLD_PERCENTILE = 96;

  // Show preprocessing status text in the UI when a status element is provided.
  function setProcessingStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // Startup hook for the app.
  async function initProcessor() {
    setProcessingStatus('Preprocessing: custom pipeline ready');
  }

  // Draw the processed image in the preview panel.
  function renderProcessedPreview(imageData) {
    if (!previewCanvas || !previewCtx || !imageData) return;

    if (previewCanvas.width !== imageData.width || previewCanvas.height !== imageData.height) {
      previewCanvas.width = imageData.width;
      previewCanvas.height = imageData.height;
    }

    previewCtx.putImageData(imageData, 0, 0);
  }

  // Make a full copy of image data so edits do not touch the original.
  function cloneImageData(imageData) {
    return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  }

  // Find a brightness value at a given percentile (for auto-thresholding).
  function getGrayPercentile(imageData, percentile) {
    const p = Math.max(0, Math.min(100, percentile));
    const { data } = imageData;
    const values = new Uint8Array(data.length / 4);

    let j = 0;
    for (let i = 0; i < data.length; i += 4) {
      values[j++] = data[i];
    }

    values.sort();
    const index = Math.floor((p / 100) * (values.length - 1));
    return values[index];
  }

  // Convert color image data to grayscale.
  function rgbaToGrayscale(imageData) {
    const output = cloneImageData(imageData);
    const { data } = output;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

      data[i] = gray;
      data[i + 1] = gray;
      data[i + 2] = gray;
      data[i + 3] = 255;
    }

    return output;
  }

  // Smooth small speckles with a simple local blur.
  function denoiseImage(imageData) {
    const { width, height, data } = imageData;
    const output = cloneImageData(imageData);
    const out = output.data;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;

        for (let ky = -1; ky <= 1; ky++) {
          const yy = clamp(y + ky, 0, height - 1);
          for (let kx = -1; kx <= 1; kx++) {
            const xx = clamp(x + kx, 0, width - 1);
            const srcIdx = (yy * width + xx) * 4;
            sum += data[srcIdx];
            count++;
          }
        }

        const dstIdx = (y * width + x) * 4;
        const blurred = Math.round(sum / count);
        out[dstIdx] = blurred;
        out[dstIdx + 1] = blurred;
        out[dstIdx + 2] = blurred;
        out[dstIdx + 3] = 255;
      }
    }

    return output;
  }

  // Reduce uneven lighting so the waveform stands out more evenly.
  function flattenIllumination(imageData) {
    const { width, height, data } = imageData;
    const output = cloneImageData(imageData);
    const out = output.data;

    const radius = Math.max(1, Math.floor(defaultConfig.flattenKernelRadius));
    const bias = Number.isFinite(defaultConfig.flattenBias) ? defaultConfig.flattenBias : 128;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let backgroundSum = 0;
        let backgroundCount = 0;

        for (let ky = -radius; ky <= radius; ky++) {
          const yy = clamp(y + ky, 0, height - 1);
          for (let kx = -radius; kx <= radius; kx++) {
            const xx = clamp(x + kx, 0, width - 1);
            const backgroundIndex = (yy * width + xx) * 4;
            backgroundSum += data[backgroundIndex];
            backgroundCount++;
          }
        }

        const index = (y * width + x) * 4;
        const sourceValue = data[index];
        const backgroundValue = Math.round(backgroundSum / backgroundCount);
        const darkResponse = Math.max(0, backgroundValue - sourceValue);
        const flattened = clamp(Math.round(darkResponse + bias), 0, 255);

        out[index] = flattened;
        out[index + 1] = flattened;
        out[index + 2] = flattened;
        out[index + 3] = 255;
      }
    }

    return output;
  }

  // Stretch contrast so dark and bright areas separate more clearly.
  function enhanceContrast(imageData) {
    const output = cloneImageData(imageData);
    const { data } = output;

    const minValue = getGrayPercentile(output, defaultConfig.contrastLowPercentile);
    const maxValue = getGrayPercentile(output, defaultConfig.contrastHighPercentile);

    const range = maxValue - minValue;
    if (range < 1) return output;

    for (let i = 0; i < data.length; i += 4) {
      const normalized = Math.round(((data[i] - minValue) / range) * 255);
      data[i] = normalized;
      data[i + 1] = normalized;
      data[i + 2] = normalized;
      data[i + 3] = 255;
    }

    return output;
  }

  // Turn grayscale into a black/white mask.
  function applyThreshold(imageData) {
    const output = cloneImageData(imageData);

    const { data } = output;
    const threshold = getGrayPercentile(output, ADAPTIVE_THRESHOLD_PERCENTILE);

    for (let i = 0; i < data.length; i += 4) {
      const value = data[i];
      const binary = value >= threshold ? 255 : 0;
      data[i] = binary;
      data[i + 1] = binary;
      data[i + 2] = binary;
      data[i + 3] = 255;
    }

    return output;
  }

  // Remove tiny artifacts and connect broken trace pieces in the mask.
  function cleanupMask(imageData) {
    const { width, height, data } = imageData;
    const output = cloneImageData(imageData);
    const out = output.data;

    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    // Shrink white regions slightly to remove thin noise.
    function erode3x3(source, target) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let foregroundCount = 0;

          for (let ky = -1; ky <= 1; ky++) {
            const yy = clamp(y + ky, 0, height - 1);
            for (let kx = -1; kx <= 1; kx++) {
              const xx = clamp(x + kx, 0, width - 1);
              const idx = (yy * width + xx) * 4;
              if (source[idx] === 255) foregroundCount++;
            }
          }

          const dstIdx = (y * width + x) * 4;
          const value = foregroundCount >= defaultConfig.erodeMinForegroundCount ? 255 : 0;
          target[dstIdx] = value;
          target[dstIdx + 1] = value;
          target[dstIdx + 2] = value;
          target[dstIdx + 3] = 255;
        }
      }
    }

    // Grow white regions to reconnect small breaks.
    function dilate3x3(source, target) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let anyForeground = false;

          for (let ky = -1; ky <= 1 && !anyForeground; ky++) {
            const yy = clamp(y + ky, 0, height - 1);
            for (let kx = -1; kx <= 1; kx++) {
              const xx = clamp(x + kx, 0, width - 1);
              const idx = (yy * width + xx) * 4;
              if (source[idx] === 255) {
                anyForeground = true;
                break;
              }
            }
          }

          const dstIdx = (y * width + x) * 4;
          const value = anyForeground ? 255 : 0;
          target[dstIdx] = value;
          target[dstIdx + 1] = value;
          target[dstIdx + 2] = value;
          target[dstIdx + 3] = 255;
        }
      }
    }

    // Remove isolated white dots that likely come from noise.
    function suppressIsolatedPixels(source, target, minNeighborCount) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const centerIdx = (y * width + x) * 4;
          if (source[centerIdx] !== 255) {
            target[centerIdx] = 0;
            target[centerIdx + 1] = 0;
            target[centerIdx + 2] = 0;
            target[centerIdx + 3] = 255;
            continue;
          }

          let neighborCount = 0;
          for (let ky = -1; ky <= 1; ky++) {
            const yy = clamp(y + ky, 0, height - 1);
            for (let kx = -1; kx <= 1; kx++) {
              if (kx === 0 && ky === 0) continue;
              const xx = clamp(x + kx, 0, width - 1);
              const idx = (yy * width + xx) * 4;
              if (source[idx] === 255) neighborCount++;
            }
          }

          const value = neighborCount >= minNeighborCount ? 255 : 0;
          target[centerIdx] = value;
          target[centerIdx + 1] = value;
          target[centerIdx + 2] = value;
          target[centerIdx + 3] = 255;
        }
      }
    }

    const stageA = new Uint8ClampedArray(data);
    const stageB = new Uint8ClampedArray(data.length);
    const stageC = new Uint8ClampedArray(data.length);

    suppressIsolatedPixels(stageA, stageB, defaultConfig.minIsolatedNeighborCount);
    dilate3x3(stageB, stageC);
    erode3x3(stageC, stageA);

    out.set(stageA);
    return output;
  }

  // Run the full preprocessing pipeline in order.
  function preprocessImage(imageData) {
    if (!imageData) return null;

    const grayscale = rgbaToGrayscale(imageData);
    const denoised = denoiseImage(grayscale);
    const flattened = flattenIllumination(denoised);
    const contrastEnhanced = enhanceContrast(flattened);
    const thresholded = applyThreshold(contrastEnhanced);
    const cleaned = cleanupMask(thresholded);

    return cleaned;
  }

  return {
    initProcessor,
    preprocessImage,
    renderProcessedPreview,
    setProcessingStatus,
  };
}
