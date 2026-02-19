# TU821-Final-Year-Project----Waveform-Synthesizer
Browser-based waveform synthesizer. Developed in partial fulfilment of the requirements of the Honours Degree  in Electrical and Electronic Engineering (TU821) of  Technological University Dublin

## Project Notes

- `index.html`: Declares the UI structure (camera panel, ROI controls, waveform panel).
- `style.css`: Provides layout, overlay behavior, and styling.
- `app.js`: Handles camera stream control, ROI selection, waveform extraction, and canvas rendering.

## Current Process Flow

1. Start camera and define ROI using Top/Bottom/Left/Right sliders.
2. On capture, ROI pixels are read from a clean offscreen video frame (not the overlay canvas).
3. OpenCV preprocessing is applied in this order:
	- grayscale conversion
	- light denoise (`GaussianBlur`, 3x3)
	- illumination flattening (subtract blurred background)
	- local contrast enhancement (CLAHE)
	- adaptive thresholding (when `useCVthreshold = true`)
	- binary cleanup (`MORPH_OPEN` then `MORPH_CLOSE`, 3x3)
4. The processed ROI is shown in the OpenCV processed-frame preview panel.
5. Extraction scans one y-position per x-column with continuity constraints.
	- Active extractor uses brightest-pixel selection per column with continuity constraints.
	- `cvThresholdCutoff` is used as the foreground acceptance threshold.
6. Extracted waveform is analyzed for debug metrics, then post-processed:
	- interpolation across small gaps
	- zero-fill for unresolved points + DC centering
7. Final waveform is drawn in the synthesis panel and sent to Web Audio (`PeriodicWave` oscillator path).

## Notes

- ROI values are normalized percentages (`0..1`) so selection scales with camera resolution.
- OpenCV is required for the current capture pipeline; if preprocessing fails, capture is aborted and status/debug are updated.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
