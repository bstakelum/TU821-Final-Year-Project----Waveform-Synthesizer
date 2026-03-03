// Audio engine:
// - will set up browser audio and play/stop button behavior
// - will receive waveform data and prepare it for sound playback
// This will build and return the audio controller used by the app.
export function createSynthAudioEngine({
  playButton,
  statusEl,
}) {
  const WAVETABLE_LENGTH = 2048;
  const BASE_FREQUENCY_HZ = 220;
  const ATTACK_SECONDS = 0.01;
  const RELEASE_SECONDS = 0.04;

  let audioContext = null;
  let masterGainNode = null;
  let latestAudioWaveform = null;
  let preparedWavetable = null;
  let activeSourceNode = null;
  let isActive = false;

  // This will convert incoming waveform values into a clean numeric array.
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

  // This will remove DC offset so the waveform will be centered around zero.
  // Relative amplitude differences between waveforms will stay intact.
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

  // This will resize any waveform to a fixed-length wavetable.
  // Missing in-between points will be estimated with straight-line interpolation.
  function resampleToFixedLength(waveform, targetLength) {
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

  // This will update the small audio status message in the UI.
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // This will create browser audio objects the first time audio is needed.
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

  // This will prepare a captured waveform so playback can use it safely.
  function prepareWaveformForSynthesis(waveform) {
    const finiteWaveform = toFiniteWaveform(waveform);
    if (!finiteWaveform) {
      preparedWavetable = null;
      return;
    }

    removeDcOffset(finiteWaveform);
    preparedWavetable = resampleToFixedLength(finiteWaveform, WAVETABLE_LENGTH);
  }

  // This will start playback by looping one wavetable buffer repeatedly.
  // More periods inside the same table will be heard as a higher pitch.
  async function startCustomSynthesis() {
    if (!audioContext || !masterGainNode) return;
    if (!preparedWavetable || preparedWavetable.length === 0) {
      setStatus('Audio: no prepared wavetable');
      return;
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

    const baseTableFrequency = audioContext.sampleRate / preparedWavetable.length;
    const playbackRate = BASE_FREQUENCY_HZ / baseTableFrequency;
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
  }

  // This will stop playback with a short volume fade to avoid clicks.
  async function stopCustomSynthesis() {
    if (!audioContext || !masterGainNode) return;
    if (!activeSourceNode) return;

    const source = activeSourceNode;
    const now = audioContext.currentTime;

    masterGainNode.gain.cancelScheduledValues(now);
    masterGainNode.gain.setValueAtTime(masterGainNode.gain.value, now);
    masterGainNode.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);

    source.stop(now + RELEASE_SECONDS + 0.005);
  }

  // This will accept waveform data from extraction and refresh readiness state.
  function updateWaveform(waveform) {
    latestAudioWaveform = waveform || null;
    prepareWaveformForSynthesis(latestAudioWaveform);

    if (!latestAudioWaveform) {
      setStatus('Audio: no waveform loaded');
      return;
    }

    if (!isActive) {
      setStatus('Audio: waveform ready');
    }
  }

  // This will turn audio on and start synthesis playback behavior.
  async function startAudio() {
    ensureAudioEngine();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    await startCustomSynthesis();

    isActive = true;
    if (playButton) playButton.textContent = 'Stop';
    setStatus('Audio: context active');
  }

  // This will pause audio and return the UI to idle state.
  async function stopAudio() {
    if (!audioContext) return;

    await stopCustomSynthesis();

    if (audioContext.state === 'running') {
      await audioContext.suspend();
    }

    isActive = false;
    if (playButton) playButton.textContent = 'Play';
    setStatus('Audio: idle');
  }

  // This will toggle between audio on and audio off.
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
        setStatus('Audio: failed to start');
      });
    });
  }

  return {
    updateWaveform,
    setStatus,
  };
}
