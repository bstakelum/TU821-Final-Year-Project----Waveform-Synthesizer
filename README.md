Web app: https://bstakelum.github.io/Waveform-Synthesizer/

# TU821 Final Year Project — Waveform Synthesizer

This browser app captures a waveform trace from camera input and turns it into a playable wavetable.
It was built as part of the TU821 Honours Degree in Electrical and Electronic Engineering at Technological University Dublin.

## Current Features

- Camera capture with front/back toggle and ROI selection.
- Image preprocessing pipeline with processed-frame preview.
- Waveform extraction with confidence-based trimming and gap filling.
- Test signal generator (sine/cosine, configurable periods).
- Wavetable playback with adjustable panel period (ms).
- Frequency spectrum view with linear/log scale and dominant-frequency label.

## Project Files

- index.html: Page layout and UI structure.
- style.css: App styling for layout and panels.
- app.js: Main app flow that connects all modules.
- cameraController.js: Camera start/stop, ROI sliders, and overlay drawing.
- imageProcessing.js: Image cleanup steps that make the waveform line easier to detect.
- waveformExtractor.js: Waveform line detection, trimming, and post-processing.
- audioEngine.js: Wavetable synthesis and spectrum rendering.

## How the Pipeline Works

1. Start the camera and set the ROI using the sliders.
2. Capture a clean frame from the video.
3. Clean the image so the waveform trace is easier to separate from background noise.
4. Detect the waveform path from the processed image.
5. Trim weak/noisy parts at the start and end of the path.
6. Fill short gaps, center the waveform, and draw it to the waveform panel.
7. Send the waveform data to the audio module.

## Audio Synthesis

The audio module plays the waveform as a looping wavetable tone.
The loop period is user-adjustable via the Panel Period (ms) input in the waveform panel.

- Non-numeric waveform points are sanitized.
- DC offset is removed before playback.
- Lower-resolution waveforms are optionally upsampled to an integer multiple, capped by `MAX_INTERPOLATED_SAMPLES`.
- The wavetable loops continuously, and playback rate is adjusted to match the selected panel period.

### What You Should Hear

- More periods (oscillations) packed into the same captured sample space will sound higher in pitch.
- Fewer periods in that same space will sound lower in pitch.
- Changing Panel Period (ms) changes the base loop frequency.

## Spectrum Notes

- Spectrum magnitudes are computed with Goertzel bins.
- The displayed peak frequency uses a denser search pass, so it is not limited to bar centers.
- Linear and log modes change visual spacing, not the underlying waveform data.

## Tuning Guide

### Image Processing (imageProcessing.js)

- flattenKernelRadius: how large the local background estimate is.
- flattenBias: brightness offset after lighting flattening.
- contrastLowPercentile / contrastHighPercentile: contrast stretch range.
- ADAPTIVE_THRESHOLD_PERCENTILE: threshold strength for black/white mask creation.
- minIsolatedNeighborCount: how aggressively tiny noise dots are removed.
- erodeMinForegroundCount: how strongly thin mask areas are cleaned.

### Waveform Extraction (waveformExtractor.js)

- DEFAULT_FOREGROUND_CUTOFF: minimum brightness treated as foreground.
- CENTER_OF_MASS_CONFIG.bandHalfWidth: vertical search range around the predicted path.
- CENTER_OF_MASS_CONFIG.maxJumpPx: maximum allowed vertical jump between columns.
- TRIM_CONFIDENCE_CONFIG: settings for trace start/end trimming.
- WAVEFORM_POSTPROCESSING_CONFIG.interpolationMaxGap: largest missing gap that will be filled.

### Audio (audioEngine.js)

- MAX_INTERPOLATED_SAMPLES: cap used when choosing integer-multiple upsampling.
- MIN_PANEL_DURATION_SECONDS / MAX_PANEL_DURATION_SECONDS: panel period bounds.
- SPECTRUM_BAR_COUNT: number of visual bars.
- PEAK_ESTIMATE_COARSE_STEPS / PEAK_ESTIMATE_REFINE_STEPS: dominant-frequency search density.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
