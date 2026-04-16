// Waveform extractor:
// - assumes image processing has already isolated a mostly clean trace
// - reads one waveform position per column
// - fills short gaps and centers the result for playback

const TRACE_EXTRACTION_CONFIG = {
  minForegroundCount: 2, // Require at least a small vertical stroke before accepting a column.
  medianRadius: 2, // Light smoothing to reduce stair-stepping without reshaping the waveform.
};

const WAVEFORM_POSTPROCESSING_CONFIG = {
  // Gap filling
  interpolationMaxGap: 28, // Largest missing gap that will be filled in.
};

// Main entry point: turn the processed image into a normalized waveform.
export function extractWaveformFromImageData(imageData, options = {}) {
  if (!imageData || !Number.isFinite(imageData.width) || !Number.isFinite(imageData.height)) {
    return null;
  }

  const { width, height } = imageData;
  if (width <= 0 || height <= 0) return null;

  const roiBounds = normalizeROI(options.roi || null, width, height);

  // With a clean processed mask, a direct per-column trace is enough.
  const tracePath = findColumnMedianTracePath(imageData, roiBounds);

  // Keep waveform scaling tied to the full frame height.
  // The ROI limits where the trace can be found, but it should not compress the
  // waveform into a smaller vertical range and then stretch it back out later.
  const normYMin = 0;
  const normYMax = height - 1;
  const normYSpan = Math.max(1, normYMax - normYMin);

  const waveform = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    if (!isXInROI(x, roiBounds)) {
      waveform[x] = NaN;
      continue;
    }

    const yPos = tracePath[x];
    waveform[x] = yPos >= 0 ? 1 - ((yPos - normYMin) / normYSpan) * 2 : NaN;
  }

  // Fill short gaps and center the waveform around zero.
  interpolateWaveform(waveform);
  zeroAndCenterWaveform(waveform);

  return waveform;
}

// Keep a number inside a fixed range.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Find the kth smallest value without fully sorting the array.
function quickselect(arr, k) {
  function partition(left, right, pivotIdx) {
    const pivot = arr[pivotIdx];
    [arr[pivotIdx], arr[right]] = [arr[right], arr[pivotIdx]];
    let storeIdx = left;
    for (let i = left; i < right; i++) {
      if (arr[i] < pivot) {
        [arr[storeIdx], arr[i]] = [arr[i], arr[storeIdx]];
        storeIdx++;
      }
    }
    [arr[right], arr[storeIdx]] = [arr[storeIdx], arr[right]];
    return storeIdx;
  }

  let left = 0, right = arr.length - 1;
  while (left <= right) {
    const pivotIdx = partition(left, right, Math.floor(Math.random() * (right - left + 1)) + left);
    if (pivotIdx === k) return arr[k];
    if (pivotIdx < k) left = pivotIdx + 1;
    else right = pivotIdx - 1;
  }
  return arr[k] || 0;
}

function isForegroundMaskPixel(value) {
  return value >= 128;
}

// Get the median in a small window while ignoring invalid values.
function getMedianOfFiniteWindow(values, start, end, workBuffer) {
  let count = 0;
  for (let i = start; i <= end; i++) {
    const value = values[i];
    if (Number.isFinite(value)) {
      workBuffer[count++] = value;
    }
  }
  if (count === 0) return NaN;
  const k = Math.floor(count / 2);
  return quickselect(workBuffer.subarray(0, count), k);
}

// Smooth the path with a median filter while skipping invalid values.
function medianFilterFinite1D(values, radius, workBuffer) {
  if (radius <= 0) return Float32Array.from(values);
  const output = new Float32Array(values.length);
  const maxWindowSize = 2 * radius + 1;
  const buffer = workBuffer || new Float32Array(maxWindowSize);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    const median = getMedianOfFiniteWindow(values, start, end, buffer);
    output[i] = Number.isFinite(median) ? median : values[i];
  }
  return output;
}

// Make sure the ROI fits inside the image.
function normalizeROI(roi, width, height) {
  if (!roi) return null;

  const x = clamp(Math.floor(roi.x ?? 0), 0, width - 1);
  const y = clamp(Math.floor(roi.y ?? 0), 0, height - 1);
  const maxWidth = width - x;
  const maxHeight = height - y;
  const roiWidth = clamp(Math.floor(roi.width ?? width), 1, maxWidth);
  const roiHeight = clamp(Math.floor(roi.height ?? height), 1, maxHeight);

  return {
    x,
    y,
    width: roiWidth,
    height: roiHeight,
    xMin: x,
    xMax: x + roiWidth - 1,
    yMin: y,
    yMax: y + roiHeight - 1,
  };
}

// Check whether a column lies inside the ROI.
function isXInROI(x, roiBounds) {
  return !roiBounds || (x >= roiBounds.xMin && x <= roiBounds.xMax);
}

// Read the waveform position directly from each column of the cleaned mask.
function findColumnMedianTracePath(imageData, roiBounds = null) {
  const { width, height, data } = imageData;
  const pathY = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    pathY[i] = NaN;
  }

  const settings = {
    ...TRACE_EXTRACTION_CONFIG,
  };
  const workBuffer = new Float32Array(2 * settings.medianRadius + 2);

  const getColumnMedianY = (x, yMin, yMax) => {
    let foregroundCount = 0;

    for (let y = yMin; y <= yMax; y++) {
      const idx = (y * width + x) * 4;
      if (!isForegroundMaskPixel(data[idx])) continue;
      foregroundCount++;
    }

    if (foregroundCount < settings.minForegroundCount) {
      return NaN;
    }

    const medianOffset = Math.floor((foregroundCount - 1) / 2);
    let seen = 0;
    for (let y = yMin; y <= yMax; y++) {
      const idx = (y * width + x) * 4;
      if (!isForegroundMaskPixel(data[idx])) continue;
      if (seen === medianOffset) {
        if (foregroundCount % 2 === 1) {
          return y;
        }

        let nextY = y;
        for (let yy = y + 1; yy <= yMax; yy++) {
          const nextIdx = (yy * width + x) * 4;
          if (isForegroundMaskPixel(data[nextIdx])) {
            nextY = yy;
            break;
          }
        }
        return (y + nextY) / 2;
      }
      seen++;
    }

    return NaN;
  };
  for (let x = 0; x < width; x++) {
    if (!isXInROI(x, roiBounds)) {
      continue;
    }

    const yMin = roiBounds ? roiBounds.yMin : 0;
    const yMax = roiBounds ? roiBounds.yMax : height - 1;
    const yEstimate = getColumnMedianY(x, yMin, yMax);

    if (!Number.isFinite(yEstimate)) {
      continue;
    }

    const quantizedY = Math.round(yEstimate);
    pathY[x] = quantizedY;
  }

  // Smooth the path and round it to pixel positions.
  const smoothed = medianFilterFinite1D(pathY, settings.medianRadius, workBuffer);
  const quantized = new Int16Array(width);
  for (let i = 0; i < width; i++) {
    quantized[i] = Number.isFinite(smoothed[i]) ? Math.round(smoothed[i]) : -1;
  }

  return quantized;
}

// Fill short missing gaps between nearby points.
function interpolateWaveform(waveform) {
  const { interpolationMaxGap: maxGap } = WAVEFORM_POSTPROCESSING_CONFIG;
  let i = 0;

  while (i < waveform.length) {
    if (!Number.isNaN(waveform[i])) {
      i++;
      continue;
    }

    const start = i - 1;

    while (i < waveform.length && Number.isNaN(waveform[i])) {
      i++;
    }

    const end = i;
    const gap = end - start - 1;

    if (start >= 0 && end < waveform.length && gap <= maxGap) {
      const startValue = waveform[start];
      const endValue = waveform[end];
      for (let j = 1; j <= gap; j++) {
        waveform[start + j] = startValue + (endValue - startValue) * (j / (gap + 1));
      }
    }
  }
}
// Get the median while ignoring missing values.
function getMedianOfFiniteArray(values) {
  const finiteValues = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isNaN(v)) finiteValues.push(v);
  }
  if (finiteValues.length === 0) return 0;
  finiteValues.sort((a, b) => a - b);
  const mid = Math.floor(finiteValues.length / 2);
  if (finiteValues.length % 2 === 1) {
    return finiteValues[mid];
  }
  return (finiteValues[mid - 1] + finiteValues[mid]) / 2;
}

// Center the waveform around zero and replace missing points with 0.
function zeroAndCenterWaveform(waveform) {
  const median = getMedianOfFiniteArray(waveform);
  for (let i = 0; i < waveform.length; i++) {
    if (Number.isNaN(waveform[i])) {
      waveform[i] = 0;
    } else {
      waveform[i] -= median;
    }
  }
}

