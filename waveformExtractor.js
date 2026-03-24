// Waveform extractor:
// - tracks the waveform trace across columns using center-of-mass scoring
// - trims weak/noisy edges with confidence hysteresis
// - fills short gaps and recenters output for synthesis

const DEFAULT_FOREGROUND_CUTOFF = 200;

const TRIM_CONFIDENCE_CONFIG = {
  confWindowRadius: 1, // Radius for local foreground density calculation (larger = more smoothing, but slower)
  smoothRadius: 4, // Radius for moving average smoothing of confidence scores (larger = more smoothing, but slower)
  highThreshold: 0.52, // Confidence threshold to consider a column as strong foreground (0-1, higher = more aggressive trimming)
  lowThreshold: 0.34, // Confidence threshold to consider a column as weak foreground (0-1, lower = more aggressive trimming)
  enterRun: 8, // Number of consecutive columns above highThreshold to enter trace state (higher = more aggressive trimming)
  exitRun: 4, // Number of consecutive columns below lowThreshold to exit trace state (higher = more aggressive trimming)
  minSpanColumnsRatio: 0.10, // Minimum ratio of total columns for a valid trace span (0-1, higher = more aggressive trimming)
  minSpanColumnsFloor: 8, // Minimum number of columns for a valid trace span (prevents over-trimming on narrow ROIs)
  continuityMaxDelta: 12, // Maximum allowed Y jump between adjacent columns for good continuity (in pixels, lower = more aggressive trimming)
  minKeepValidColumnsRatio: 0.06, // Minimum ratio of valid columns to keep (0-1, higher = more aggressive trimming)
  minKeepValidColumnsFloor: 8, // Minimum number of valid columns to keep (prevents over-trimming on narrow ROIs)
};

const CENTER_OF_MASS_CONFIG = {
  bandHalfWidth: 14, // Half-width of local search band around predicted path (in pixels, lower = more aggressive but less stable)
  bandHalfHeight: 10, // Half-height of local search band for foreground counting (in pixels, lower = more aggressive but less stable)
  minForegroundCount: 5, // Minimum number of foreground pixels in the local band to consider a valid trace point (higher = more aggressive)
  maxJumpPx: 12, // Maximum allowed Y jump between adjacent columns for valid trace points (in pixels, lower = more aggressive)
  strongBandCount: 30, // Minimum number of foreground pixels in the local band to consider it a strong band (higher = more aggressive, but more stable path tracking)
  maxJumpForStrongBandPx: 18, // Maximum allowed Y jump between adjacent columns when in a strong band (in pixels, lower = more aggressive)
  medianRadius: 3, // Radius for median filtering of the raw path (in pixels, lower = less smoothing, but more noise)
  bufferCommitThreshold: 5, // Number of consecutive valid points needed to commit to the path (higher = more aggressive, but more stable tracking)
};

const WAVEFORM_POSTPROCESSING_CONFIG = {
  interpolationMaxGap: 20, // Maximum gap size (in samples) to fill with linear interpolation (higher = more aggressive filling, but risk of smoothing sharp features)
};

// Main entry: extract a normalized waveform from processed image data.
export function extractWaveformFromImageData(imageData, options = {}) {
  if (!imageData || !Number.isFinite(imageData.width) || !Number.isFinite(imageData.height)) {
    return null;
  }

  const { width, height } = imageData;
  if (width <= 0 || height <= 0) return null;

  const foregroundCutoff = Number.isFinite(options.foregroundCutoff)
    ? options.foregroundCutoff
    : DEFAULT_FOREGROUND_CUTOFF;

  const roiBounds = normalizeROI(options.roi || null, width, height);

  // 1) Detect trace path, then trim low-confidence edges.
  const rawTracePath = findCenterOfMassTracePath(imageData, foregroundCutoff, roiBounds);
  const tracePath = trimTracePathByConfidence(rawTracePath, imageData, foregroundCutoff, roiBounds);

  const normYMin = roiBounds ? roiBounds.yMin : 0;
  const normYMax = roiBounds ? roiBounds.yMax : height - 1;
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

  // 2) Fill short gaps and center around zero for stable playback.
  interpolateWaveform(waveform);
  zeroAndCenterWaveform(waveform);

  return waveform;
}

// Keep a number inside a min/max range.
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Find kth smallest element in array using quickselect
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

// Count how many path points are valid.
function countValidPathPoints(pathY) {
  let count = 0;
  for (let i = 0; i < pathY.length; i++) {
    if (pathY[i] >= 0) count++;
  }
  return count;
}

// Measure how much of a local area is bright foreground.
function getForegroundDensity(imageData, x, y, radiusX, radiusY, cutoff) {
  const { width, height, data } = imageData;
  let foreground = 0;
  let total = 0;

  for (let dy = -radiusY; dy <= radiusY; dy++) {
    const yy = clamp(y + dy, 0, height - 1);
    for (let dx = -radiusX; dx <= radiusX; dx++) {
      const xx = clamp(x + dx, 0, width - 1);
      const idx = (yy * width + xx) * 4;
      if (data[idx] >= cutoff) foreground++;
      total++;
    }
  }

  return total > 0 ? foreground / total : 0;
}
// Count how many foreground pixels are in a vertical band around the current point, which helps determine if it's a strong signal area for more lenient tracking.
function countForegroundInBand(imageData, x, centerY, halfHeight, roiBounds, cutoff) {
  const { width, height, data } = imageData;
  const range = getROIYRange(height, roiBounds, centerY, halfHeight);
  let count = 0;

  for (let y = range.yMin; y <= range.yMax; y++) {
    const idx = (y * width + x) * 4;
    if (data[idx] >= cutoff) count++;
  }

  return count;
}

// Get the median of finite values in a 1D window (uses quickselect for O(n) speed).
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

// Smooth a 1D signal with a median filter that skips invalid values (reuses buffer to avoid allocations).
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

// Smooth a 1D signal with a moving average (reuses cumulative sum for faster computation).
function movingAverage1D(values, radius) {
  if (radius <= 0) return Float32Array.from(values);
  const out = new Float32Array(values.length);
  
  // Build cumulative sum for O(1) window queries instead of O(radius) sums each iteration
  const cumsum = new Float32Array(values.length + 1);
  for (let i = 0; i < values.length; i++) {
    cumsum[i + 1] = cumsum[i] + values[i];
  }
  
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    const windowSum = cumsum[end + 1] - cumsum[start];
    const count = end - start + 1;
    out[i] = count > 0 ? windowSum / count : 0;
  }
  return out;
}

// Clamp ROI input so it is valid for the current image size.
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

// Check whether a column index is inside ROI bounds.
function isXInROI(x, roiBounds) {
  return !roiBounds || (x >= roiBounds.xMin && x <= roiBounds.xMax);
}

// Get Y search range, optionally band-limited and clipped to ROI when present.
function getROIYRange(height, roiBounds, predictedY = null, bandHalfWidth = null) {
  if (!Number.isFinite(predictedY) || !Number.isFinite(bandHalfWidth) || bandHalfWidth < 0) {
    if (!roiBounds) {
      return { yMin: 0, yMax: height - 1 };
    }
    return { yMin: roiBounds.yMin, yMax: roiBounds.yMax };
  }

  const yMinBand = clamp(Math.floor(predictedY - bandHalfWidth), 0, height - 1);
  const yMaxBand = clamp(Math.ceil(predictedY + bandHalfWidth), 0, height - 1);

  if (!roiBounds) {
    return { yMin: yMinBand, yMax: yMaxBand };
  }

  return {
    yMin: Math.max(yMinBand, roiBounds.yMin),
    yMax: Math.min(yMaxBand, roiBounds.yMax),
  };
}

// Trim weak/noisy start and end sections of the detected path (combines scoring and span detection).
function trimTracePathByConfidence(pathY, imageData, foregroundCutoff, roiBounds = null) {
  const { width } = imageData;
  if (!pathY || pathY.length === 0) return pathY;

  const effectiveWidth = roiBounds ? roiBounds.width : width;

  const settings = {
    ...TRIM_CONFIDENCE_CONFIG,
    minSpanColumns: Math.max(
      TRIM_CONFIDENCE_CONFIG.minSpanColumnsFloor,
      Math.floor(effectiveWidth * TRIM_CONFIDENCE_CONFIG.minSpanColumnsRatio)
    ),
    minKeepValidColumns: Math.max(
      TRIM_CONFIDENCE_CONFIG.minKeepValidColumnsFloor,
      Math.floor(effectiveWidth * TRIM_CONFIDENCE_CONFIG.minKeepValidColumnsRatio)
    ),
  };

  // Single pass: compute confidence with moving average simultaneously
  const conf = new Float32Array(width);
  let prevValidY = null;

  for (let x = 0; x < width; x++) {
    const y = pathY[x];
    if (y < 0) {
      conf[x] = 0;
      continue;
    }

    const localDensity = getForegroundDensity(
      imageData,
      x,
      y,
      settings.confWindowRadius,
      settings.confWindowRadius,
      foregroundCutoff
    );

    let continuityScore = 0.7;
    if (prevValidY !== null) {
      const dy = Math.abs(y - prevValidY);
      continuityScore = 1 - Math.min(1, dy / settings.continuityMaxDelta);
    }

    conf[x] = 0.75 * localDensity + 0.25 * continuityScore;
    prevValidY = y;
  }

  // Apply moving average smoothing
  const smoothedConf = movingAverage1D(conf, settings.smoothRadius);
  
  // Combine span detection with same loop
  const spans = [];
  let inTrace = false;
  let start = -1;
  let highCount = 0;
  let lowCount = 0;

  for (let x = 0; x < width; x++) {
    const c = smoothedConf[x];

    // Enter trace state only after a stable high-confidence run.
    if (!inTrace) {
      if (c >= settings.highThreshold) {
        highCount++;
      } else {
        highCount = 0;
      }

      if (highCount >= settings.enterRun) {
        inTrace = true;
        start = x - settings.enterRun + 1;
        lowCount = 0;
      }
      continue;
    }

    // Exit trace state only after sustained low-confidence samples.
    if (c <= settings.lowThreshold) {
      lowCount++;
    } else {
      lowCount = 0;
    }

    if (lowCount >= settings.exitRun) {
      const end = x - settings.exitRun;
      if (start >= 0 && end >= start) {
        spans.push({ start, end, length: end - start + 1 });
      }
      inTrace = false;
      start = -1;
      highCount = 0;
      lowCount = 0;
    }
  }

  if (inTrace && start >= 0) {
    spans.push({ start, end: width - 1, length: width - start });
  }

  if (spans.length === 0) return pathY;

  // Keep the longest confident run to suppress weak/noisy tails.
  let bestSpan = spans[0];
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].length > bestSpan.length) bestSpan = spans[i];
  }

  if (bestSpan.length < settings.minSpanColumns) return pathY;

  const trimmed = new Int16Array(pathY.length);
  for (let x = 0; x < pathY.length; x++) {
    trimmed[x] = x < bestSpan.start || x > bestSpan.end ? -1 : pathY[x];
  }

  if (countValidPathPoints(trimmed) < settings.minKeepValidColumns) {
    return pathY;
  }

  return trimmed;
}

// Track the waveform line across columns using center-of-mass scoring.
function findCenterOfMassTracePath(imageData, foregroundCutoff, roiBounds = null) {
  const { width, height, data } = imageData;
  const pathY = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    pathY[i] = NaN;
  }

  const settings = {
    ...CENTER_OF_MASS_CONFIG,
    foregroundCutoff,
  };

  // Pre-calculate full range once instead of per-column lookup
  const fullRange = getROIYRange(height, roiBounds);
  const workBuffer = new Float32Array(2 * settings.medianRadius + 2);

  const computeColumnCOM = (x, yMin, yMax) => {
    let weightSum = 0;
    let weightedY = 0;
    let foregroundCount = 0;

    for (let y = yMin; y <= yMax; y++) {
      const idx = (y * width + x) * 4;
      const brightness = data[idx];
      if (brightness < settings.foregroundCutoff) continue;

      const weight = brightness / 255;
      weightSum += weight;
      weightedY += y * weight;
      foregroundCount++;
    }

    if (foregroundCount < settings.minForegroundCount || weightSum <= 0) {
      return NaN;
    }

    return weightedY / weightSum;
  };

  // Buffering state: accumulate valid candidates until threshold, then commit
  const tempBuffer = [];
  let inRun = false;  // True once we've committed buffered points

  for (let x = 0; x < width; x++) {
    if (!isXInROI(x, roiBounds)) {
      // Reset buffer at ROI boundary, discard any uncommitted samples
      if (tempBuffer.length > 0 && tempBuffer.length < settings.bufferCommitThreshold) {
        tempBuffer.length = 0;
      }
      continue;
    }

    const prev = inRun ? pathY[x - 1] : (tempBuffer.length > 0 ? tempBuffer[tempBuffer.length - 1].yValue : NaN);
    const prev2 = x > 1 ? pathY[x - 2] : NaN;

    let predictedY = height * 0.5;
    if (Number.isFinite(prev) && Number.isFinite(prev2)) {
      predictedY = prev + (prev - prev2);
    } else if (Number.isFinite(prev)) {
      predictedY = prev;
    }

    // Prefer local band search around the predicted path for better stability.
    const bandRange = getROIYRange(height, roiBounds, predictedY, settings.bandHalfWidth);
    let yEstimate = computeColumnCOM(x, bandRange.yMin, bandRange.yMax);
    if (!Number.isFinite(yEstimate)) {
      // Fall back to the full allowed Y range if the local band has no valid foreground.
      yEstimate = computeColumnCOM(x, fullRange.yMin, fullRange.yMax);
    }

    if (!Number.isFinite(yEstimate)) {
      // Invalid sample: reset buffer if not in committed run
      if (!inRun) {
        tempBuffer.length = 0;
      } else {
        // Already in run; invalid breaks the run
        inRun = false;
        tempBuffer.length = 0;
      }
      continue;
    }

    const localBandCount = countForegroundInBand(
      imageData,
      x,
      Math.round(yEstimate),
      settings.bandHalfHeight,
      roiBounds,
      settings.foregroundCutoff
    );

    const allowedJump = localBandCount >= settings.strongBandCount
      ? settings.maxJumpForStrongBandPx
      : settings.maxJumpPx;

    if (Number.isFinite(prev) && Math.abs(yEstimate - prev) > allowedJump) {
      // Invalid due to jump: reset buffer
      if (!inRun) {
        tempBuffer.length = 0;
      } else {
        inRun = false;
        tempBuffer.length = 0;
      }
      continue;
    }

    // Valid sample: add to buffer
    tempBuffer.push({ x, yValue: yEstimate });

    // Once buffer hits threshold, commit all and continue direct for this run
    if (tempBuffer.length >= settings.bufferCommitThreshold && !inRun) {
      for (const item of tempBuffer) {
        pathY[item.x] = item.yValue;
      }
      tempBuffer.length = 0;
      inRun = true;
    } else if (inRun) {
      // Already in run, add directly
      pathY[x] = yEstimate;
    }
  }

  // Direct quantization: median filter with reused buffer, output Int16Array
  const quantized = new Int16Array(width);
  const smoothed = medianFilterFinite1D(pathY, settings.medianRadius, workBuffer);
  for (let i = 0; i < width; i++) {
    quantized[i] = Number.isFinite(smoothed[i]) ? Math.round(smoothed[i]) : -1;
  }

  return quantized;
}

// Fill short missing gaps between nearby valid waveform points.
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
// Get the median of finite values in an array (ignores NaNs).
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

// Center waveform around zero and replace invalid points safely.
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

