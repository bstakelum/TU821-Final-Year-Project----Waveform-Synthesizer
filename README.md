Web app: https://bstakelum.github.io/Waveform-Synthesizer/

# Waveform Synthesizer

This project is a browser-based learning tool for basic signal analysis and wavetable synthesis.
It lets a user capture a waveform from a camera image, turn that trace into audio, and inspect the result as both a waveform and an FFT spectrum.

It was built as part of the TU821 Honours Degree in Electrical and Electronic Engineering at Technological University Dublin.

## What the App Does

- Starts the device camera in the browser.
- Lets the user position and resize a region of interest directly on the live preview.
- Supports drag-to-move ROI control on desktop and one-finger move plus two-finger resize on touch devices.
- Captures one frame, cleans it into a binary waveform mask, and extracts a single-cycle waveform.
- Draws the recovered waveform on screen.
- Plays the waveform as a looping wavetable.
- Shows an FFT-based frequency spectrum.
- Lets the user generate built-in signals.
- Lets the user export the prepared waveform as a CSV file.
- On mobile, splits the interface into two views — Camera Mode and Analysis Mode — to reduce scrolling.

## Main Idea

The app treats the extracted waveform as one repeating cycle.
That cycle is used in two ways:

1. It is drawn in the waveform panel so the user can inspect the shape.
2. It is looped as a wavetable so the user can hear it.

The spectrum panel then shows the frequency content of that repeating waveform using an FFT.

## User Flow

1. Start the camera.
2. Drag and resize the ROI so it covers the waveform you want to capture.
3. Capture a frame.
4. View the recovered waveform in the analysis panel.
5. Play the synthesized sound.
6. Change the waveform period to hear the pitch change.
7. Inspect frequency content in the spectrum. Switch between linear and log view if needed.
8. Download waveform to .CSV file if external testing is required.

The signal generator panel can be used instead of the camera when checking the audio and spectrum features.

On mobile, the interface is split into two modes.
The Camera Mode contains the camera and signal generator.
The Analysis mode contains the waveform, playback controls, and spectrum.
Capturing a frame, generating a signal, or pressing the `Analysis Mode` button switches to the Analysis view.
The `Camera Mode` button in the Analysis view returns to the Camera view, and if the camera was already running its preview overlay resumes without reopening the stream.

## Project Files

- [index.html](index.html): page structure and controls.
- [style.css](style.css): layout and visual styling.
- [app.js](app.js): main app flow and UI wiring.
- [cameraController.js](cameraController.js): camera start/stop, ROI controls, and frame capture.
- [imageProcessing.js](imageProcessing.js): image cleanup and component scoring before waveform extraction.
- [waveformExtractor.js](waveformExtractor.js): direct per-column waveform extraction, smoothing and centering.
- [audioEngine.js](audioEngine.js): wavetable playback, CSV export, and FFT spectrum drawing.

## How the Processing Pipeline Works

### 1. Camera Capture

The app captures a single video frame from the selected camera.
The ROI overlay is used to limit the part of the image that the user wants to use.

### 2. Image Cleanup

The captured frame is processed to make the waveform line easier to separate from the background.
This stage includes:

- grayscale conversion
- light denoising
- illumination flattening
- contrast stretching
- short horizontal gap closing
- connected-component scoring that prefers wide, thin, continuous, non-border-hugging waveform shapes
- binary mask

The ROI limits restricts what parts of the image are exposed to the image processing pipeline.

### 3. Waveform Extraction

The extractor reads each ROI column of the processed binary image, finds the median foreground `y` position in that column, lightly smooths the resulting path with a median filter and centers the final waveform around zero.

### 4. Wavetable Playback

The final waveform is stored as a single-cycle wavetable.
When playback starts, the waveform is looped continuously.
The waveform period control changes how long one full cycle takes, which changes the pitch.

### 5. Waveform Export

The prepared waveform can be downloaded as a CSV file containing one sample per line.
This allows external validation in tools such as MATLAB, where the waveform can be played back with `sound()`, analysed with `fft()`, or compared against a reference signal.

### 6. Spectrum Display

The spectrum is calculated with a custom radix-2 FFT implementation.
When needed, the waveform is resampled to a radix-2 length before the FFT is run.
The display then maps FFT bins into the visible bars using either linear or logarithmic frequency spacing.
The Nyquist line is shown as a guide to the highest frequency a sampled signal can represent accurately.

## Controls

### Camera Controls

- `Start Camera`: starts or stops the video stream
- `Capture Waveform`: captures the current frame for processing
- `Reset ROI`: resets the ROI to the full frame
- `Front/Back`: switches between available cameras
- `Analysis Mode` : mobile-only button that returns to the analysis view
- `ROI Overlay` : On desktop, grab overlay to resize and move ROI. On touch devices, pinch to resize ROI and drag to move box.

### Waveform Controls

- `Play`: starts or stops the synthesized waveform
- `Waveform Period (ms)`: changes the playback period of one waveform cycle
- `Download Waveform (.csv)`: exports the prepared waveform data
- `Camera Mode`: mobile-only button that returns to the camera view

### Spectrum Controls

- `Scale`: switches between linear and logarithmic frequency spacing

### Signal Generator Controls

- `Waveform`: chooses the generated waveform shape
- `Cycles`: sets how many cycles appear across the sample window
- `Generate Signal`: loads the generated waveform into the app

## Notes for Testing

- A clean, high-contrast waveform image that fills the camera frame will give the best extraction result.
- The ROI should be kept as tight as possible around the waveform of interest.
- Using ROI and moving slightly closer usually improves trace continuity when the waveform line is thin in the frame.
- The signal generator panel is useful for checking playback and spectrum behavior without using the camera.
- The spectrum is normalized for display, so it is best used for comparing shapes and peaks visually rather than reading absolute magnitudes.

## Tuning Areas

These files contain the main tuning values if you want to adjust behavior later:

- [imageProcessing.js](imageProcessing.js): lighting flattening, contrast and component scoring
- [waveformExtractor.js](waveformExtractor.js): column sampling and smoothing
- [audioEngine.js](audioEngine.js): playback period limits, spectrum bar count, and display frequency range

## Running the Project

This is a plain browser project with ES modules.
Open it through a local web server or static hosting so the module imports and camera access work correctly.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
