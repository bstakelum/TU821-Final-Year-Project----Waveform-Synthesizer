// Audio engine:
// - plays the current waveform as a looping sound
// - prepares the waveform for playback
// - draws an FFT-based spectrum
export function createSynthAudioEngine({
  playButton,
  spectrumCanvas,
}) {
  // Default time for one full waveform loop. The slider can change this.
  const DEFAULT_PANEL_DURATION_SECONDS = 0.01;
  const MIN_PANEL_DURATION_SECONDS = 0.001; // 1 ms
  const MAX_PANEL_DURATION_SECONDS = 0.020; // 20 ms
  const ATTACK_SECONDS = 0.02;
  const RELEASE_SECONDS = 0.05;
  const SPECTRUM_BAR_COUNT = 160;
  const SPECTRUM_MIN_HZ = 20;
  const SPECTRUM_MAX_HZ = 40000;
  const HEARING_MIN_HZ = 20;
  const HEARING_MAX_HZ = 20000;
  const DEFAULT_SPECTRUM_SCALE = 'linear';

  let audioContext = null;
  let masterGainNode = null;
  let preparedWavetable = null;
  let activeSourceNode = null;
  let activeRepeatCount = 1;
  let isActive = false;
  let spectrumScale = DEFAULT_SPECTRUM_SCALE;
  let panelDurationSeconds = DEFAULT_PANEL_DURATION_SECONDS;

  // Persistent buffers reused across redraws to avoid per-frame heap allocation.
  const spectrumBarsBuffer = new Float32Array(SPECTRUM_BAR_COUNT);

  // Pre-built RGB colour lookup table indexed by magnitude (0–255).
  const spectrumColourTable = (() => {
    const table = new Array(256);
    for (let i = 0; i < 256; i++) {
      const m = i / 255;
      const r = Math.round(40 + 210 * m);
      const g = Math.round(100 + 120 * (1 - m));
      const b = Math.round(255 - 170 * m);
      table[i] = `rgb(${r},${g},${b})`;
    }
    return table;
  })();

  // Cached trig values for each FFT size, computed once and reused.
  const twiddleCache = new Map();
  const spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;

  // Store a new waveform and refresh the spectrum.
  function updateWaveform(waveform) {
    prepareWaveformForSynthesis(waveform);

    if (!preparedWavetable || preparedWavetable.length === 0) {
      return;
    }
  }
  // Change the playback period and redraw the spectrum.
  function setPanelDurationSeconds(seconds) {
    panelDurationSeconds = sanitizePanelDurationSeconds(seconds);

    if (activeSourceNode && audioContext && preparedWavetable && preparedWavetable.length > 0) {
      const tiledLength = preparedWavetable.length * activeRepeatCount;
      const desiredLoopFrequencyHz = 1 / panelDurationSeconds;
      const baseTableFrequency = audioContext.sampleRate / tiledLength;
      const playbackRate = desiredLoopFrequencyHz / baseTableFrequency;
      activeSourceNode.playbackRate.setValueAtTime(playbackRate, audioContext.currentTime);
    }

    if (preparedWavetable) {
      drawSpectrumFromWaveform(preparedWavetable);
    }

    return panelDurationSeconds;
  }

  // Start audio output.
  async function startAudio() {
    ensureAudioEngine();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    const started = startCustomSynthesis();
    if (!started) {
      isActive = false;
      if (playButton) playButton.textContent = 'Play';
      return;
    }

    isActive = true;
    if (playButton) playButton.textContent = 'Stop';
  }
  // Switch the spectrum between linear and log frequency spacing.
  function setSpectrumScale(mode) {
    spectrumScale = mode === 'log' ? 'log' : 'linear';
    if (preparedWavetable) {
      drawSpectrumFromWaveform(preparedWavetable);
    } else {
      clearSpectrumCanvas();
    }
  }

  async function stopAudio() {
    if (!audioContext) return;

    stopCustomSynthesis();

    // Wait for the fade-out to finish before suspending to avoid a click.
    if (audioContext.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, (RELEASE_SECONDS + 0.05) * 1000));
      if (audioContext.state === 'running') {
        await audioContext.suspend();
      }
    }

    isActive = false;
    if (playButton) playButton.textContent = 'Play';
  }

  async function toggleAudio() {
    if (isActive) {
      await stopAudio();
      return;
    }

    await startAudio();
  }

  if (playButton) {
    playButton.addEventListener('click', () => {
      toggleAudio().catch((err) => {
        console.error('Audio toggle error:', err);
      });
    });
  }

  clearSpectrumCanvas();

  return {
    updateWaveform,
    setSpectrumScale,
    setPanelDurationSeconds,
    getPanelDurationSeconds: () => panelDurationSeconds,
    getPreparedWavetableLength: () => (preparedWavetable ? preparedWavetable.length : 0),
    startAudio,
    stopAudio,
    exportWaveformToCSV,
    get preparedWavetable() { return preparedWavetable; },
  };

  // Save the prepared waveform as a simple CSV file.
  function exportWaveformToCSV(waveform, filename = 'waveform.csv') {
    if (!Array.isArray(waveform) && !(waveform instanceof Float32Array) && !(waveform instanceof Float64Array)) {
      console.error('exportWaveformToCSV: Input is not an array');
      return;
    }
    const csvContent = waveform.map(x => x.toString()).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }
  // Keep the panel period inside safe limits.
  function sanitizePanelDurationSeconds(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_PANEL_DURATION_SECONDS;
    return Math.max(MIN_PANEL_DURATION_SECONDS, Math.min(MAX_PANEL_DURATION_SECONDS, numeric));
  }

  function toFiniteWaveform(input) {
    if (!input || !Number.isFinite(input.length) || input.length <= 0) {
      return null;
    }

    const out = new Float32Array(input.length);
    let hasFinite = false;

    for (let i = 0; i < input.length; i++) {
      const value = Number(input[i]);
      if (Number.isFinite(value)) {
        out[i] = value;
        hasFinite = true;
      } else {
        out[i] = 0;
      }
    }

    return hasFinite ? out : null;
  }
  // Move the waveform so it is centered around zero.
  function removeDcOffset(waveform) {
    let sum = 0;
    for (let i = 0; i < waveform.length; i++) {
      sum += waveform[i];
    }
    const mean = waveform.length > 0 ? sum / waveform.length : 0;

    for (let i = 0; i < waveform.length; i++) {
      waveform[i] -= mean;
    }

    return waveform;
  }

  // Create the audio nodes the first time audio is needed.
  function ensureAudioEngine() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    if (!masterGainNode) {
      masterGainNode = audioContext.createGain();
      masterGainNode.gain.value = 0;
      masterGainNode.connect(audioContext.destination);
    }
  }

  function clearSpectrumCanvas() {
    if (!spectrumCanvas || !spectrumCtx) return;
    spectrumCtx.fillStyle = '#000';
    spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  }

  function getRatioForFrequency(frequencyHz, minHz, maxHz, mode) {
    const clampedFrequencyHz = Math.max(minHz, Math.min(maxHz, frequencyHz));

    if (mode === 'log') {
      if (clampedFrequencyHz <= 0 || minHz <= 0 || maxHz <= minHz) {
        return 0;
      }

      return Math.log(clampedFrequencyHz / minHz) / Math.log(maxHz / minHz);
    }

    if (maxHz <= minHz) {
      return 0;
    }

    return (clampedFrequencyHz - minHz) / (maxHz - minHz);
  }

  function resamplePeriodicSignal(signal, targetLength) {
    if (targetLength === signal.length) {
      return Float32Array.from(signal);
    }

    const out = new Float32Array(targetLength);
    const sourceLength = signal.length;

    for (let i = 0; i < targetLength; i++) {
      const sourceIndex = (i * sourceLength) / targetLength;
      const leftIndex = Math.floor(sourceIndex);
      const fraction = sourceIndex - leftIndex;
      const wrappedLeftIndex = leftIndex % sourceLength;
      const wrappedRightIndex = (wrappedLeftIndex + 1) % sourceLength;
      const leftValue = signal[wrappedLeftIndex];
      const rightValue = signal[wrappedRightIndex];

      out[i] = leftValue + ((rightValue - leftValue) * fraction);
    }

    return out;
  }

  function nextPowerOfTwo(value) {
    let size = 1;
    while (size < value) {
      size <<= 1;
    }
    return size;
  }

  // Run a simple radix-2 FFT on the waveform for the spectrum display.
  function computeFftMagnitudes(signal) {
    const fftSize = nextPowerOfTwo(signal.length);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    const magnitudeCount = (fftSize >> 1) + 1;
    const magnitudes = new Float32Array(magnitudeCount);

    // Copy signal into real[], resampling only when lengths differ.
    if (fftSize === signal.length) {
      real.set(signal);
    } else {
      real.set(resamplePeriodicSignal(signal, fftSize));
    }

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < fftSize; i++) {
      let bit = fftSize >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;

      if (i < j) {
        const tempReal = real[i];
        real[i] = real[j];
        real[j] = tempReal;

        const tempImag = imag[i];
        imag[i] = imag[j];
        imag[j] = tempImag;
      }
    }

    // Fetch or build the twiddle table for this FFT size.
    let twiddle = twiddleCache.get(fftSize);
    if (!twiddle) {
      const cosTable = new Float64Array(fftSize >> 1);
      const sinTable = new Float64Array(fftSize >> 1);
      for (let k = 0; k < fftSize >> 1; k++) {
        const angle = (-2 * Math.PI * k) / fftSize;
        cosTable[k] = Math.cos(angle);
        sinTable[k] = Math.sin(angle);
      }
      twiddle = { cos: cosTable, sin: sinTable };
      twiddleCache.set(fftSize, twiddle);
    }

    // Cooley-Tukey butterfly stages.
    for (let size = 2; size <= fftSize; size <<= 1) {
      const halfSize = size >> 1;
      const step = fftSize / size; // twiddle table stride for this stage

      for (let start = 0; start < fftSize; start += size) {
        for (let offset = 0; offset < halfSize; offset++) {
          const evenIndex = start + offset;
          const oddIndex = evenIndex + halfSize;
          const k = offset * step;
          const twiddleReal = twiddle.cos[k];
          const twiddleImag = twiddle.sin[k];
          const oddReal = real[oddIndex];
          const oddImag = imag[oddIndex];
          const tempReal = twiddleReal * oddReal - twiddleImag * oddImag;
          const tempImag = twiddleReal * oddImag + twiddleImag * oddReal;

          real[oddIndex] = real[evenIndex] - tempReal;
          imag[oddIndex] = imag[evenIndex] - tempImag;
          real[evenIndex] += tempReal;
          imag[evenIndex] += tempImag;
        }
      }
    }

    for (let i = 0; i < magnitudeCount; i++) {
      magnitudes[i] = Math.hypot(real[i], imag[i]) / fftSize;
    }

    // Double the non-DC, non-Nyquist bins to account for both sides of the spectrum.
    for (let i = 1; i < magnitudeCount - 1; i++) {
      magnitudes[i] *= 2;
    }

    return { fftSize, analysisLength: fftSize, magnitudes };
  }

  function buildSpectrumBarsFromFft(magnitudes, sampleRateHz, minHz, maxHz, bars, scale) {
    spectrumBarsBuffer.fill(0);
    const nyquistHz = 0.5 * sampleRateHz;
    const maxRenderableHz = Math.min(maxHz, nyquistHz);
    const fftSize = (magnitudes.length - 1) * 2;
    const binWidthHz = sampleRateHz / fftSize;

    if (maxRenderableHz <= minHz) {
      return spectrumBarsBuffer;
    }

    for (let bin = 1; bin < magnitudes.length; bin++) {
      const frequencyHz = bin * binWidthHz;

      if (frequencyHz < minHz || frequencyHz > maxRenderableHz) {
        continue;
      }

      const ratio = getRatioForFrequency(frequencyHz, minHz, maxHz, scale);
      const barIndex = Math.min(bars - 1, Math.max(0, Math.floor(ratio * bars)));

      if (magnitudes[bin] > spectrumBarsBuffer[barIndex]) {
        spectrumBarsBuffer[barIndex] = magnitudes[bin];
      }
    }

    return spectrumBarsBuffer;
  }

  // Draw the spectrum by mapping FFT bins into the display bars.
  function drawSpectrumFromWaveform(waveform) {
    if (!spectrumCanvas || !spectrumCtx || !waveform || waveform.length < 4) {
      clearSpectrumCanvas();
      return;
    }

    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;
    const marginLeft = 46;
    const marginRight = 26;
    const marginTop = 10;
    const marginBottom = 28;
    const plotWidth = Math.max(10, width - marginLeft - marginRight);
    const plotHeight = Math.max(20, height - marginTop - marginBottom);
    const plotX = marginLeft;
    const plotY = marginTop;

    spectrumCtx.fillStyle = '#000';
    spectrumCtx.fillRect(0, 0, width, height);
    // Keep the same visible frequency range regardless of the waveform.
    const minDisplayHz = SPECTRUM_MIN_HZ;
    const maxDisplayHz = SPECTRUM_MAX_HZ;
    // Pre-compute the log denominator used by every log-scale ratio calculation.
    const logMaxOverMin = Math.log(maxDisplayHz / minDisplayHz);

    const bars = SPECTRUM_BAR_COUNT;
    const gap = 1;
    const fft = computeFftMagnitudes(waveform);
    const analysisSampleRate = fft.analysisLength / panelDurationSeconds;
    const nyquistHz = 0.5 * analysisSampleRate;
    const mags = buildSpectrumBarsFromFft(
      fft.magnitudes,
      analysisSampleRate,
      minDisplayHz,
      maxDisplayHz,
      bars,
      spectrumScale,
    );
    let maxMag = 0;

    for (let i = 0; i < bars; i++) {
      if (mags[i] > maxMag) maxMag = mags[i];
    }

    // Axes and labels.
    spectrumCtx.strokeStyle = '#334155';
    spectrumCtx.lineWidth = 1;
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(plotX, plotY);
    spectrumCtx.lineTo(plotX, plotY + plotHeight);
    spectrumCtx.lineTo(plotX + plotWidth, plotY + plotHeight);
    spectrumCtx.stroke();

    spectrumCtx.fillStyle = '#8aa0b6';
    spectrumCtx.font = '10px sans-serif';

    const yTicks = [0, 1, 2];
    for (let i = 0; i < yTicks.length; i++) {
      const t = yTicks[i];
      const y = plotY + plotHeight - (t / 2) * plotHeight;
      spectrumCtx.fillRect(plotX - 3, Math.round(y), 3, 1);
      spectrumCtx.fillText(`${t}`, plotX - 16, y + 3);
    }

    // Draw bars
    for (let i = 0; i < bars; i++) {
      const magnitude = maxMag > 0 ? mags[i] / maxMag : 0;
      const barHeight = Math.max(1, Math.round(magnitude * plotHeight));
      const leftRatio = i / bars;
      const rightRatio = (i + 1) / bars;
      const x0 = Math.round(plotX + leftRatio * plotWidth);
      const x1 = Math.round(plotX + rightRatio * plotWidth) - gap;
      const widthPx = Math.max(1, x1 - x0);
      const x = x0;
      const y = plotY + plotHeight - barHeight;
      spectrumCtx.fillStyle = spectrumColourTable[Math.round(magnitude * 255)];
      spectrumCtx.fillRect(x, y, widthPx, barHeight);
    }

    // Shade frequencies beyond Nyquist and draw the Nyquist line.
    if (nyquistHz > minDisplayHz && nyquistHz < maxDisplayHz) {
      const nyquistRatio = spectrumScale === 'log'
        ? Math.log(nyquistHz / minDisplayHz) / logMaxOverMin
        : (nyquistHz - minDisplayHz) / (maxDisplayHz - minDisplayHz);
      const nx = Math.round(plotX + nyquistRatio * plotWidth);

      spectrumCtx.save();
      spectrumCtx.fillStyle = 'rgba(100, 116, 139, 0.16)';
      spectrumCtx.fillRect(nx, plotY, plotX + plotWidth - nx, plotHeight);
      spectrumCtx.restore();

      spectrumCtx.save();
      spectrumCtx.strokeStyle = '#b3ff00';
      spectrumCtx.lineWidth = 2;
      spectrumCtx.setLineDash([3, 3]);
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(nx, plotY);
      spectrumCtx.lineTo(nx, plotY + plotHeight);
      spectrumCtx.stroke();
      spectrumCtx.setLineDash([]);
      spectrumCtx.restore();
    }


    // Frequency labels along the bottom.
    const majorTickHz = spectrumScale === 'log'
      ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 40000]
      : [0, 4000, 8000, 12000, 16000, 20000, 24000, 28000, 32000, 36000, 40000];
    const formatHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`);
    spectrumCtx.fillStyle = '#8aa0b6';
    for (let i = 0; i < majorTickHz.length; i++) {
      const freqHz = majorTickHz[i];
      if (freqHz < minDisplayHz || freqHz > maxDisplayHz) continue;
      const ratio = spectrumScale === 'log'
        ? Math.log(freqHz / minDisplayHz) / logMaxOverMin
        : (freqHz - minDisplayHz) / (maxDisplayHz - minDisplayHz);
      const x = Math.round(plotX + ratio * plotWidth);
      spectrumCtx.fillRect(x, plotY + plotHeight, 1, 3);
      if (i === 0) {
        spectrumCtx.textAlign = 'left';
      } else if (i === majorTickHz.length - 1 || freqHz === maxDisplayHz) {
        spectrumCtx.textAlign = 'right';
      } else {
        spectrumCtx.textAlign = 'center';
      }
      spectrumCtx.fillText(formatHz(freqHz), x, height - 10);
    }

    // Show the rough human hearing range.
    spectrumCtx.save();
    const minRatio = spectrumScale === 'log'
      ? Math.log(HEARING_MIN_HZ / minDisplayHz) / logMaxOverMin
      : (HEARING_MIN_HZ - minDisplayHz) / (maxDisplayHz - minDisplayHz);
    const maxRatio = spectrumScale === 'log'
      ? Math.log(HEARING_MAX_HZ / minDisplayHz) / logMaxOverMin
      : (HEARING_MAX_HZ - minDisplayHz) / (maxDisplayHz - minDisplayHz);
    const xMin = plotX + minRatio * plotWidth;
    const xMax = plotX + maxRatio * plotWidth;
    const y = plotY + plotHeight + 6;
    spectrumCtx.strokeStyle = '#ffb300';
    spectrumCtx.lineWidth = 3;
    spectrumCtx.setLineDash([6, 6]);
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(xMin, y);
    spectrumCtx.lineTo(xMax, y);
    spectrumCtx.stroke();
    spectrumCtx.setLineDash([]);
    spectrumCtx.restore();

    // Small legend for the guide lines.
    const legendLines = ['Nyquist', 'Human Hearing Range'];
    spectrumCtx.font = '12px sans-serif';
    spectrumCtx.textAlign = 'right';
    let legendY = plotY + 18;
    for (let i = 0; i < legendLines.length; i++) {
      let color = '#cbd5e1';
      if (legendLines[i].includes('Nyquist')) color = '#b3ff00';
      if (legendLines[i].includes('Human Hearing')) color = '#ffb300';
      spectrumCtx.fillStyle = color;
      spectrumCtx.fillText(legendLines[i], plotX + plotWidth - 2, legendY);
      legendY += 16;
    }

    spectrumCtx.textAlign = 'center';
    spectrumCtx.fillStyle = '#ffffff';
    spectrumCtx.fillText('Frequency (Hz)', plotX + plotWidth * 0.5, height - 1);
    spectrumCtx.textAlign = 'left';
  }
  // Clean the waveform and refresh the spectrum.
  function prepareWaveformForSynthesis(waveform) {
    const finiteWaveform = toFiniteWaveform(waveform);
    if (!finiteWaveform) {
      preparedWavetable = null;
      clearSpectrumCanvas();
      return;
    }

    removeDcOffset(finiteWaveform);
    preparedWavetable = finiteWaveform;
    drawSpectrumFromWaveform(preparedWavetable);
  }

  function startCustomSynthesis() {
    if (!audioContext || !masterGainNode) return;
    if (!preparedWavetable || preparedWavetable.length === 0) {
      return false;
    }

    if (activeSourceNode) {
      activeSourceNode.stop();
      activeSourceNode.disconnect();
      activeSourceNode = null;
    }

    // Tile the waveform into a long enough buffer so playback rate stays at or above 1,
    // which prevents silence on some mobile browsers for very short loops.
    const minBufferSamples = Math.ceil(MAX_PANEL_DURATION_SECONDS * audioContext.sampleRate);
    const repeatCount = Math.max(1, Math.ceil(minBufferSamples / preparedWavetable.length));
    const tiledLength = preparedWavetable.length * repeatCount;
    const tableBuffer = audioContext.createBuffer(1, tiledLength, audioContext.sampleRate);
    const channel = tableBuffer.getChannelData(0);
    for (let i = 0; i < repeatCount; i++) {
      channel.set(preparedWavetable, i * preparedWavetable.length);
    }
    activeRepeatCount = repeatCount;

    const source = audioContext.createBufferSource();
    source.buffer = tableBuffer;
    source.loop = true;

    const desiredLoopFrequencyHz = 1 / panelDurationSeconds;
    const baseTableFrequency = audioContext.sampleRate / tiledLength;
    const playbackRate = desiredLoopFrequencyHz / baseTableFrequency;
    source.playbackRate.setValueAtTime(playbackRate, audioContext.currentTime);

    source.connect(masterGainNode);

    // Schedule the gain ramp a few milliseconds ahead to guarantee smooth fade-in
    // and avoid clicks if the audio clock has already moved past 'now'.
    const now = audioContext.currentTime;
    const startAt = now + 0.005; // 5 ms scheduling lookahead
    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(0, now);
    masterGainNode.gain.linearRampToValueAtTime(0.9, startAt + ATTACK_SECONDS);

    source.start(startAt);
    source.onended = () => {
      source.disconnect();
      if (activeSourceNode === source) {
        activeSourceNode = null;
      }
    };

    activeSourceNode = source;
    return true;
  }
  // Fade out the sound to avoid clicks.
  function stopCustomSynthesis() {
    if (!audioContext || !masterGainNode) return;
    if (!activeSourceNode) return;

    const source = activeSourceNode;
    activeSourceNode = null;
    const now = audioContext.currentTime;

    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
    masterGainNode.gain.exponentialRampToValueAtTime(0.00001, now + RELEASE_SECONDS);

    // Stop the source only after the release has fully faded — stopping it
    // immediately would cut the audio abruptly before the gain reaches zero.
    source.stop(now + RELEASE_SECONDS);
  }
}
