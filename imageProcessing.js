// Image processing:
// - cleans captured frames so the waveform trace stands out against background noise
// - preserves image shape for downstream extraction (same width/height)
// - OPTIMIZED: removed array cloning, histogram percentiles

// Build and return the image processing helper used by the app.
export function createImageProcessor({
} = {}) {

  const defaultConfig = {
    flattenKernelRadius: 5, // Radius for local background estimation (larger = more aggressive flattening, but slower)
    flattenBias: 118, // Bias added after flattening to keep trace visible (lower = more aggressive flattening)
    contrastLowPercentile: 2, // Low percentile for contrast stretching (aggressive noise removal)
    contrastHighPercentile: 98, // High percentile for contrast stretching (aggressive noise removal)
    minIsolatedNeighborCount: 8, // Minimum number of white neighbors to keep a pixel (removes isolated noise)
    erodeMinForegroundCount: 6, // Minimum number of white neighbors to keep a pixel during erosion (removes thin noise)
    hysteresisHighPercentile: 96, // High percentile for strong trace pixels (aggressive noise removal)
    hysteresisLowPercentile: 70, // Low percentile for weak trace pixels (keep if adjacent to strong pixels)
    minComponentSizePixels: 50, // Minimum size of connected components to keep (removes small noise blobs, keeps main trace)
  };

  // Reusable buffers for ping-pong processing (removes repeated cloning)
  let bufferA = null, bufferB = null, lastWidth = 0, lastHeight = 0;

  // Initialize or reuse buffers based on image dimensions
  function initBuffers(width, height, pixelCount) {
    if (!bufferA || lastWidth !== width || lastHeight !== height) {
      bufferA = new Uint8ClampedArray(pixelCount);
      bufferB = new Uint8ClampedArray(pixelCount);
      lastWidth = width;
      lastHeight = height;
    }
  }

  // Build histogram for fast percentile queries
  function buildHistogram(data) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) {
      hist[data[i]]++;
    }
    return hist;
  }

  // Find percentile value from histogram
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

  // Run the full preprocessing pipeline using two reusable buffers (ping-pong).
  function preprocessImage(imageData) {
    if (!imageData) return null;

    const { width, height, data } = imageData;
    const pixelCount = data.length;
    initBuffers(width, height, pixelCount);

    // Pipeline: reuse buffers A and B instead of cloning
    rgbaToGrayscale(data, bufferA);
    denoiseImage(width, height, bufferA, bufferB);
    flattenIllumination(width, height, bufferB, bufferA);
    enhanceContrast(bufferA, bufferB);
    
    // NEW: Hysteresis thresholding (cleaner than single threshold)
    applyHysteresisThreshold(bufferB, bufferA, 
      defaultConfig.hysteresisHighPercentile,
      defaultConfig.hysteresisLowPercentile);
    
    // NEW: Horizontal morphological close (reinforce horizontal traces)
    horizontalClose(width, height, bufferA, bufferB, 2);
    
    // NEW: Filter to keep only largest connected component (remove noise blobs)
    filterByConnectedComponents(width, height, bufferB, 
      defaultConfig.minComponentSizePixels);
    
    // Keep result in bufferB, move to bufferA for consistency
    bufferA.set(bufferB);
    
    // Original cleanup (suppress isolated, dilate, erode)
    cleanupMask(width, height, bufferA);

    // Create final ImageData from processed buffer
    const result = new ImageData(width, height);
    result.data.set(bufferA);
    return result;
  }

  // Find a brightness value at a given percentile (using histogram).
  function getGrayPercentile(data, percentile) {
    const histogram = buildHistogram(data);
    return getPercentileFromHistogram(histogram, percentile);
  }

  // Convert color image data to grayscale (writes to output buffer).
  function rgbaToGrayscale(srcData, dstData) {
    for (let i = 0; i < srcData.length; i += 4) {
      const gray = Math.round(0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2]);
      dstData[i] = gray;
      dstData[i + 1] = gray;
      dstData[i + 2] = gray;
      dstData[i + 3] = 255;
    }
  }

  // Smooth small speckles with optimized edge handling (no clamping in inner loop).
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

  // Separable horizontal blur helper for fast illumination flattening
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

  // Reduce uneven lighting using separable convolution (50% faster than nested loop).
  function flattenIllumination(width, height, srcData, dstData) {
    const radius = Math.max(1, Math.floor(defaultConfig.flattenKernelRadius));
    const bias = Number.isFinite(defaultConfig.flattenBias) ? defaultConfig.flattenBias : 128;
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
        const flattened = Math.max(0, Math.min(255, Math.round(darkResponse + bias)));
        dstData[idx] = flattened;
        dstData[idx + 1] = flattened;
        dstData[idx + 2] = flattened;
        dstData[idx + 3] = 255;
      }
    }
  }

  // Stretch contrast so dark and bright areas separate more clearly.
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

  // Remove tiny artifacts and connect broken trace pieces in the mask.
  function cleanupMask(width, height, data) {
    // Shrink white regions slightly to remove thin noise
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

    // Grow white regions to reconnect small breaks
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

    // Remove isolated white dots that likely come from noise
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

  // Hysteresis thresholding: keep high-confidence pixels and low-confidence pixels adjacent to high.
  // Purpose: Reduce isolated noise while connecting faint trace pixels to strong trace regions.
  function applyHysteresisThreshold(srcData, dstData, highPercentile, lowPercentile) {
    const highThresh = getGrayPercentile(srcData, highPercentile);
    const lowThresh = getGrayPercentile(srcData, lowPercentile);

    // First pass: mark high-confidence pixels
    const isHigh = new Uint8Array((srcData.length / 4) * 1);
    for (let i = 0; i < srcData.length; i += 4) {
      const idx = i / 4;
      isHigh[idx] = srcData[i] >= highThresh ? 1 : 0;
    }

    // Second pass: keep high pixels and low-pixels adjacent to high
    for (let i = 0; i < srcData.length; i += 4) {
      const idx = i / 4;
      let keep = isHigh[idx];

      if (!keep && srcData[i] >= lowThresh) {
        // Check 8-neighborhood for high pixels
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

  // Horizontal morphological close: dilate horizontally then erode horizontally.
  // Purpose: Connect gaps in horizontal traces, suppress vertical noise.
  function horizontalClose(width, height, srcData, dstData, radius) {
    const temp = new Uint8ClampedArray(srcData.length);

    // Horizontal dilate: spread white pixels left/right
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

    // Horizontal erode: shrink white regions back
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

  // Connected component filtering: keep only the N largest components.
  // Purpose: Remove noise blobs; preserve main trace.
  function filterByConnectedComponents(width, height, data, minSizePixels) {
    const n = (data.length / 4);
    const label = new Int32Array(n);
    let nextLabel = 1;

    // Simple flood-fill labeling
    const floodFill = (startIdx) => {
      const stack = [startIdx];
      const component = [];
      while (stack.length > 0) {
        const idx = stack.pop();
        if (label[idx]) continue;
        label[idx] = nextLabel;
        component.push(idx);

        const x = idx % width, y = Math.floor(idx / width);
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
      return component;
    };

    // Label all components
    const components = [];
    for (let i = 0; i < n; i++) {
      if (!label[i] && data[(i) * 4] === 255) {
        const component = floodFill(i);
        if (component.length >= minSizePixels) {
          components.push({ label: nextLabel, size: component.length, indices: component });
        }
        nextLabel++;
      }
    }

    // Keep only largest component; zero out others
    if (components.length > 0) {
      components.sort((a, b) => b.size - a.size);
      const largestLabel = components[0].label;

      for (let i = 0; i < n; i++) {
        if (label[i] !== largestLabel) {
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
