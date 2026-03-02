// Audio engine:
// - handles browser audio setup and play/stop button behavior
// - receives waveform data and prepares it for sound playback
// Build and return the audio controller used by the app.
export function createSynthAudioEngine({
  playButton,
  statusEl,
}) {
  let audioContext = null;
  let masterGainNode = null;
  let latestAudioWaveform = null;
  let isActive = false;

  // Show audio state text in the UI.
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // Create browser audio objects the first time they are needed.
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

  // Play a short beep so users can hear that audio is active.
  function playConfirmationBeep() {
    if (!audioContext) return;

    const oscillator = audioContext.createOscillator();
    const beepGainNode = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);

    beepGainNode.gain.setValueAtTime(0.0001, now);
    beepGainNode.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    beepGainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);

    oscillator.connect(beepGainNode);
    beepGainNode.connect(audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.17);
    oscillator.onended = () => {
      oscillator.disconnect();
      beepGainNode.disconnect();
    };
  }

  // Prepare new waveform data for synthesis playback.
  function prepareWaveformForSynthesis() {
  }

  // Start custom synthesis playback (placeholder hook).
  async function startCustomSynthesis() {
  }

  // Stop custom synthesis playback (placeholder hook).
  async function stopCustomSynthesis() {
  }

  // Accept waveform data from extraction and update ready state.
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

  // Turn audio on and start playback behavior.
  async function startAudio() {
    ensureAudioEngine();

    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }

    playConfirmationBeep();
    await startCustomSynthesis();

    isActive = true;
    if (playButton) playButton.textContent = 'Stop';
    setStatus('Audio: context active (synthesis logic removed)');
  }

  // Pause audio and return UI to idle state.
  async function stopAudio() {
    if (!audioContext) return;

    if (audioContext.state === 'running') {
      await audioContext.suspend();
    }

    await stopCustomSynthesis();

    isActive = false;
    if (playButton) playButton.textContent = 'Play';
    setStatus('Audio: idle');
  }

  // Toggle between audio on and audio off.
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
