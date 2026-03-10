// Audio engine:
// - runs wavetable playback with play/stop controls and gain envelope
// - prepares extracted waveforms for synthesis (DC removal + optional upsampling)
// - renders a Goertzel-based spectrum with dense peak-frequency estimation
// Build and return the audio controller used by the app.
export function createSynthAudioEngine({
  playButton,
  spectrumCanvas,
}) {
  const MAX_INTERPOLATED_SAMPLES = 1920;
  // Default loop period for one complete wavetable cycle (user-adjustable from UI).
  const DEFAULT_PANEL_DURATION_SECONDS = 0.01;
  const MIN_PANEL_DURATION_SECONDS = 0.001;
  const MAX_PANEL_DURATION_SECONDS = 0.2;
  const ATTACK_SECONDS = 0.01;
  const RELEASE_SECONDS = 0.04;
  const SPECTRUM_BAR_COUNT = 100;
  const SPECTRUM_MIN_HZ = 20;
  const SPECTRUM_MAX_HZ = 20000;
  const DEFAULT_SPECTRUM_SCALE = 'linear';
  const PEAK_ESTIMATE_COARSE_STEPS = 512;
  const PEAK_ESTIMATE_REFINE_STEPS = 64;

  let audioContext = null;
  let masterGainNode = null;
  let preparedWavetable = null;
  let activeSourceNode = null;
  let isActive = false;
  let spectrumScale = DEFAULT_SPECTRUM_SCALE;
  let panelDurationSeconds = DEFAULT_PANEL_DURATION_SECONDS;

  const spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;

  // Main process flow API.
  function updateWaveform(waveform) {
    prepareWaveformForSynthesis(waveform || null);

    if (!preparedWavetable || preparedWavetable.length === 0) {
      return;
    }
  }

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

  // This will turn audio on and start synthesis playback behavior.
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
  };

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

  function resampleToLength(waveform, targetLength) {
    if (!waveform || waveform.length <= 0 || targetLength <= 0) {
      return null;
    }

    const out = new Float32Array(targetLength);

    if (waveform.length === 1) {
      out.fill(waveform[0]);
      return out;
    }

    for (let i = 0; i < targetLength; i++) {
      const position = (i / targetLength) * waveform.length;
      const indexA = Math.floor(position);
      const indexB = (indexA + 1) % waveform.length;
      const frac = position - indexA;

      const a = waveform[indexA];
      const b = waveform[indexB];
      out[i] = a + (b - a) * frac;
    }

    return out;
  }

  function getTargetWavetableLength(sourceLength) {
    if (!Number.isFinite(sourceLength) || sourceLength <= 0) return 0;

    // Keep high-resolution captures unchanged; only upsample smaller waveforms.
    if (sourceLength >= MAX_INTERPOLATED_SAMPLES) {
      return sourceLength;
    }

    const multiplier = Math.max(1, Math.floor(MAX_INTERPOLATED_SAMPLES / sourceLength));
    return sourceLength * multiplier;
  }

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

  function buildHannWindow(length) {
    const out = new Float32Array(length);
    if (length <= 1) {
      out.fill(1);
      return out;
    }
    for (let i = 0; i < length; i++) {
      out[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
    }
    return out;
  }

  function goertzelMagnitude(signal, window, frequencyHz, sampleRateHz) {
    const n = signal.length;
    const omega = (2 * Math.PI * frequencyHz) / sampleRateHz;
    const coeff = 2 * Math.cos(omega);
    let sPrev = 0;
    let sPrev2 = 0;

    for (let i = 0; i < n; i++) {
      const sample = signal[i] * window[i];
      const s = sample + coeff * sPrev - sPrev2;
      sPrev2 = sPrev;
      sPrev = s;
    }

    const power = sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2;
    return Math.sqrt(Math.max(0, power)) / n;
  }

  function estimateDominantFrequency(signal, window, sampleRateHz, minHz, maxHz) {
    if (!signal || signal.length < 4 || maxHz <= minHz) {
      return minHz;
    }

    const coarseSteps = PEAK_ESTIMATE_COARSE_STEPS;
    const coarseSpan = maxHz - minHz;
    const coarseStepHz = coarseSpan / coarseSteps;

    let bestHz = minHz;
    let bestMag = -1;

    for (let i = 0; i <= coarseSteps; i++) {
      const hz = minHz + i * coarseStepHz;
      const mag = goertzelMagnitude(signal, window, hz, sampleRateHz);
      if (mag > bestMag) {
        bestMag = mag;
        bestHz = hz;
      }
    }

    const refineMin = Math.max(minHz, bestHz - coarseStepHz);
    const refineMax = Math.min(maxHz, bestHz + coarseStepHz);
    if (refineMax <= refineMin) return bestHz;

    const refineSteps = PEAK_ESTIMATE_REFINE_STEPS;
    const refineStepHz = (refineMax - refineMin) / refineSteps;

    let refinedHz = bestHz;
    let refinedMag = bestMag;

    for (let i = 0; i <= refineSteps; i++) {
      const hz = refineMin + i * refineStepHz;
      const mag = goertzelMagnitude(signal, window, hz, sampleRateHz);
      if (mag > refinedMag) {
        refinedMag = mag;
        refinedHz = hz;
      }
    }

    return refinedHz;
  }

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

    const virtualSampleRate = waveform.length / panelDurationSeconds;
    const nyquistHz = 0.5 * virtualSampleRate;
    const minDisplayHz = Math.max(1, SPECTRUM_MIN_HZ);
    const maxDisplayHz = Math.min(SPECTRUM_MAX_HZ, nyquistHz);
    if (maxDisplayHz <= minDisplayHz) {
      clearSpectrumCanvas();
      return;
    }

    const window = buildHannWindow(waveform.length);
    const bars = SPECTRUM_BAR_COUNT;
    const gap = 1;

    const mags = new Float32Array(bars);
    let maxMag = 0;

    for (let i = 0; i < bars; i++) {
      const centerRatio = (i + 0.5) / bars;
      const centerHz = getFrequencyAtRatio(centerRatio, minDisplayHz, maxDisplayHz, spectrumScale);
      const magnitude = goertzelMagnitude(waveform, window, centerHz, virtualSampleRate);
      mags[i] = magnitude;
      if (magnitude > maxMag) maxMag = magnitude;
    }

    const peakHz = estimateDominantFrequency(
      waveform,
      window,
      virtualSampleRate,
      minDisplayHz,
      maxDisplayHz,
    );

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

    const majorTickHz = spectrumScale === 'log'
      ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
      : [0, 4000, 8000, 12000, 16000, 20000];
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

    const peakLabel = peakHz >= 1000
      ? `Peak ${ (peakHz / 1000).toFixed(2) } kHz`
      : `Peak ${ Math.round(peakHz) } Hz`;
    spectrumCtx.fillStyle = '#cbd5e1';
    spectrumCtx.textAlign = 'right';
    spectrumCtx.fillText(peakLabel, width - 6, 10);

    spectrumCtx.textAlign = 'center';
    spectrumCtx.fillText('Frequency (Hz)', plotX + plotWidth * 0.5, height - 1);
    spectrumCtx.textAlign = 'left';
  }

  function prepareWaveformForSynthesis(waveform) {
    const finiteWaveform = toFiniteWaveform(waveform);
    if (!finiteWaveform) {
      preparedWavetable = null;
      clearSpectrumCanvas();
      return;
    }

    removeDcOffset(finiteWaveform);
    const targetLength = getTargetWavetableLength(finiteWaveform.length);
    preparedWavetable = targetLength === finiteWaveform.length
      ? finiteWaveform
      : resampleToLength(finiteWaveform, targetLength);
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
