// Waveform extractor:
// - assumes image processing has already isolated a mostly clean trace
// - reads one waveform position per column
// - smooths and centers the result for playback

const TRACE_EXTRACTION_CONFIG = {
  minForegroundCount: 2, // Require at least a small vertical stroke before accepting a column.
  medianRadius: 2, // Light smoothing to reduce stair-stepping without reshaping the waveform.
};

// Turn the processed image into a normalized Float32Array waveform.
// Columns with no detected trace become zero.
export function extractWaveformFromImageData(imageData) {
  if (!imageData || !Number.isFinite(imageData.width) || !Number.isFinite(imageData.height)) {
    return null;
  }

  const { width, height } = imageData;
  if (width <= 0 || height <= 0) return null;

  const tracePath = findColumnMedianTracePath(imageData);

  // Vertical scale is relative to the full ROI height.
  const normYMin = 0;
  const normYMax = height - 1;
  const normYSpan = Math.max(1, normYMax - normYMin);

  const waveform = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const yPos = tracePath[x];
    waveform[x] = yPos >= 0 ? 1 - ((yPos - normYMin) / normYSpan) * 2 : NaN;
  }

  // Center around zero; replace missing columns with 0.
  zeroAndCenterWaveform(waveform);

  return waveform;
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


// Read the waveform position directly from each column of the cleaned mask.
function findColumnMedianTracePath(imageData) {
  const { width, height, data } = imageData;
  const pathY = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    pathY[i] = NaN;
  }

  const settings = {
    ...TRACE_EXTRACTION_CONFIG,
  };
  const workBuffer = new Float32Array(2 * settings.medianRadius + 2);

  // For each column, scan the full height
  const getColumnMedianY = (x) => {
    let foregroundCount = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (!isForegroundMaskPixel(data[idx])) continue;
      foregroundCount++;
    }
    if (foregroundCount < settings.minForegroundCount) {
      return NaN;
    }
    const medianOffset = Math.floor((foregroundCount - 1) / 2);
    let seen = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (!isForegroundMaskPixel(data[idx])) continue;
      if (seen === medianOffset) {
        if (foregroundCount % 2 === 1) {
          return y;
        }
        let nextY = y;
        for (let yy = y + 1; yy < height; yy++) {
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
    const yEstimate = getColumnMedianY(x);
    if (!Number.isFinite(yEstimate)) {
      continue;
    }
    pathY[x] = yEstimate; // keep as float so the median filter can smooth sub-pixel positions
  }
  // Smooth the path and round it to pixel positions.
  const smoothed = medianFilterFinite1D(pathY, settings.medianRadius, workBuffer);
  const quantized = new Int16Array(width);
  for (let i = 0; i < width; i++) {
    quantized[i] = Number.isFinite(smoothed[i]) ? Math.round(smoothed[i]) : -1;
  }
  return quantized;
}


// Persistent work buffer for median computation — avoids a heap allocation per capture.
// 4096 entries covers any realistic canvas width.
const _medianWorkBuffer = new Float32Array(4096);

// Get the median while ignoring missing values.
// Uses quickselect (O(n)) instead of sort (O(n log n)) to avoid allocation and comparator cost.
function getMedianOfFiniteArray(values) {
  let count = 0;
  const bufLen = _medianWorkBuffer.length;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isNaN(v) && count < bufLen) {
      _medianWorkBuffer[count++] = v;
    }
  }
  if (count === 0) return 0;
  const buf = _medianWorkBuffer.subarray(0, count);
  const k = Math.floor(count / 2);
  const upper = quickselect(buf, k);
  if (count % 2 === 1) return upper;
  // For even count, the lower middle is the max of elements left of k after quickselect.
  let lower = -Infinity;
  for (let i = 0; i < k; i++) {
    if (buf[i] > lower) lower = buf[i];
  }
  return (lower + upper) / 2;
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