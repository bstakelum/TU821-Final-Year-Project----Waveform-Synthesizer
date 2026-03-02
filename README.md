Web app: https://bstakelum.github.io/Waveform-Synthesizer/

# TU821 Final Year Project — Waveform Synthesizer

This is a browser app that lets you capture a waveform from camera input and turn it into audio-ready data.
It was built as part of the TU821 Honours Degree in Electrical and Electronic Engineering at Technological University Dublin.

## Project Files

- index.html: Page layout and UI structure.
- style.css: App styling for layout and panels.
- app.js: Main app flow that connects all modules.
- cameraController.js: Camera start/stop, ROI sliders, and overlay drawing.
- imageProcessing.js: Image cleanup steps that make the waveform line easier to detect.
- waveformExtractor.js: Waveform line detection, trimming, and post-processing.
- audioEngine.js: Audio setup and play/stop behavior.

## How the Pipeline Works

1. Start the camera and set the ROI using the sliders.
2. Capture a clean frame from the video.
3. Clean the image so the waveform trace is easier to separate from background noise.
4. Detect the waveform path from the processed image.
5. Trim weak/noisy parts at the start and end of the path.
6. Fill short gaps, center the waveform, and draw it to the waveform panel.
7. Send the waveform data to the audio module.

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

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
