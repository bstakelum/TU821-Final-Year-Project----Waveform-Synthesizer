// Main app file:
// This connects camera capture, image cleanup, waveform detection, drawing, and audio playback.
import { createCameraController } from './cameraController.js';
import { createImageProcessor } from './imageProcessing.js';
import { extractWaveformFromImageData } from './waveformExtractor.js';
import { createSynthAudioEngine } from './audioEngine.js';

const waveformCanvas = document.getElementById('waveformCanvas');
const wctx = waveformCanvas.getContext('2d');

const waveformForegroundCutoff = 200;

const synthEngine = createSynthAudioEngine({
  playButton: document.getElementById('playSynth'),
  statusEl: document.getElementById('audioStatus'),
});

const imageProcessor = createImageProcessor({
  previewCanvas: document.getElementById('processedPreviewCanvas'),
});

const cameraController = createCameraController({
  video: document.getElementById('video'),
  processingCanvas: document.getElementById('processingCanvas'),
  startButton: document.getElementById('startCamera'),
  captureButton: document.getElementById('captureFrame'),
  cameraControls: document.getElementById('cameraControls'),
  cameraToggleButton: document.getElementById('cameraToggle'),
  resetROIButton: document.getElementById('resetROI'),
  roiElements: {
    topInput: document.getElementById('roiTop'),
    bottomInput: document.getElementById('roiBottom'),
    leftInput: document.getElementById('roiLeft'),
    rightInput: document.getElementById('roiRight'),
    topVal: document.getElementById('roiTopVal'),
    bottomVal: document.getElementById('roiBottomVal'),
    leftVal: document.getElementById('roiLeftVal'),
    rightVal: document.getElementById('roiRightVal'),
  },
  onVideoSize: ({ width }) => {
    waveformCanvas.width = width;
    waveformCanvas.height = 256;
  },
  onCapture: (imageData, roi) => {
    processCapturedImage(imageData, roi);
  },
});

imageProcessor.initProcessor();
cameraController.init();

// Process one captured frame and turn it into a drawable/playable waveform.
function processCapturedImage(imageData, roi) {
  const processedImageData = imageProcessor.preprocessImage(imageData);
  if (!processedImageData) {
    imageProcessor.setProcessingStatus('Preprocessing: failed');
    return;
  }

  imageProcessor.renderProcessedPreview(processedImageData);

  const waveform = extractWaveformFromImageData(processedImageData, {
    foregroundCutoff: waveformForegroundCutoff,
    roi,
  });

  if (!waveform || waveform.length === 0) {
    synthEngine.setStatus('Audio: no usable waveform');
    return;
  }

  synthEngine.updateWaveform(waveform);
  drawWaveform(waveform);
}

// Draw the extracted waveform line on the waveform canvas.
function drawWaveform(waveform) {
  wctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  wctx.strokeStyle = '#ffffff';
  wctx.lineWidth = 2;

  let isDrawing = false;

  for (let i = 0; i < waveform.length; i++) {
    const value = waveform[i];
    if (Number.isNaN(value)) {
      if (isDrawing) {
        wctx.stroke();
        isDrawing = false;
      }
      continue;
    }

    const x = (i / waveform.length) * waveformCanvas.width;
    const y = (1 - (value + 1) / 2) * waveformCanvas.height;

    if (!isDrawing) {
      wctx.beginPath();
      wctx.moveTo(x, y);
      isDrawing = true;
    } else {
      wctx.lineTo(x, y);
    }
  }

  if (isDrawing) {
    wctx.stroke();
  }
}