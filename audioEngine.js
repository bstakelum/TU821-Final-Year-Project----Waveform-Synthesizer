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
  const MAX_PANEL_DURATION_SECONDS = 0.015; // 15 ms
  const ATTACK_SECONDS = 0.005;
  const RELEASE_SECONDS = 0.005;
  const SPECTRUM_BAR_COUNT = 100;
  const SPECTRUM_MIN_HZ = 20;
  const SPECTRUM_MAX_HZ = 40000;
  const DEFAULT_SPECTRUM_SCALE = 'linear';

  let audioContext = null;
  let masterGainNode = null;
  let preparedWavetable = null;
  let activeSourceNode = null;
  let isActive = false;
  let spectrumScale = DEFAULT_SPECTRUM_SCALE;
  let panelDurationSeconds = DEFAULT_PANEL_DURATION_SECONDS;

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
      const desiredLoopFrequencyHz = 1 / panelDurationSeconds;
      const baseTableFrequency = audioContext.sampleRate / preparedWavetable.length;
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

    if (audioContext.state === 'running') {
      await audioContext.suspend();
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

  function getFrequencyAtRatio(ratio, minHz, maxHz, mode) {
    if (mode === 'log') {
      return minHz * Math.pow(maxHz / minHz, ratio);
    }
    return minHz + (maxHz - minHz) * ratio;
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

    for (let i = 0; i < signal.length; i++) {
      real[i] = signal[i];
    }

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

    for (let size = 2; size <= fftSize; size <<= 1) {
      const halfSize = size >> 1;
      const tableStep = (-2 * Math.PI) / size;

      for (let start = 0; start < fftSize; start += size) {
        for (let offset = 0; offset < halfSize; offset++) {
          const evenIndex = start + offset;
          const oddIndex = evenIndex + halfSize;
          const angle = tableStep * offset;
          const twiddleReal = Math.cos(angle);
          const twiddleImag = Math.sin(angle);
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
      magnitudes[i] = Math.hypot(real[i], imag[i]) / signal.length;
    }

    return {
      fftSize,
      magnitudes,
    };
  }

  function buildSpectrumBarsFromFft(magnitudes, sampleRateHz, minHz, maxHz, bars, scale) {
    const out = new Float32Array(bars);
    const nyquistHz = 0.5 * sampleRateHz;
    const fftSize = (magnitudes.length - 1) * 2;
    const binWidthHz = sampleRateHz / fftSize;

    for (let i = 0; i < bars; i++) {
      const centerHz = getFrequencyAtRatio((i + 0.5) / bars, minHz, maxHz, scale);

      if (centerHz <= 0 || centerHz > nyquistHz) {
        out[i] = 0;
        continue;
      }

      const binIndex = Math.min(
        magnitudes.length - 1,
        Math.max(0, Math.round(centerHz / binWidthHz)),
      );
      out[i] = magnitudes[binIndex];
    }

    return out;
  }

  // Draw the spectrum by sampling the FFT at the middle of each display bar.
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

    const virtualSampleRate = waveform.length / panelDurationSeconds;
    const nyquistHz = 0.5 * virtualSampleRate;

    const bars = SPECTRUM_BAR_COUNT;
    const gap = 1;
    const fft = computeFftMagnitudes(waveform);
    const mags = buildSpectrumBarsFromFft(
      fft.magnitudes,
      virtualSampleRate,
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

    const yTicks = [0, 0.5, 1.0];
    for (let i = 0; i < yTicks.length; i++) {
      const t = yTicks[i];
      const y = plotY + plotHeight - t * plotHeight;
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
      const r = Math.round(40 + 210 * magnitude);
      const g = Math.round(100 + 120 * (1 - magnitude));
      const b = Math.round(255 - 170 * magnitude);
      spectrumCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      spectrumCtx.fillRect(x, y, widthPx, barHeight);
    }

    // Draw vertical Nyquist line
    if (nyquistHz > minDisplayHz && nyquistHz < maxDisplayHz) {
      const nyquistRatio = spectrumScale === 'log'
        ? Math.log(nyquistHz / minDisplayHz) / Math.log(maxDisplayHz / minDisplayHz)
        : (nyquistHz - minDisplayHz) / (maxDisplayHz - minDisplayHz);
      const nx = Math.round(plotX + nyquistRatio * plotWidth);
      spectrumCtx.save();
      spectrumCtx.strokeStyle = '#00e0ff';
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
        ? Math.log(freqHz / minDisplayHz) / Math.log(maxDisplayHz / minDisplayHz)
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
    const hearingMinHz = 20;
    const hearingMaxHz = 20000;
    const minRatio = spectrumScale === 'log'
      ? Math.log(hearingMinHz / minDisplayHz) / Math.log(maxDisplayHz / minDisplayHz)
      : (hearingMinHz - minDisplayHz) / (maxDisplayHz - minDisplayHz);
    const maxRatio = spectrumScale === 'log'
      ? Math.log(hearingMaxHz / minDisplayHz) / Math.log(maxDisplayHz / minDisplayHz)
      : (hearingMaxHz - minDisplayHz) / (maxDisplayHz - minDisplayHz);
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
      if (legendLines[i].includes('Nyquist')) color = '#00e0ff';
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

    const tableBuffer = audioContext.createBuffer(1, preparedWavetable.length, audioContext.sampleRate);
    tableBuffer.copyToChannel(preparedWavetable, 0, 0);

    const source = audioContext.createBufferSource();
    source.buffer = tableBuffer;
    source.loop = true;

    const desiredLoopFrequencyHz = 1 / panelDurationSeconds;
    const baseTableFrequency = audioContext.sampleRate / preparedWavetable.length;
    const playbackRate = desiredLoopFrequencyHz / baseTableFrequency;
    source.playbackRate.setValueAtTime(playbackRate, audioContext.currentTime);

    source.connect(masterGainNode);

    const now = audioContext.currentTime;
    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(0, now);
    masterGainNode.gain.linearRampToValueAtTime(0.9, now + ATTACK_SECONDS);

    source.start(now);
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
    const now = audioContext.currentTime;

    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
    masterGainNode.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);

    source.stop(now + RELEASE_SECONDS + 0.005);
  }
}
