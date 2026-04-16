// Waveform extractor:
// - follows the waveform line across the image
// - trims weak or noisy ends
// - fills short gaps and centers the result for playback

const TRIM_CONFIDENCE_CONFIG = {
  confWindowRadius: 1, // Nearby area used when judging whether a column looks reliable.
  smoothRadius: 4, // Smooths the confidence score so trimming is less jumpy.
  highThreshold: 0.48, // Score needed to confidently enter the waveform.
  lowThreshold: 0.28, // Score that marks the waveform as getting too weak.
  enterRun: 8, // How many strong columns are needed before keeping a run.
  exitRun: 5, // How many weak columns end a run.
  minSpanColumnsRatio: 0.10, // Small runs below this fraction are ignored.
  minSpanColumnsFloor: 8, // Minimum run length for narrow selections.
  continuityMaxDelta: 12, // Largest jump allowed between nearby columns.
  minKeepValidColumnsRatio: 0.06, // Stop trimming if too little of the waveform would remain.
  minKeepValidColumnsFloor: 8, // Minimum number of kept columns.
};

const CENTER_OF_MASS_CONFIG = {
  bandHalfWidth: 14, // Search width around the predicted line position.
  bandHalfHeight: 10, // Height used when counting bright pixels around the line.
  minForegroundCount: 4, // Minimum bright pixels needed to accept a point.
  maxJumpPx: 12, // Largest allowed vertical jump between columns.
  strongBandCount: 24, // Bright-pixel count that marks a column as a strong section.
  maxJumpForStrongBandPx: 18, // Strong sections are allowed a slightly larger jump.
  medianRadius: 3, // Smooths the detected path.
  bufferCommitThreshold: 5, // Requires a short stable run before locking onto the path.
};

const WAVEFORM_POSTPROCESSING_CONFIG = {
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

  // Find the line, then trim weak sections from the ends.
  const rawTracePath = findCenterOfMassTracePath(imageData, roiBounds);
  const tracePath = trimTracePathByConfidence(rawTracePath, imageData, roiBounds);

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

// Count how many points in the path were successfully found.
function countValidPathPoints(pathY) {
  let count = 0;
  for (let i = 0; i < pathY.length; i++) {
    if (pathY[i] >= 0) count++;
  }
  return count;
}

function isForegroundMaskPixel(value) {
  return value >= 128;
}

// Measure how much of a nearby area looks like foreground.
function getForegroundDensity(imageData, x, y, radiusX, radiusY) {
  const { width, height, data } = imageData;
  let foreground = 0;
  let total = 0;

  for (let dy = -radiusY; dy <= radiusY; dy++) {
    const yy = clamp(y + dy, 0, height - 1);
    for (let dx = -radiusX; dx <= radiusX; dx++) {
      const xx = clamp(x + dx, 0, width - 1);
      const idx = (yy * width + xx) * 4;
      if (isForegroundMaskPixel(data[idx])) foreground++;
      total++;
    }
  }

  return total > 0 ? foreground / total : 0;
}
// Count bright pixels in a vertical band around the current point.
function countForegroundInBand(imageData, x, centerY, halfHeight, roiBounds) {
  const { width, height, data } = imageData;
  const range = getROIYRange(height, roiBounds, centerY, halfHeight);
  let count = 0;

  for (let y = range.yMin; y <= range.yMax; y++) {
    const idx = (y * width + x) * 4;
    if (isForegroundMaskPixel(data[idx])) count++;
  }

  return count;
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

// Smooth a signal with a moving average.
function movingAverage1D(values, radius) {
  if (radius <= 0) return Float32Array.from(values);
  const out = new Float32Array(values.length);
  
  // Build a cumulative sum so each window is fast to read.
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

// Get the allowed Y search range for the current column.
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

// Trim weak or noisy sections from the start and end of the path.
function trimTracePathByConfidence(pathY, imageData, roiBounds = null) {
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

  // Score how reliable each column looks.
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
      settings.confWindowRadius
    );

    let continuityScore = 0.7;
    if (prevValidY !== null) {
      const dy = Math.abs(y - prevValidY);
      continuityScore = 1 - Math.min(1, dy / settings.continuityMaxDelta);
    }

    conf[x] = 0.75 * localDensity + 0.25 * continuityScore;
    prevValidY = y;
  }

  // Smooth the confidence scores.
  const smoothedConf = movingAverage1D(conf, settings.smoothRadius);
  
  // Find the strongest continuous span.
  const spans = [];
  let inTrace = false;
  let start = -1;
  let highCount = 0;
  let lowCount = 0;

  for (let x = 0; x < width; x++) {
    const c = smoothedConf[x];

    // Only start a trace after a stable run of strong columns.
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

    // Only end a trace after several weak columns in a row.
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

  // Keep the longest reliable run.
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

// Follow the waveform line across the image one column at a time.
function findCenterOfMassTracePath(imageData, roiBounds = null) {
  const { width, height, data } = imageData;
  const pathY = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    pathY[i] = NaN;
  }

  const settings = {
    ...CENTER_OF_MASS_CONFIG,
  };

  // Pre-calculate the full search range once.
  const fullRange = getROIYRange(height, roiBounds);
  const workBuffer = new Float32Array(2 * settings.medianRadius + 2);

  const computeColumnCOM = (x, yMin, yMax) => {
    let weightSum = 0;
    let weightedY = 0;
    let foregroundCount = 0;

    for (let y = yMin; y <= yMax; y++) {
      const idx = (y * width + x) * 4;
      const brightness = data[idx];
      if (!isForegroundMaskPixel(brightness)) continue;

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

  // Buffer a few good points before committing to a run.
  const tempBuffer = [];
  let inRun = false; // True once a stable run has started.

  for (let x = 0; x < width; x++) {
    if (!isXInROI(x, roiBounds)) {
      // Drop any pending samples when we leave the ROI.
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

    // First search near the predicted line position.
    const bandRange = getROIYRange(height, roiBounds, predictedY, settings.bandHalfWidth);
    let yEstimate = computeColumnCOM(x, bandRange.yMin, bandRange.yMax);
    if (!Number.isFinite(yEstimate)) {
      // Fall back to the full Y range if the local search fails.
      yEstimate = computeColumnCOM(x, fullRange.yMin, fullRange.yMax);
    }

    if (!Number.isFinite(yEstimate)) {
      // Invalid sample: clear any unstable run.
      if (!inRun) {
        tempBuffer.length = 0;
      } else {
        // A bad point ends the current run.
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
      roiBounds
    );

    const allowedJump = localBandCount >= settings.strongBandCount
      ? settings.maxJumpForStrongBandPx
      : settings.maxJumpPx;

    if (Number.isFinite(prev) && Math.abs(yEstimate - prev) > allowedJump) {
      // A large jump also ends the run.
      if (!inRun) {
        tempBuffer.length = 0;
      } else {
        inRun = false;
        tempBuffer.length = 0;
      }
      continue;
    }

    // Store the valid sample.
    tempBuffer.push({ x, yValue: yEstimate });

    // Once the buffer is stable enough, commit it as part of the path.
    if (tempBuffer.length >= settings.bufferCommitThreshold && !inRun) {
      for (const item of tempBuffer) {
        pathY[item.x] = item.yValue;
      }
      tempBuffer.length = 0;
      inRun = true;
    } else if (inRun) {
      // Once locked on, write points directly.
      pathY[x] = yEstimate;
    }
  }

  // Smooth the path and round it to pixel positions.
  const quantized = new Int16Array(width);
  const smoothed = medianFilterFinite1D(pathY, settings.medianRadius, workBuffer);
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

