// Image processing:
// - cleans the captured frame so the waveform line is easier to pick out
// - keeps the image the same size for the next step
export function createImageProcessor({
} = {}) {

  const defaultConfig = {
    // Illumination flattening
    flattenKernelRadius: 9, // Minimum width of the local background estimate.
    flattenKernelRadiusRatio: 0.03, // Scales the background estimate to larger mobile captures.
    flattenBias: 118, // Brightness added back after flattening so the line stays visible.
    flattenGain: 1.5, // Extra emphasis for dark line contrast after lighting removal.

    // Contrast stretching
    contrastLowPercentile: 2, // Dark end used when stretching contrast.
    contrastHighPercentile: 98, // Bright end used when stretching contrast.

    // Component scoring
    minComponentSizePixels: 50, // Small blobs below this size are discarded.
    componentEdgeMarginPx: 4, // Edge band used to penalize border-hugging components.
    componentExcursionWidthRatio: 0.2, // Expected vertical movement relative to width for a waveform-like path.
    componentExcursionGamma: 1.6, // Makes low-excursion regions earn less reward until their bend is clearer.
    componentWidthScoreExponent: 0.72, // Compresses width advantage so long horizontal clutter does not dominate as easily.
    componentBorderPenaltyWeight: 1.5, // Amplifies the penalty for components that lean on the image border.
  };

  // Reuse working buffers so each frame does not keep allocating new arrays.
  let bufferA = null, bufferB = null, bufferC = null, lastWidth = 0, lastHeight = 0;

  // Create buffers when the image size changes.
  function initBuffers(width, height, byteCount) {
    if (!bufferA || lastWidth !== width || lastHeight !== height) {
      bufferA = new Uint8ClampedArray(byteCount);
      bufferB = new Uint8ClampedArray(byteCount);
      bufferC = new Uint8ClampedArray(byteCount);
      lastWidth = width;
      lastHeight = height;
    }
  }

  // Run the full cleanup pipeline.
  function preprocessImage(imageData, roi) {
    if (!imageData) return null;

    const originalWidth = imageData.width;
    const originalHeight = imageData.height;
    imageData = cropImageDataToROI(imageData, roi);

    const { data, width, height } = imageData;
    const byteCount = data.length;
    initBuffers(width, height, byteCount);

    // Move through the cleanup steps using the same two buffers.
    rgbaToGrayscale(data, bufferB);
    denoiseImage(width, height, bufferB, bufferA);
    flattenIllumination(width, height, bufferA, bufferB);
    enhanceContrast(bufferB, bufferA);

    // Join short horizontal breaks in the line.
    horizontalClose(width, height, bufferA, bufferB, 2);

    // Filter components of image to prefer waveform like shapes.
    filterByConnectedComponents(width, height, bufferB, defaultConfig.minComponentSizePixels);

    // Build the processed image output — upscale the grayscale buffer first.
    const result = restoreImageDataToFullSize(bufferB, originalWidth, originalHeight, roi);

    // Binarize image
    applyBinaryMask(result.data);

    return result;
  }

  // Crop the input ImageData to the given ROI, returning a new ImageData object with the cropped content.
  function cropImageDataToROI(imageData, roi) {
    const { x, y, width, height } = roi;
    const src = imageData.data;
    const cropped = new Uint8ClampedArray(width * height * 4);

    for (let row = 0; row < height; row++) {
      const srcStart = ((row + y) * imageData.width + x) * 4;
      const destStart = row * width * 4;
      cropped.set(src.subarray(srcStart, srcStart + width * 4), destStart);
    }

    return new ImageData(cropped, width, height);
  }

  // Scale the processed ROI content into the original frame dimensions using
  // bilinear interpolation. The ROI always shares the output frame's aspect
  // ratio (enforced by cameraController), so content fills the frame exactly
  // with no bars — the ROI acts as a zoom without distorting the waveform shape.
  function restoreImageDataToFullSize(data, originalImageWidth, originalImageHeight, roi) {
    const { width: roiWidth, height: roiHeight } = roi;
    const result = new ImageData(originalImageWidth, originalImageHeight);

    for (let dstY = 0; dstY < originalImageHeight; dstY++) {
      const srcYf = (dstY / (originalImageHeight - 1)) * (roiHeight - 1);
      const srcY0 = Math.floor(srcYf);
      const srcY1 = Math.min(srcY0 + 1, roiHeight - 1);
      const ty    = srcYf - srcY0;

      for (let dstX = 0; dstX < originalImageWidth; dstX++) {
        const srcXf = (dstX / (originalImageWidth - 1)) * (roiWidth - 1);
        const srcX0 = Math.floor(srcXf);
        const srcX1 = Math.min(srcX0 + 1, roiWidth - 1);
        const tx    = srcXf - srcX0;

        const i00 = (srcY0 * roiWidth + srcX0) * 4;
        const i10 = (srcY0 * roiWidth + srcX1) * 4;
        const i01 = (srcY1 * roiWidth + srcX0) * 4;
        const i11 = (srcY1 * roiWidth + srcX1) * 4;

        const val = Math.round(
          (data[i00] * (1 - tx) * (1 - ty))
        + (data[i10] * tx       * (1 - ty))
        + (data[i01] * (1 - tx) * ty)
        + (data[i11] * tx       * ty)
        );
        const dstIdx = (dstY * originalImageWidth + dstX) * 4;
        result.data[dstIdx]     = val;
        result.data[dstIdx + 1] = val;
        result.data[dstIdx + 2] = val;
        result.data[dstIdx + 3] = 255;
      }
    }

    return result;
  }

    // Count how often each gray value appears.
  function buildHistogram(data) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      hist[data[i]]++;
    }
    return hist;
  }

  // Read a percentile value from the histogram.
  function getPercentileFromHistogram(histogram, percentile, pixelCount) {
    const p = Math.max(0, Math.min(100, percentile));
    const totalPixels = pixelCount ?? histogram.reduce((a, b) => a + b, 0);
    const targetCount = Math.floor((p / 100) * totalPixels);
    let count = 0;
    for (let i = 0; i < 256; i++) {
      count += histogram[i];
      if (count >= targetCount) return i;
    }
    return 255;
  }

  // Check if a pixel in the mask is considered foreground (part of the line).
  function applyBinaryMask(data) {
    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] === 255 ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  // Convert the image to grayscale.
  function rgbaToGrayscale(srcData, dstData) {
    for (let i = 0; i < srcData.length; i += 4) {
      const gray = Math.round(0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2]);
      dstData[i] = gray;
      dstData[i + 1] = gray;
      dstData[i + 2] = gray;
      dstData[i + 3] = 255;
    }
  }

  // Blur away very small speckles.
  function denoiseImage(width, height, srcData, dstData) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
        const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);

        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            sum += srcData[(yy * width + xx) * 4];
            count++;
          }
        }

        const idx = (y * width + x) * 4;
        const blurred = Math.round(sum / count);
        dstData[idx] = blurred;
        dstData[idx + 1] = blurred;
        dstData[idx + 2] = blurred;
        dstData[idx + 3] = 255;
      }
    }
  }

  // Helper used by the lighting-flattening step.
  function horizontalBlur(width, height, src, dst, radius) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
        let sum = 0, count = 0;
        for (let xx = x0; xx <= x1; xx++) {
          sum += src[(y * width + xx) * 4];
          count++;
        }
        dst[(y * width + x) * 4] = Math.round(sum / count);
      }
    }
  }

  // Choose a kernel radius for the lighting flattening step based on the image size, with some minimum and scaling.
  function getEffectiveFlattenRadius(width, height) {
    const minDimension = Math.max(1, Math.min(width, height));
    const ratioRadius = Math.round(minDimension * defaultConfig.flattenKernelRadiusRatio);
    return Math.max(1, Math.max(Math.floor(defaultConfig.flattenKernelRadius), ratioRadius));
  }

  // Reduce uneven lighting across the image.
  function flattenIllumination(width, height, srcData, dstData) {
    const radius = getEffectiveFlattenRadius(width, height);
    const bias = Number.isFinite(defaultConfig.flattenBias) ? defaultConfig.flattenBias : 128;
    const gain = Number.isFinite(defaultConfig.flattenGain) ? defaultConfig.flattenGain : 1;

    // Horizontal pass (use pooled bufferC as intermediate)
    horizontalBlur(width, height, srcData, bufferC, radius);

    // Vertical pass + flatten illumination
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
        let sum = 0, count = 0;
        for (let yy = y0; yy <= y1; yy++) {
          sum += bufferC[(yy * width + x) * 4];
          count++;
        }
        const idx = (y * width + x) * 4;
        const sourceValue = srcData[idx];
        const backgroundValue = Math.round(sum / count);
        const darkResponse = Math.max(0, backgroundValue - sourceValue);
        const flattened = Math.max(0, Math.min(255, Math.round((darkResponse * gain) + bias)));
        dstData[idx] = flattened;
        dstData[idx + 1] = flattened;
        dstData[idx + 2] = flattened;
        dstData[idx + 3] = 255;
      }
    }
  }

  // Spread out the brightness range so the line stands out more.
  function enhanceContrast(srcData, dstData) {
    const histogram = buildHistogram(srcData);
    const pixelCount = srcData.length / 4;
    const minValue = getPercentileFromHistogram(histogram, defaultConfig.contrastLowPercentile, pixelCount);
    const maxValue = getPercentileFromHistogram(histogram, defaultConfig.contrastHighPercentile, pixelCount);
    const range = maxValue - minValue;

    if (range < 1) {
      dstData.set(srcData);
      return;
    }

    for (let i = 0; i < srcData.length; i += 4) {
      const normalized = Math.round(((srcData[i] - minValue) / range) * 255);
      dstData[i] = normalized;
      dstData[i + 1] = normalized;
      dstData[i + 2] = normalized;
      dstData[i + 3] = 255;
    }
  }

  // Fill short horizontal gaps in the line.
  function horizontalClose(width, height, srcData, dstData, radius) {
    // Spread bright pixels left and right (use pooled bufferC as intermediate).
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let fg = false;
        const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
        for (let xx = x0; xx <= x1; xx++) {
          if (srcData[(y * width + xx) * 4] === 255) { fg = true; break; }
        }
        const idx = (y * width + x) * 4;
        bufferC[idx] = bufferC[idx + 1] = bufferC[idx + 2] = fg ? 255 : 0;
        bufferC[idx + 3] = 255;
      }
    }

    // Shrink the result back down.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let allWhite = true;
        const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
        for (let xx = x0; xx <= x1; xx++) {
          if (bufferC[(y * width + xx) * 4] !== 255) { allWhite = false; break; }
        }
        const idx = (y * width + x) * 4;
        const val = allWhite ? 255 : 0;
        dstData[idx] = val;
        dstData[idx + 1] = val;
        dstData[idx + 2] = val;
        dstData[idx + 3] = 255;
      }
    }
  }

  // Score connected components and damp weaker ones instead of deleting them outright.
  function filterByConnectedComponents(width, height, data, minSizePixels) {
    const n = (data.length / 4);
    const label = new Int32Array(n);
    let nextLabel = 1;

    // Label one connected bright region at a time.
    const floodFill = (startIdx) => {
      const stack = [startIdx];
      const component = [];
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;

      while (stack.length > 0) {
        const idx = stack.pop();
        if (label[idx]) continue;
        label[idx] = nextLabel;
        component.push(idx);

        const x = idx % width, y = Math.floor(idx / width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
        const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);

        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const nIdx = yy * width + xx;
            if (!label[nIdx] && data[(nIdx) * 4] === 255) {
              stack.push(nIdx);
            }
          }
        }
      }
      return {
        label: nextLabel,
        size: component.length,
        pixels: component,
        minX,
        maxX,
        minY,
        maxY,
      };
    };

    // Find all connected bright regions.
    const components = [];
    for (let i = 0; i < n; i++) {
      if (!label[i] && data[(i) * 4] === 255) {
        const component = floodFill(i);
        if (component.size >= minSizePixels) {
          const widthSpan = component.maxX - component.minX + 1;
          const columnsWithPixels = new Uint16Array(widthSpan);
          const columnMinY = new Int16Array(widthSpan);
          const columnMaxY = new Int16Array(widthSpan);
          columnMinY.fill(-1);
          columnMaxY.fill(-1);

          for (let pixelIndex = 0; pixelIndex < component.pixels.length; pixelIndex++) {
            const idx = component.pixels[pixelIndex];
            const x = idx % width;
            const y = Math.floor(idx / width);
            const localX = x - component.minX;
            columnsWithPixels[localX]++;
            if (columnMinY[localX] === -1 || y < columnMinY[localX]) {
              columnMinY[localX] = y;
            }
            if (columnMaxY[localX] === -1 || y > columnMaxY[localX]) {
              columnMaxY[localX] = y;
            }
          }

          let occupiedColumns = 0;
          let topTouchColumns = 0;
          let bottomTouchColumns = 0;
          let minCenterY = height;
          let maxCenterY = 0;
          const edgeMargin = Math.max(0, defaultConfig.componentEdgeMarginPx);

          for (let localX = 0; localX < widthSpan; localX++) {
            if (columnsWithPixels[localX] <= 0) continue;
            occupiedColumns++;

            if (columnMinY[localX] <= edgeMargin) topTouchColumns++;
            if (columnMaxY[localX] >= height - 1 - edgeMargin) bottomTouchColumns++;

            const centerY = (columnMinY[localX] + columnMaxY[localX]) / 2;
            if (centerY < minCenterY) minCenterY = centerY;
            if (centerY > maxCenterY) maxCenterY = centerY;
          }

          // Remove widthCoverageRatio, thinnessPreference, and continuityPreference from scoring
          const centerlineExcursion = Math.max(0, maxCenterY - minCenterY);
          const excursionReference = Math.max(6, widthSpan * defaultConfig.componentExcursionWidthRatio);
          const normalizedExcursion = Math.max(0, Math.min(1, centerlineExcursion / excursionReference));
          const excursionPreference = 0.2 + (0.8 * Math.pow(normalizedExcursion, defaultConfig.componentExcursionGamma));
          const borderTouchRatio = (topTouchColumns + bottomTouchColumns) / Math.max(1, occupiedColumns * 2);
          const borderAvoidancePreference = 1 / (1 + (defaultConfig.componentBorderPenaltyWeight * borderTouchRatio * borderTouchRatio * 6));
          const baseWidthScore = Math.pow(Math.max(1, widthSpan), defaultConfig.componentWidthScoreExponent);
          const waveformScore = baseWidthScore
            * excursionPreference
            * borderAvoidancePreference;

          components.push({
            label: component.label,
            waveformScore,
          });
        }
        nextLabel++;
      }
    }

    // Keep only the single best-scoring component; zero out everything else.
    if (components.length > 0) {
      const bestLabel = components.reduce((best, c) => c.waveformScore > best.waveformScore ? c : best).label;

      for (let i = 0; i < n; i++) {
        const value = label[i] === bestLabel ? 255 : 0;
        data[(i) * 4] = value;
        data[(i) * 4 + 1] = value;
        data[(i) * 4 + 2] = value;
        data[(i) * 4 + 3] = 255;
      }
    }
  }

  return {
    preprocessImage,
  };
}
