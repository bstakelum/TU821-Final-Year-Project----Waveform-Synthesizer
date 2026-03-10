// Waveform extractor:
// - tracks the waveform trace across columns using center-of-mass scoring
// - trims weak/noisy edges with confidence hysteresis
// - fills short gaps and recenters output for synthesis

const DEFAULT_FOREGROUND_CUTOFF = 200;

const TRIM_CONFIDENCE_CONFIG = {
  confWindowRadius: 1,
  smoothRadius: 4,
  highThreshold: 0.52,
  lowThreshold: 0.34,
  enterRun: 10,
  exitRun: 6,
  minSpanColumnsRatio: 0.15,
  minSpanColumnsFloor: 12,
  continuityMaxDelta: 10,
  minKeepValidColumnsRatio: 0.08,
  minKeepValidColumnsFloor: 10,
};

const CENTER_OF_MASS_CONFIG = {
  bandHalfWidth: 14,
  minForegroundCount: 5,
  maxJumpPx: 12,
  medianRadius: 3,
};

const WAVEFORM_POSTPROCESSING_CONFIG = {
  interpolationMaxGap: 10,
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

// Count how many path points are valid.
function countValidPathPoints(pathY) {
  let count = 0;
  for (let i = 0; i < pathY.length; i++) {
    if (pathY[i] >= 0) count++;
  }
  return count;
}

// Get the median of finite values in a 1D window.
function getMedianOfFiniteWindow(values, start, end) {
  const finite = [];
  for (let i = start; i <= end; i++) {
    const value = values[i];
    if (Number.isFinite(value)) finite.push(value);
  }
  if (finite.length === 0) return NaN;
  finite.sort((a, b) => a - b);
  return finite[Math.floor(finite.length / 2)];
}

// Smooth a 1D signal with a median filter that skips invalid values.
function medianFilterFinite1D(values, radius) {
  if (radius <= 0) return Float32Array.from(values);
  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    const median = getMedianOfFiniteWindow(values, start, end);
    output[i] = Number.isFinite(median) ? median : values[i];
  }
  return output;
}

// Smooth a 1D signal with a moving average.
function movingAverage1D(values, radius) {
  if (radius <= 0) return Float32Array.from(values);
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= end; j++) {
      sum += values[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : 0;
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

// Trim weak/noisy start and end sections of the detected path.
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

  const smoothedConf = movingAverage1D(conf, settings.smoothRadius);
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

  for (let x = 0; x < width; x++) {
    if (!isXInROI(x, roiBounds)) {
      pathY[x] = NaN;
      continue;
    }

    const prev = x > 0 ? pathY[x - 1] : NaN;
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
      const fullRange = getROIYRange(height, roiBounds);
      yEstimate = computeColumnCOM(x, fullRange.yMin, fullRange.yMax);
    }

    if (!Number.isFinite(yEstimate)) {
      pathY[x] = NaN;
      continue;
    }

    if (Number.isFinite(prev) && Math.abs(yEstimate - prev) > settings.maxJumpPx) {
      pathY[x] = NaN;
      continue;
    }

    pathY[x] = yEstimate;
  }

  const smoothed = medianFilterFinite1D(pathY, settings.medianRadius);
  const quantized = new Int16Array(width);
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

// Center waveform around zero and replace invalid points safely.
function zeroAndCenterWaveform(waveform) {
  let sum = 0;
  let count = 0;

  for (let i = 0; i < waveform.length; i++) {
    if (!Number.isNaN(waveform[i])) {
      sum += waveform[i];
      count++;
    }
  }

  const mean = count > 0 ? sum / count : 0;
  for (let i = 0; i < waveform.length; i++) {
    if (Number.isNaN(waveform[i])) {
      waveform[i] = 0;
    } else {
      waveform[i] -= mean;
    }
  }
}

