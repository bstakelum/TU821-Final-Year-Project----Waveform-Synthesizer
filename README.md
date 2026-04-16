Web app: https://bstakelum.github.io/Waveform-Synthesizer/

# Waveform Synthesizer

This project is a browser-based learning tool for basic signal analysis and wavetable synthesis.
It lets a user capture a waveform from a camera image, turn that trace into audio, and view the result as a waveform and FFT spectrum.

It was built as part of the TU821 Honours Degree in Electrical and Electronic Engineering at Technological University Dublin.

## What the App Does

- Starts the device camera in the browser.
- Lets the user position and resize a region of interest directly on the live preview.
- Captures one frame and cleans the image.
- Extracts the waveform trace from the processed image.
- Draws the recovered waveform on screen.
- Plays the waveform as a looping wavetable.
- Shows an FFT-based frequency spectrum.
- Lets the user generate built-in test signals.
- Lets the user export the prepared waveform as a CSV file.
- On mobile, separates capture controls from analysis to reduce scrolling.

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
4. Let the app clean the image and extract the waveform.
5. View the recovered waveform in the analysis panel.
6. Play the synthesized sound.
7. Change the panel period to hear the pitch change.
8. Switch the spectrum between linear and log view if needed.

The test signal panel can be used instead of the camera when checking the audio and spectrum features.

On mobile, a successful capture or test-signal generation switches into an analysis view.
That view contains the waveform, playback controls, and spectrum.
The `Back to Controls` button returns to the camera and test-signal controls.

## Project Files

- [index.html](index.html): page structure and controls.
- [style.css](style.css): layout and visual styling.
- [app.js](app.js): main app flow and UI wiring.
- [cameraController.js](cameraController.js): camera start/stop, ROI controls, and frame capture.
- [imageProcessing.js](imageProcessing.js): image cleanup before waveform extraction.
- [waveformExtractor.js](waveformExtractor.js): trace detection, trimming, gap filling, and centering.
- [audioEngine.js](audioEngine.js): wavetable playback, CSV export, and FFT spectrum drawing.

## How the Processing Pipeline Works

### 1. Camera Capture

The app captures a single video frame from the selected camera.
The ROI overlay is used to limit the part of the image that matters.
The preview is cropped to the chosen display aspect ratio before capture so the ROI matches what the user sees on screen.

### 2. Image Cleanup

The captured frame is processed to make the waveform line easier to separate from the background.
This stage includes:

- grayscale conversion
- light denoising
- adaptive uneven-lighting reduction
- contrast stretching
- hysteresis thresholding
- connected-component filtering with a waveform-shaped preference
- small-noise removal
- retaining the strongest waveform-like region

### 3. Waveform Extraction

The extractor follows the waveform line from left to right.
It uses a center-of-mass style estimate on the processed binary mask, trims weak edges, fills short gaps, and centers the final waveform around zero.
The ROI limits where the trace is searched for, but final waveform scaling still uses the full captured frame width/height.

### 4. Wavetable Playback

The final waveform is stored as a single-cycle wavetable.
When playback starts, the waveform is looped continuously.
The panel period control changes how long one full cycle takes, which changes the pitch.

### 5. Spectrum Display

The spectrum is calculated with a custom FFT.
When needed, the waveform is periodically resampled to a radix-2 analysis length before the FFT is run.
The display then maps FFT bins into the visible bars using either linear or logarithmic frequency spacing.
The Nyquist line is shown as a guide to the highest frequency a sampled waveform can represent without aliasing.

This was chosen because:

- it keeps the implementation simple
- it matches the waveform shown on screen
- it works even when audio is not currently playing
- it is easier to explain as an educational tool

The spectrum is intended as a learning aid, not a precision measurement instrument. 

## Controls

### Camera Controls

- `Start Camera`: starts or stops the video stream
- `Capture Frame`: captures the current frame for processing
- `Reset ROI`: resets the ROI to the full frame
- `Front/Back`: switches between available cameras
- ROI overlay: drag inside the box to move it, or drag edges and corners to resize it
- Capture status: shows whether capture succeeded or failed

### Waveform Controls

- `Play`: starts or stops the synthesized waveform
- `Panel Period (ms)`: changes the playback period of one waveform cycle
- `Download Waveform (.csv)`: exports the prepared waveform data
- `Back to Controls`: mobile-only button that returns from analysis view to the camera and test-signal controls

### Spectrum Controls

- `Scale`: switches between linear and logarithmic frequency spacing

### Test Signal Controls

- `Waveform`: chooses the test waveform shape
- `Periods`: sets how many cycles appear across the sample window
- `Generate Test Signal`: loads the test waveform into the app

## Notes for Testing

- A clean, high-contrast waveform image will give the best extraction result.
- The ROI should be kept as tight as possible around the waveform of interest.
- On mobile, moving slightly closer usually improves trace continuity when the waveform line is thin in the frame.
- The test signal panel is useful for checking playback and spectrum behavior without using the camera.
- The spectrum is normalized for display, so it is best used for comparing shapes and peaks visually rather than reading absolute magnitudes.

## Tuning Areas

These files contain the main tuning values if you want to adjust behavior later:

- [imageProcessing.js](imageProcessing.js): lighting flattening, contrast, thresholding, and noise cleanup values
- [waveformExtractor.js](waveformExtractor.js): path tracking, trimming, and gap filling values
- [audioEngine.js](audioEngine.js): playback period limits, spectrum bar count, and display frequency range

## Running the Project

This is a plain browser project with ES modules.
Open it through a local web server or static hosting so the module imports and camera access work correctly.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
