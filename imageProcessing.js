// Image processing:
// - cleans the captured frame so the waveform line is easier to pick out
// - keeps the image the same size for the next step
export function createImageProcessor({
} = {}) {

  const defaultConfig = {
    flattenKernelRadius: 9, // Minimum width of the local background estimate.
    flattenKernelRadiusRatio: 0.03, // Scales the background estimate to larger mobile captures.
    flattenBias: 118, // Brightness added back after flattening so the line stays visible.
    flattenGain: 1.25, // Extra emphasis for dark line contrast after lighting removal.
    localContrastFloor: 16, // Minimum amount a pixel must rise above its local neighborhood.
    localThresholdRadius: 15, // Minimum width of the local threshold neighborhood.
    localThresholdRadiusRatio: 0.06, // Scales local thresholding to larger mobile captures.
    localThresholdBias: 8, // Extra margin above the local mean before a pixel is considered foreground.
    localThresholdStdWeight: 0.35, // Raises the local threshold slightly in noisy regions.
    contrastLowPercentile: 2, // Dark end used when stretching contrast.
    contrastHighPercentile: 98, // Bright end used when stretching contrast.
    minIsolatedNeighborCount: 8, // Removes lone bright pixels that look like noise.
    erodeMinForegroundCount: 6, // Removes very thin bright specks.
    hysteresisHighPercentile: 94, // Bright pixels that are definitely part of the line.
    hysteresisLowPercentile: 62, // Dimmer pixels kept only when they touch strong pixels.
    minComponentSizePixels: 50, // Small blobs below this size are discarded.
    minComponentWidthRatio: 0.10, // Preferred width for waveform-like components, used as a soft ranking cue.
    maxComponentFillRatio: 0.4, // Rejects large filled blobs that are unlikely to be a thin waveform trace.
    maxComponentHeightRatio: 0.6, // Rejects components that cover too much of the frame height.
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

  // Run the full cleanup pipeline.
  function preprocessImage(imageData) {
    if (!imageData) return null;

    const { width, height, data } = imageData;
    const pixelCount = data.length;
    initBuffers(width, height, pixelCount);

    // Move through the cleanup steps using the same two buffers.
    rgbaToGrayscale(data, bufferA);
    denoiseImage(width, height, bufferA, bufferB);
    flattenIllumination(width, height, bufferB, bufferA);
    enhanceContrast(bufferA, bufferB);
    suppressShadowRegions(width, height, bufferB, bufferA);
    
    // Keep strong line pixels and nearby weaker ones.
    applyHysteresisThreshold(bufferA, bufferB, 
      defaultConfig.hysteresisHighPercentile,
      defaultConfig.hysteresisLowPercentile);
    
    // Join short horizontal breaks in the line.
    horizontalClose(width, height, bufferB, bufferA, 2);
    
    // Keep the largest bright shape and drop the rest.
    filterByConnectedComponents(width, height, bufferA, 
      defaultConfig.minComponentSizePixels);
    
    // Copy back into the main working buffer.
    bufferB.set(bufferA);
    
    // Final small cleanup pass.
    cleanupMask(width, height, bufferB);

    // Build the processed image output.
    const result = new ImageData(width, height);
    result.data.set(bufferB);
    return result;
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

  function getEffectiveFlattenRadius(width, height) {
    const minDimension = Math.max(1, Math.min(width, height));
    const ratioRadius = Math.round(minDimension * defaultConfig.flattenKernelRadiusRatio);
    return Math.max(1, Math.max(Math.floor(defaultConfig.flattenKernelRadius), ratioRadius));
  }

  function getEffectiveLocalThresholdRadius(width, height) {
    const minDimension = Math.max(1, Math.min(width, height));
    const ratioRadius = Math.round(minDimension * defaultConfig.localThresholdRadiusRatio);
    return Math.max(1, Math.max(Math.floor(defaultConfig.localThresholdRadius), ratioRadius));
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
    const minValue = getGrayPercentile(srcData, defaultConfig.contrastLowPercentile);
    const maxValue = getGrayPercentile(srcData, defaultConfig.contrastHighPercentile);
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

  // Suppress broad shadow regions by keeping only pixels that stand out from their local neighborhood.
  function suppressShadowRegions(width, height, srcData, dstData) {
    const radius = getEffectiveLocalThresholdRadius(width, height);
    const thresholdBias = defaultConfig.localThresholdBias;
    const stdWeight = defaultConfig.localThresholdStdWeight;
    const contrastFloor = defaultConfig.localContrastFloor;
    const localMean = new Uint8ClampedArray(srcData.length);
    const localSquareMean = new Float32Array(width * height);
    const temp = new Uint8ClampedArray(srcData.length);
    const squareValues = new Float32Array(width * height);
    const squareBlurX = new Float32Array(width * height);

    horizontalBlur(width, height, srcData, temp, radius);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(height - 1, y + radius);
        let sum = 0;
        let count = 0;
        for (let yy = y0; yy <= y1; yy++) {
          sum += temp[(yy * width + x) * 4];
          count++;
        }
        const idx = (y * width + x) * 4;
        const mean = Math.round(sum / count);
        localMean[idx] = mean;
        localMean[idx + 1] = mean;
        localMean[idx + 2] = mean;
        localMean[idx + 3] = 255;
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const pixelValue = srcData[idx * 4];
        squareValues[idx] = pixelValue * pixelValue;
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        let sum = 0;
        let count = 0;
        for (let xx = x0; xx <= x1; xx++) {
          sum += squareValues[y * width + xx];
          count++;
        }
        squareBlurX[y * width + x] = sum / count;
      }
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(height - 1, y + radius);
        let sum = 0;
        let count = 0;
        for (let yy = y0; yy <= y1; yy++) {
          sum += squareBlurX[yy * width + x];
          count++;
        }
        localSquareMean[y * width + x] = sum / count;
      }
    }

    for (let i = 0; i < srcData.length; i += 4) {
      const localMeanValue = localMean[i];
      const localVariance = Math.max(0, localSquareMean[i / 4] - (localMeanValue * localMeanValue));
      const localStdDev = Math.sqrt(localVariance);
      const threshold = Math.min(255, localMeanValue + thresholdBias + (localStdDev * stdWeight));
      const contrastAboveMean = srcData[i] - localMeanValue;
      const keepValue = srcData[i] >= threshold && contrastAboveMean >= contrastFloor
        ? srcData[i]
        : 0;

      dstData[i] = keepValue;
      dstData[i + 1] = keepValue;
      dstData[i + 2] = keepValue;
      dstData[i + 3] = 255;
    }
  }

  // Remove tiny artifacts and reconnect small breaks.
  function cleanupMask(width, height, data) {
    // Shrink bright regions slightly to remove thin noise.
    const erode3x3 = (source, target) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let cnt = 0;
          const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
          const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              if (source[(yy * width + xx) * 4] === 255) cnt++;
            }
          }
          const idx = (y * width + x) * 4, val = cnt >= defaultConfig.erodeMinForegroundCount ? 255 : 0;
          target[idx] = target[idx + 1] = target[idx + 2] = val;
          target[idx + 3] = 255;
        }
      }
    };

    // Grow bright regions to reconnect small gaps.
    const dilate3x3 = (source, target) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let fg = false;
          const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
          const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);
          for (let yy = y0; yy <= y1 && !fg; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              if (source[(yy * width + xx) * 4] === 255) { fg = true; break; }
            }
          }
          const idx = (y * width + x) * 4, val = fg ? 255 : 0;
          target[idx] = target[idx + 1] = target[idx + 2] = val;
          target[idx + 3] = 255;
        }
      }
    };

    // Remove isolated bright dots.
    const suppressIsolatedPixels = (source, target, minNeighborCount) => {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          if (source[idx] !== 255) {
            target[idx] = target[idx + 1] = target[idx + 2] = 0;
            target[idx + 3] = 255;
            continue;
          }
          let cnt = 0;
          const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
          const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              if ((xx !== x || yy !== y) && source[(yy * width + xx) * 4] === 255) cnt++;
            }
          }
          const val = cnt >= minNeighborCount ? 255 : 0;
          target[idx] = target[idx + 1] = target[idx + 2] = val;
          target[idx + 3] = 255;
        }
      }
    };

    const stageB = new Uint8ClampedArray(data.length);
    const stageC = new Uint8ClampedArray(data.length);
    suppressIsolatedPixels(data, stageB, defaultConfig.minIsolatedNeighborCount);
    dilate3x3(stageB, stageC);
    erode3x3(stageC, data);
  }

  // Keep clearly bright pixels, and also keep dimmer pixels that touch them.
  function applyHysteresisThreshold(srcData, dstData, highPercentile, lowPercentile) {
    const highThresh = getGrayPercentile(srcData, highPercentile);
    const lowThresh = getGrayPercentile(srcData, lowPercentile);

    // First pass: mark clearly bright pixels.
    const isHigh = new Uint8Array((srcData.length / 4) * 1);
    for (let i = 0; i < srcData.length; i += 4) {
      const idx = i / 4;
      isHigh[idx] = srcData[i] >= highThresh ? 1 : 0;
    }

    // Second pass: keep strong pixels and nearby weaker pixels.
    for (let i = 0; i < srcData.length; i += 4) {
      const idx = i / 4;
      let keep = isHigh[idx];

      if (!keep && srcData[i] >= lowThresh) {
        // Check nearby pixels for a strong neighbor.
        const width = lastWidth, height = lastHeight;
        const x = idx % width, y = Math.floor(idx / width);
        const x0 = Math.max(0, x - 1), x1 = Math.min(width - 1, x + 1);
        const y0 = Math.max(0, y - 1), y1 = Math.min(height - 1, y + 1);

        for (let yy = y0; yy <= y1 && !keep; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            if (isHigh[(yy * width + xx)]) { keep = 1; break; }
          }
        }
      }

      const val = keep ? 255 : 0;
      dstData[i] = val;
      dstData[i + 1] = val;
      dstData[i + 2] = val;
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

  // Keep only the largest bright region.
  function filterByConnectedComponents(width, height, data, minSizePixels) {
    const n = (data.length / 4);
    const label = new Int32Array(n);
    let nextLabel = 1;
    const minWidthPixels = Math.max(8, Math.floor(width * defaultConfig.minComponentWidthRatio));

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
          const boundingArea = Math.max(1, widthSpan * heightSpan);
          const fillRatio = component.size / boundingArea;
          const heightRatio = heightSpan / Math.max(1, height);

          if (fillRatio > defaultConfig.maxComponentFillRatio || heightRatio > defaultConfig.maxComponentHeightRatio) {
            nextLabel++;
            continue;
          }

          const waveformScore = (widthSpan * widthSpan) / Math.max(1, heightSpan);

          components.push({
            ...component,
            widthSpan,
            heightSpan,
            fillRatio,
            waveformScore,
          });
        }
        nextLabel++;
      }
    }

    // Prefer a long, thin, waveform-like component over a large blob.
    if (components.length > 0) {
      const rankedComponents = components.map((component) => {
        const widthPreference = Math.min(1, component.widthSpan / Math.max(1, minWidthPixels));
        const rankingScore = component.waveformScore * (1 + (0.2 * widthPreference));
        return {
          ...component,
          rankingScore,
        };
      });

      rankedComponents.sort((a, b) => {
        if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
        if (b.waveformScore !== a.waveformScore) return b.waveformScore - a.waveformScore;
        if (b.widthSpan !== a.widthSpan) return b.widthSpan - a.widthSpan;
        return b.size - a.size;
      });
      const selectedLabel = rankedComponents[0].label;

      for (let i = 0; i < n; i++) {
        if (label[i] !== selectedLabel) {
          data[(i) * 4] = 0;
          data[(i) * 4 + 1] = 0;
          data[(i) * 4 + 2] = 0;
          data[(i) * 4 + 3] = 255;
        }
      }
    }
  }

  return {
    preprocessImage,
  };
}
