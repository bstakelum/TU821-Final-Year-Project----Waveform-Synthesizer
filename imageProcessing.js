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
    componentScoreGamma: 1.35, // Pushes weaker components down faster while leaving the best one untouched.
    componentEdgeMarginPx: 4, // Edge band used to penalize border-hugging components.
    componentExcursionWidthRatio: 0.2, // Expected vertical movement relative to width for a waveform-like path.
    componentExcursionGamma: 1.6, // Makes low-excursion regions earn less reward until their bend is clearer.
    componentWidthScoreExponent: 0.72, // Compresses width advantage so long horizontal clutter does not dominate as easily.
    componentBorderPenaltyWeight: 1.5, // Amplifies the penalty for components that lean on the image border.
  };

  // Reuse working buffers so each frame does not keep allocating new arrays.
  let bufferA = null, bufferB = null, lastWidth = 0, lastHeight = 0;

  // Create buffers when the image size changes.
  function initBuffers(width, height, pixelCount) {
    if (!bufferA || lastWidth !== width || lastHeight !== height) {
      bufferA = new Uint8ClampedArray(pixelCount);
      bufferB = new Uint8ClampedArray(pixelCount);
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
    const pixelCount = data.length;
    initBuffers(width, height, pixelCount);

    // Move through the cleanup steps ubsing the same two buffers.
    rgbaToGrayscale(data, bufferB);
    denoiseImage(width, height, bufferB, bufferA);
    flattenIllumination(width, height, bufferA, bufferB);
    enhanceContrast(bufferB, bufferA);

    // Join short horizontal breaks in the line.
    horizontalClose(width, height, bufferA, bufferB, 2);

    // Damp weaker components after binary cleanup so non-winning regions survive as weaker traces.
    filterByConnectedComponents(width, height, bufferB, defaultConfig.minComponentSizePixels);

    // Re-binarize after component scoring so only strong waveform-like regions remain.
    applyBinaryMask(bufferB);

    // Build the processed image output.
    const result = restoreImageDataToFullSize(bufferB, originalWidth, originalHeight, roi);

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

  // Restore processed (cropped) data array to original ImageData dimensions
  function restoreImageDataToFullSize(data, originalImageWidth, originalImageHeight, roi) {
    const { x, y, width: roiWidth, height: roiHeight } = roi;
    const result = new ImageData(originalImageWidth, originalImageHeight);
    // Fill with black
    for (let i = 0; i < result.data.length; i += 4) {
      result.data[i] = 0;
      result.data[i + 1] = 0;
      result.data[i + 2] = 0;
      result.data[i + 3] = 255;
    }
    // Paste processed ROI data
    for (let row = 0; row < roiHeight; row++) {
      for (let col = 0; col < roiWidth; col++) {
        const dstIdx = ((y + row) * originalImageWidth + (x + col)) * 4;
        const srcIdx = (row * roiWidth + col) * 4;
        result.data[dstIdx] = data[srcIdx];
        result.data[dstIdx + 1] = data[srcIdx + 1];
        result.data[dstIdx + 2] = data[srcIdx + 2];
        result.data[dstIdx + 3] = data[srcIdx + 3];
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
  function getPercentileFromHistogram(histogram, percentile) {
    const p = Math.max(0, Math.min(100, percentile));
    const totalPixels = histogram.reduce((a, b) => a + b, 0);
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

  // Look up a brightness level at a given percentile.
  function getGrayPercentile(data, percentile) {
    const histogram = buildHistogram(data);
    return getPercentileFromHistogram(histogram, percentile);
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
    const temp = new Uint8ClampedArray(srcData.length);

    // Horizontal pass
    horizontalBlur(width, height, srcData, temp, radius);

    // Vertical pass + flatten illumination
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
        let sum = 0, count = 0;
        for (let yy = y0; yy <= y1; yy++) {
          sum += temp[(yy * width + x) * 4];
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
    const minValue = getPercentileFromHistogram(histogram, defaultConfig.contrastLowPercentile);
    const maxValue = getPercentileFromHistogram(histogram, defaultConfig.contrastHighPercentile);
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
    const temp = new Uint8ClampedArray(srcData.length);

    // Spread bright pixels left and right.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let fg = false;
        const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
        for (let xx = x0; xx <= x1; xx++) {
          if (srcData[(y * width + xx) * 4] === 255) { fg = true; break; }
        }
        const idx = (y * width + x) * 4;
        temp[idx] = temp[idx + 1] = temp[idx + 2] = fg ? 255 : 0;
        temp[idx + 3] = 255;
      }
    }

    // Shrink the result back down.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let allWhite = true;
        const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
        for (let xx = x0; xx <= x1; xx++) {
          if (temp[(y * width + xx) * 4] !== 255) { allWhite = false; break; }
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
          const heightSpan = component.maxY - component.minY + 1;
          const columnsWithPixels = new Uint16Array(widthSpan);
          const columnMinY = new Int16Array(widthSpan);
          const columnMaxY = new Int16Array(widthSpan);
          const columnCenterY = new Float32Array(widthSpan);
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
          let totalColumnThickness = 0;
          let topTouchColumns = 0;
          let bottomTouchColumns = 0;
          let minCenterY = height;
          let maxCenterY = 0;
          let continuityDeltaSum = 0;
          let continuitySteps = 0;
          let prevCenterY = NaN;
          const edgeMargin = Math.max(0, defaultConfig.componentEdgeMarginPx);

          for (let localX = 0; localX < widthSpan; localX++) {
            if (columnsWithPixels[localX] <= 0) continue;
            occupiedColumns++;

            const localThickness = columnMaxY[localX] - columnMinY[localX] + 1;
            totalColumnThickness += localThickness;

            if (columnMinY[localX] <= edgeMargin) topTouchColumns++;
            if (columnMaxY[localX] >= height - 1 - edgeMargin) bottomTouchColumns++;

            const centerY = (columnMinY[localX] + columnMaxY[localX]) / 2;
            columnCenterY[localX] = centerY;
            if (centerY < minCenterY) minCenterY = centerY;
            if (centerY > maxCenterY) maxCenterY = centerY;

            if (Number.isFinite(prevCenterY)) {
              continuityDeltaSum += Math.abs(centerY - prevCenterY);
              continuitySteps++;
            }
            prevCenterY = centerY;
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
            ...component,
            widthSpan,
            heightSpan,
            occupiedColumns,
            centerlineExcursion,
            borderTouchRatio,
            baseWidthScore,
            excursionFactor: excursionPreference,
            borderFactor: borderAvoidancePreference,
            waveformScore,
          });
        }
        nextLabel++;
      }
    }

    // Prefer a long, thin, waveform-like component over a large blob.
    if (components.length > 0) {
      const rankedComponents = components.map((component) => {
        const rankingScore = component.waveformScore;
        return {
          ...component,
          rankingScore,
        };
      });

      const bestRankingScore = Math.max(
        1e-6,
        ...rankedComponents.map((component) => component.rankingScore)
      );
      const componentIntensityByLabel = new Map();

      for (const component of rankedComponents) {
        const normalizedScore = component.rankingScore / bestRankingScore;
        const dampedStrength = Math.pow(Math.max(0, Math.min(1, normalizedScore)), defaultConfig.componentScoreGamma);
        componentIntensityByLabel.set(component.label, Math.round(255 * dampedStrength));
      }

      for (let i = 0; i < n; i++) {
        const componentLabel = label[i];
        const value = componentIntensityByLabel.get(componentLabel) ?? 0;
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
