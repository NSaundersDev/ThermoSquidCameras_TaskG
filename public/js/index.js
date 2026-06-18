import { Config } from './config.js';
// WebSockets
let frontCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, 8081));
let backCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, 8082));
let imageWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, 3000) + '/ws');
let temperatureWs = null;
const activeMoves = new Map();
let reconnectAttempts = { front: 0, back: 0 }; // Camera-specific
const maxReconnectAttempts = 5;
const reconnectDelay = 2000;
const lastCapturedImages = { front: null, back: null };
let isPaused = { front: false, back: false };
let invalidFrameCounts = { front: 0, back: 0 };
const maxInvalidFrames = 5;
// Recording State
const recordingState = { front: false, back: false };
const recordedFrames = { front: [], back: [] };
const maxRecordDuration = 30000; // 30s max
const recordFps = 10; // 10fps for clips
const recordInterval = 1000 / recordFps; // 100ms
let lastRecordTime = { front: 0, back: 0 };
// Timer states
const stopwatchState = {
  front: { elapsed: 0, isRunning: false, direction: null, interval: null },
  back: { elapsed: 0, isRunning: false, direction: null, interval: null },
  both: { elapsed: 0, isRunning: false, direction: null, interval: null }
};
const autoTimerState = {
  front: { remaining: 0, isRunning: false, direction: null, interval: null },
  back: { remaining: 0, isRunning: false, direction: null, interval: null },
  both: { remaining: 0, isRunning: false, direction: null, interval: null }
};
// UI elements
const frontVideoStream = document.getElementById('front-video-stream');
const backVideoStream = document.getElementById('back-video-stream');
const frontCanvas = document.getElementById('front-canvas');
const backCanvas = document.getElementById('back-canvas');
const frontCtx = frontCanvas?.getContext('2d');
const backCtx = backCanvas?.getContext('2d');
const frontTimestampCheckbox = document.getElementById('front-timestamp');
const backTimestampCheckbox = document.getElementById('back-timestamp');
const customFileNameInputFront = document.getElementById('custom-file-name-front');
const customFileNameInputBack = document.getElementById('custom-file-name-back');
const toggleFrontStreamButton = document.getElementById('toggle-front-stream');
const toggleBackStreamButton = document.getElementById('toggle-back-stream');
const captureFrontImageButton = document.getElementById('capture-front-image');
const captureBackImageButton = document.getElementById('capture-back-image');
const recordFrontButton = document.getElementById('record-front-video');
const recordBackButton = document.getElementById('record-back-video');
const statusMessage = document.getElementById('status-message');
const settingsFrontButton = document.getElementById('settings-front');
const settingsBackButton = document.getElementById('settings-back');
const frontSettingsMenu = document.getElementById('front-settings-menu');
const backSettingsMenu = document.getElementById('back-settings-menu');
const frontResolutionSelect = document.getElementById('front-resolution');
const frontFramerateSelect = document.getElementById('front-framerate');
const backResolutionSelect = document.getElementById('back-resolution');
const backFramerateSelect = document.getElementById('back-framerate');
const applyFrontSettings = document.getElementById('apply-front-settings');
const applyBackSettings = document.getElementById('apply-back-settings');
// Camera config
const cameraConfig = {
  front: { resolution: '1536x864', framerate: 30 },
  back: { resolution: '1536x864', framerate: 30 }
};
// Modal elements
const modal = document.getElementById('camera-modal');
const modalVideoStream = document.getElementById('modal-video-stream');
const modalCanvas = document.getElementById('modal-canvas');
const modalCtx = modalCanvas?.getContext('2d');
const modalTimestampCheckbox = document.getElementById('modal-timestamp');
const modalFilenameInput = document.getElementById('modal-filename');
const modalCaptureBtn = document.getElementById('modal-capture-btn');
const modalToggleBtn = document.getElementById('modal-toggle-btn');
const modalRecordBtn = document.getElementById('modal-record-btn');
const closeModalBtn = document.getElementById('close-modal-btn');
// Modal state
let currentModalCamera = null;
let modalIsPaused = false;
let modalTimestampEnabled = true;
// Temperature UI elements
const temperatureElements = {
  container: null,
  value: null,
  unitToggle: null,
  status: null
};
// Temperature config
const TEMPERATURE_CONFIG = {
  CHECK_INTERVAL: 15000, // Check every 15 seconds
  WS_PORT: 8083,
  SHOW_FAHRENHEIT: false, // Default to Celsius
  ALERT_TEMPS: {
    WARNING: 70, // 70°C warning
    CRITICAL: 80 // 80°C critical
  }
};
// Temperature Alert Configuration
const TEMPERATURE_ALERT_CONFIG = {
  THRESHOLD_CELSIUS: 70, // Pop up if >= 70°C (configurable)
  SHOW_FAHRENHEIT: false, // Match your widget's default
  DISMISSIBLE: true, // Allow manual close
  NOTIFY_BROWSER: true // Request browser notification permission
};
// Alert state
let isAlertVisible = false;
let alertModal = null;

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0.0';
  const wholeSeconds = Math.floor(seconds);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${wholeSeconds}.${tenths}`;
}
function debounce(fn, ms) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), ms);
  };
}
// Status messages - only show helpful ones
function showStatusMessage(message, duration = 1500) {
  if (!statusMessage) return;
 
  statusMessage.textContent = message;
  statusMessage.classList.remove('fade-out');
  statusMessage.classList.add('fade-in');
  statusMessage.style.display = 'block';
 
  if (statusMessage.dataset.timeoutId) {
    clearTimeout(statusMessage.dataset.timeoutId);
  }
 
  const timeoutId = setTimeout(() => {
    statusMessage.classList.remove('fade-in');
    statusMessage.classList.add('fade-out');
    setTimeout(() => {
      statusMessage.textContent = '';
      statusMessage.style.display = 'none';
      statusMessage.classList.remove('fade-out');
    }, 300);
  }, duration);
 
  statusMessage.dataset.timeoutId = timeoutId;
}

// Fixed timestamp drawing with proper image scaling
function drawTimestamp(imageElement, canvas, ctx, door, timestamp, timestampCheckbox) {
  if (!timestampCheckbox?.checked || !canvas || !ctx || !imageElement.complete) {
    if (canvas) canvas.style.display = 'none';
    imageElement.style.display = 'block';
    return;
  }
  // Set canvas to the image's natural dimensions (full resolution)
  const imgWidth = imageElement.naturalWidth || 1080;
  const imgHeight = imageElement.naturalHeight || 720;
  canvas.width = imgWidth;
  canvas.height = imgHeight;
 
  // Get the container for positioning the canvas overlay
  const container = canvas.parentElement;
  const containerRect = container.getBoundingClientRect();
 
  // Clear canvas and draw the full-resolution image
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imageElement, 0, 0, imgWidth, imgHeight);
  // Add timestamp overlay at full resolution
  ctx.font = 'bold 35px Arial';
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;

  const text = `${new Date(timestamp).toLocaleString()}`;
  ctx.strokeText(text, 10, 40);
  ctx.fillText(text, 10, 40);
 
  // Position the canvas to match the image's display in the container
  // This ensures the overlay lines up perfectly with the image
  const containerWidth = containerRect.width;
  const containerHeight = containerRect.height;
  const containerAspect = containerWidth / containerHeight;
  const imgAspect = imgWidth / imgHeight;
 
  let scaleX, scaleY, offsetX, offsetY;
 
  if (imgAspect > containerAspect) {
    // Image is wider - scale to height
    scaleY = containerHeight / imgHeight;
    scaleX = scaleY;
    offsetX = (containerWidth - (imgWidth * scaleX)) / 2;
    offsetY = 0;
  } else {
    // Image is taller - scale to width
    scaleX = containerWidth / imgWidth;
    scaleY = scaleX;
    offsetX = 0;
    offsetY = (containerHeight - (imgHeight * scaleY)) / 2;
  }
 
  // Apply the transform: scale first, then translate (order matters for correct positioning)
  canvas.style.transform = `scale(${scaleX}) translate(${offsetX}px, ${offsetY}px)`;
  canvas.style.transformOrigin = 'top left';
 
  canvas.style.display = 'block';
  imageElement.style.display = 'none';
}
// Enhanced image capture with Promise handling
function getTimestampedImage(imageElement, door, timestamp, timestampCheckbox) {
  console.log('getTimestampedImage called:', {
    door,
    timestamp: new Date(timestamp).toLocaleString(),
    timestampEnabled: timestampCheckbox?.checked,
    imageComplete: imageElement.complete,
    naturalWidth: imageElement.naturalWidth,
    naturalHeight: imageElement.naturalHeight,
    currentSrc: imageElement.currentSrc ? imageElement.currentSrc.substring(0, 50) + '...' : 'no src'
  });
  // Create canvas with fallback dimensions
  const canvas = document.createElement('canvas');
  const imgWidth = imageElement.naturalWidth || 1080;
  const imgHeight = imageElement.naturalHeight || 720;
 
  canvas.width = imgWidth;
  canvas.height = imgHeight;
  const ctx = canvas.getContext('2d');
 
  console.log(`Canvas created: ${canvas.width}x${canvas.height}`);
 
  // Wait for image to be fully loaded if needed
  return new Promise((resolve) => {
    if (imageElement.complete && imageElement.naturalWidth > 0) {
      // Image is ready, draw immediately
      drawImageToCanvas(ctx, imageElement, canvas, door, timestamp, timestampCheckbox, resolve);
    } else {
      // Image not ready, wait for load
      console.log('Image not ready, waiting for load...');
      const imgLoadHandler = () => {
        imageElement.removeEventListener('load', imgLoadHandler);
        drawImageToCanvas(ctx, imageElement, canvas, door, timestamp, timestampCheckbox, resolve);
      };
      imageElement.addEventListener('load', imgLoadHandler);
     
      // Fallback timeout in case load never fires
      setTimeout(() => {
        if (!imageElement.complete) {
          console.warn('Image load timeout, using fallback');
          // Draw a placeholder or use the current src if available
          ctx.fillStyle = '#f0f0f0';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#999';
          ctx.font = '30px Arial';
          ctx.textAlign = 'center';
          ctx.fillText('No Image', canvas.width / 2, canvas.height / 2);
          if (timestampCheckbox?.checked) {
            addTimestampOverlay(ctx, door, timestamp);
          }
          resolve(canvas.toDataURL('image/jpeg', 0.5)); // Improved fallback quality
        }
      }, 1000);
    }
  });
}
function drawImageToCanvas(ctx, imageElement, canvas, door, timestamp, timestampCheckbox, resolve) {
  try {
    console.log('Drawing image to canvas...');
   
    // Clear canvas first
    ctx.clearRect(0, 0, canvas.width, canvas.height);
   
    // Draw the image at its natural size - no scaling needed here
    // The canvas is already sized to match the image's natural dimensions
    ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
    console.log('Image drawn to canvas at natural size');
   
    // Add timestamp overlay if enabled
    if (timestampCheckbox?.checked) {
      console.log('Adding timestamp overlay');
      addTimestampOverlay(ctx, door, timestamp);
    }
   
    // Convert to data URL and resolve
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    console.log('Canvas converted to data URL, length:', dataUrl.length);
   
    // Verify it's a valid data URL
    if (!dataUrl.startsWith('data:image')) {
      console.error('Invalid data URL generated:', dataUrl.substring(0, 50));
    }
   
    resolve(dataUrl);
   
  } catch (error) {
    console.error('Error drawing to canvas:', error);
    resolve(canvas.toDataURL('image/jpeg', 0.5)); // Improved fallback
  }
}
function addTimestampOverlay(ctx, door, timestamp) {
  ctx.font = 'bold 35px Arial';
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  const text = `${door.charAt(0).toUpperCase() + door.slice(1)}: ${new Date(timestamp).toLocaleString()}`;
  ctx.strokeText(text, 10, 40);
  ctx.fillText(text, 10, 40);
}
function showCaptureFeedback(path = '') {
  const filename = path ? path.split('/').pop() : 'image.jpg';
  showStatusMessage(`Captured: ${filename}`, 2000);
 
  // Determine which camera to flash based on filename
  let camera = 'front';
  if (filename.toLowerCase().includes('back')) {
    camera = 'back';
  }
 
  console.log(`Showing feedback for ${camera} camera`);
 
  // Flash the CORRECT camera feed
  const cameraVideoContainer = camera === 'front' ?
    document.querySelector('.front-camera-section .video-container') :
    document.querySelector('.back-camera-section .video-container');
 
  if (cameraVideoContainer) {
    console.log(`Flashing ${camera} camera feed:`, cameraVideoContainer);
   
    // Remove any existing flash class
    cameraVideoContainer.classList.remove('camera-flash');
   
    // Force reflow to restart animation
    cameraVideoContainer.offsetHeight;
   
    // Add flash class to trigger animation
    cameraVideoContainer.classList.add('camera-flash');
   
    // Remove after animation completes
    setTimeout(() => {
      cameraVideoContainer.classList.remove('camera-flash');
      console.log(`${camera} flash completed`);
    }, 600);
  } else {
    console.warn(`Could not find video container for ${camera} camera`);
  }
 
  console.log(`Image saved: ${filename}`);
}
// Temperature utility functions
function formatTemperature(temp, showFahrenheit) {
  if (!temp || !temp.isValid) return '--';
 
  const value = showFahrenheit ? temp.fahrenheit : temp.celsius;
  const unit = showFahrenheit ? '°F' : '°C';
  const color = getTemperatureColor(temp.celsius, showFahrenheit ? temp.fahrenheit : temp.celsius);
 
  return { value: value.toFixed(1), unit, color };
}
function getTemperatureColor(celsius, fahrenheit) {
  const temp = celsius || (fahrenheit * 5/9 - 32); // Convert if needed
  if (temp >= TEMPERATURE_CONFIG.ALERT_TEMPS.CRITICAL) return 'critical';
  if (temp >= TEMPERATURE_CONFIG.ALERT_TEMPS.WARNING) return 'warning';
  return 'normal';
}
function updateTemperatureDisplay(data) {
  if (!temperatureElements.container) return;
 
  const formatted = formatTemperature(data, TEMPERATURE_CONFIG.SHOW_FAHRENHEIT);
 
  if (temperatureElements.value) {
    temperatureElements.value.textContent = formatted.value;
    temperatureElements.value.className = `temp-value ${formatted.color}`;
  }
 
  if (temperatureElements.status) {
    temperatureElements.status.className = `temp-status ${data.isValid ? 'ok' : 'error'}`;
    temperatureElements.status.textContent = data.isValid ? 'OK' : 'Error'; // Add text for clarity
  }
 
  // Update container styling
  const container = temperatureElements.container;
  const colorClass = getTemperatureColor(data.celsius, data.fahrenheit);
  container.className = `temperature-widget ${colorClass}`;
 
  // Check for alert condition
  const threshold = TEMPERATURE_ALERT_CONFIG.THRESHOLD_CELSIUS;
  const currentTemp = TEMPERATURE_ALERT_CONFIG.SHOW_FAHRENHEIT ? data.fahrenheit : data.celsius;
  const thresholdInF = (threshold * 9/5) + 32;
  const effectiveThreshold = TEMPERATURE_ALERT_CONFIG.SHOW_FAHRENHEIT ? thresholdInF : threshold;
 
  if (data.isValid && currentTemp >= effectiveThreshold && !isAlertVisible) {
    showTemperatureAlert(data);
  }
}
// WebSocket connections
function connectCameraWebSocket(camera, ws, videoStream, canvas, ctx, timestampCheckbox, captureButton, toggleButton) {
  let lastUpdate = 0;
  let framesReceived = 0;
  let connectionTime = Date.now();
  const minFrameInterval = 132; // ~30 FPS
  ws.binaryType = 'arraybuffer';
  // Enable capture button after connection (even without frames)
 ws.onopen = () => {
  console.log(`${camera} camera connected`);
  framesReceived = 0;
  invalidFrameCounts[camera] = 0;
  reconnectAttempts[camera] = 0;
  isPaused[camera] = false;

  // Enable record button immediately on successful connection
  const recordBtn = camera === 'front' ? recordFrontButton : recordBackButton;
  if (recordBtn) {
    recordBtn.disabled = false;
    recordBtn.classList.remove('disabled');
  }

  // Also enable capture button
  if (captureButton) {
    captureButton.disabled = false;
    captureButton.classList.remove('disabled');
  }

  // Re-apply any pending camera config
  if (window.pendingCameraConfig && window.pendingCameraConfig[camera]) {
    ws.send(JSON.stringify(window.pendingCameraConfig[camera]));
    delete window.pendingCameraConfig[camera];
  }

  showStatusMessage(`${camera} camera ready`, 800);
};
  ws.onmessage = (event) => {
    try {
      const now = Date.now();
      if (now - lastUpdate < minFrameInterval || isPaused[camera]) return;
      lastUpdate = now;
      // Handle both string and binary messages
      if (typeof event.data === 'string') {
        console.debug(`${camera}: text message received`);
        return;
      }
      const blob = new Blob([event.data], { type: 'image/jpeg' });
     
      // Relaxed size check - accept smaller frames
      if (blob.size < 100) {
        console.debug(`${camera}: frame too small (${blob.size} bytes)`);
        return;
      }
      framesReceived++;
      invalidFrameCounts[camera] = 0;
      const url = URL.createObjectURL(blob);
      videoStream.src = url;
     
      videoStream.onload = () => {
        // Update last captured image
        lastCapturedImages[camera] = {
          door: camera,
          image: url,
          timestamp: now,
          frames: framesReceived
        };
       
        // Draw timestamp overlay if enabled
        if (canvas && ctx && timestampCheckbox?.checked) {
          drawTimestamp(videoStream, canvas, ctx, camera, now, timestampCheckbox);
        } else {
          videoStream.style.display = 'block';
          if (canvas) canvas.style.display = 'none';
        }
       
        // Clean up previous URL
        if (videoStream.dataset.lastUrl && videoStream.dataset.lastUrl !== url) {
          URL.revokeObjectURL(videoStream.dataset.lastUrl);
        }
        videoStream.dataset.lastUrl = url;
       
        // Ensure capture button stays enabled
        if (captureButton) {
          captureButton.disabled = false;
          captureButton.classList.remove('disabled');
        }
      };
     
      videoStream.onerror = (error) => {
        console.warn(`${camera}: image load failed`, error);
        invalidFrameCounts[camera]++;
      //  URL.revokeObjectURL(url);
       
        // // Only disable after multiple failures
        // if (invalidFrameCounts[camera] > 10) {
        //   if (captureButton) {
        //     captureButton.disabled = true;
        //     captureButton.classList.add('disabled');
        //   }
        //   showStatusMessage(`${camera} feed unstable`, 2000);
        // }
      };
      // console.log('Frame received, size:', blob.size);
      if (recordingState[camera]) {
        if (now - lastRecordTime[camera] > recordInterval) {
          lastRecordTime[camera] = now;
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = reader.result.replace(/^data:.+;base64,/, '');
            recordedFrames[camera].push(base64);
            console.log('Pushing frame, current length: ' + recordedFrames[camera].length);
          };
          reader.onerror = () => console.error('FileReader error for', camera);
          reader.readAsDataURL(blob);
        }
      }
    } catch (err) {
      console.warn(`${camera}: frame processing error`, err);
      invalidFrameCounts[camera]++;
    }
  };
  ws.onclose = (event) => {
    console.log(`${camera} camera disconnected (code: ${event.code})`);
   
    // Update status
    const statusElement = document.getElementById(`${camera}-status`);
    if (statusElement) {
      statusElement.textContent = 'Disconnected';
      statusElement.style.background = '#f8d7da';
      statusElement.style.borderColor = '#f5c6cb';
      statusElement.style.color = '#721c24';
    }
   
    videoStream.src = '';
    videoStream.style.display = 'none';
   
    if (canvas) canvas.style.display = 'none';
    if (videoStream.dataset.lastUrl) {
      URL.revokeObjectURL(videoStream.dataset.lastUrl);
      delete videoStream.dataset.lastUrl;
    }
   
    // Disable capture button
    // if (captureButton) {
    //   captureButton.disabled = true;
    //   captureButton.classList.add('disabled');
    // }
   
    // Start reconnection
    if (reconnectAttempts[camera] < maxReconnectAttempts) {
      const delay = reconnectDelay * Math.pow(1.5, reconnectAttempts[camera]);
      setTimeout(() => {
        reconnectAttempts[camera]++;
        console.log(`Reconnecting ${camera} camera (attempt ${reconnectAttempts[camera]})`);
        if (camera === 'front') {
          frontCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, 8081));
          connectCameraWebSocket('front', frontCameraWs, frontVideoStream, frontCanvas, frontCtx, frontTimestampCheckbox, captureFrontImageButton, toggleFrontStreamButton);
        } else {
          backCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, 8082));
          connectCameraWebSocket('back', backCameraWs, backVideoStream, backCanvas, backCtx, backTimestampCheckbox, captureBackImageButton, toggleBackStreamButton);
        }
      }, delay);
    } else {
      showStatusMessage(`${camera} camera offline`, 3000);
    }
  };
  ws.onerror = (error) => {
    console.warn(`${camera} camera connection error`);
   
    // Update status
    const statusElement = document.getElementById(`${camera}-status`);
    if (statusElement) {
      statusElement.textContent = 'Error';
      statusElement.style.background = '#fff3cd';
      statusElement.style.borderColor = '#ffeaa7';
      statusElement.style.color = '#856404';
    }
   
    if (captureButton) {
      captureButton.disabled = true;
      captureButton.classList.add('disabled');
    }
  };
}

function connectImageWebSocket() {
  imageWs.onopen = () => {
    console.log('Image service connected');
  };
  imageWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.action === 'image_saved') {
        showCaptureFeedback(data.path);
      }
    } catch (e) {
      console.debug('Image message ignored');
    }
  };
  imageWs.onclose = () => {
    console.log('Image service disconnected');
    // Auto-reconnect image service
    setTimeout(() => {
      imageWs = new WebSocket(Config.getSocketUrl(window.location.hostname, 3000) + '/ws');
      connectImageWebSocket();
    }, 2000);
  };
  imageWs.onerror = (error) => {
    console.warn('Image service error');
  };
}
// Temperature WebSocket connection
function connectTemperatureWebSocket() {
  if (temperatureWs && temperatureWs.readyState === WebSocket.OPEN) return;
 
  temperatureWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV2, TEMPERATURE_CONFIG.WS_PORT) + '/ws');
 
  temperatureWs.onopen = () => {
    console.log('Temperature WebSocket connected');
    if (temperatureElements.status) {
      temperatureElements.status.textContent = 'Connected';
      temperatureElements.status.className = 'temp-status ok';
    }
    showStatusMessage('Temperature monitoring started', 1500);
   
    // Request initial temperature
    if (temperatureWs.readyState === WebSocket.OPEN) {
      temperatureWs.send(JSON.stringify({
        type: 'request_temperature'
      }));
    }
  };
  temperatureWs.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
     
      if (message.type === 'temperature' || message.type === 'temperature_update') {
        updateTemperatureDisplay(message.data);
       
        // Store latest temperature
        window.latestTemperature = message.data;
      }
     
      console.debug('Temperature message:', message);
    } catch (error) {
      console.warn('Invalid temperature message:', error.message);
    }
  };
  temperatureWs.onclose = (event) => {
    console.log('Temperature WebSocket disconnected:', event.code);
    if (temperatureElements.status) {
      temperatureElements.status.textContent = 'Disconnected';
      temperatureElements.status.className = 'temp-status error';
    }
   
    // Auto-reconnect after delay
    setTimeout(() => {
      connectTemperatureWebSocket();
    }, 3000);
  };
  temperatureWs.onerror = (error) => {
    console.error('Temperature WebSocket error:', error);
    if (temperatureElements.status) {
      temperatureElements.status.textContent = 'Connection error';
      temperatureElements.status.className = 'temp-status error';
    }
  };
}
// Initialize temperature widget
function initializeTemperatureWidget() {
  // Create temperature widget HTML
  const widgetHtml = `
    <div class="temperature-widget" id="temperature-widget">
      <div class="temp-header">
        <span class="temp-icon">🌡️</span>
        <span class="temp-title">Pi Temp</span>
        <button class="temp-toggle" id="temp-unit-toggle" title="Toggle °C/°F" aria-label="Toggle temperature unit">
          <span class="toggle-unit">°C</span>
        </button>
      </div>
      <span class="temp-display" style="display:inline;white-space:nowrap;">
        <span class="temp-value">--</span>
      </span>
      <div class="temp-status"></div>
    </div>
  `;
 
  // Add styles (unchanged, but ensure .temp-status is visible)
  const style = document.createElement('style');
  style.textContent = `
    .temperature-widget {
      white-space: nowrap;
      position: fixed;
      top: 10px;
      right: 10px;
      width: 110px;
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 12px;
      padding: 0 6px 0 6px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
      z-index: 1500;
      font-family: 'Segoe UI', 'Roboto', sans-serif;
      transition: all 0.3s ease;
      font-size: 10px;
    }
   
    .temperature-widget.normal {
      border-left: 4px solid #0052a9ff;
    }
   
    .temperature-widget.warning {
      border-left: 4px solid #ffc107;
      background: rgba(255, 193, 7, 0.1);
    }
   
    .temperature-widget.critical {
      border-left: 4px solid #dc3545;
      background: rgba(220, 53, 69, 0.1);
      animation: pulse 2s infinite;
    }
   
    @keyframes pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }
   
    .temp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
   
    .temp-icon {
      font-size: 14px;
      margin-right: 4px;
    }
   
    .temp-title {
      font-weight: 600;
      font-size: 11px;
      color: #333;
    }
   
    .temp-toggle {
      background: none;
      border: 1px solid #ddd;
      border-radius: 50%;
      width: 20px;
      height: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      transition: all 0.2s ease;
    }
   
    .temp-toggle:hover {
      background: #f0f0f0;
      border-color: #999;
    }
   
    .temp-display {
      text-align: center;
      margin: 6px 0;
    }
   
    .temp-value {
      display: block;
      font-size: 24px;
      font-weight: 700;
      font-family: 'Roboto Mono', monospace;
      line-height: 1;
      margin-bottom: 2px;
      min-height: 28px;
    }
   
    .temp-value.normal { color: #008cffff; }
    .temp-value.warning { color: #ffc107; }
    .temp-value.critical { color: #dc3545; }
    .temp-value.error { color: #6c757d; }
   
    .temp-unit {
      font-size: 12px;
      color: #666;
      font-weight: 500;
    }
   
    .temp-status {
      font-size: 10px;
      text-align: center;
      min-height: 14px;
      margin-top: 4px;
      color: #666;
    }
   
    .temp-status.ok { color: #0067f7ff; }
    .temp-status.error { color: #dc3545; }
   
    .temp-footer {
      text-align: right;
    }
   
    .temp-close {
      background: none;
      border: none;
      font-size: 16px;
      cursor: pointer;
      color: #999;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
   
    .temp-close:hover {
      background: #f0f0f0;
      color: #333;
    }
   
    /* Responsive adjustments */
    @media (max-width: 768px) {
      .temperature-widget {
        top: 5px;
        right: 5px;
        width: 100px;
        padding: 8px;
      }
     
      .temp-value {
        font-size: 20px;
      }
     
      .temp-title {
        font-size: 10px;
      }
    }
  `;
  document.head.appendChild(style);
 
  // Insert widget into DOM
  const appWrapper = document.querySelector('.app-wrapper');
  if (appWrapper) {
    appWrapper.insertAdjacentHTML('afterbegin', widgetHtml);
   
    // Initialize elements
    temperatureElements.container = document.getElementById('temperature-widget');
    temperatureElements.value = temperatureElements.container?.querySelector('.temp-value');
    temperatureElements.unitToggle = document.getElementById('temp-unit-toggle');
    temperatureElements.status = temperatureElements.container?.querySelector('.temp-status'); // Now exists
   
    // Add event listeners
    if (temperatureElements.unitToggle) {
      temperatureElements.unitToggle.addEventListener('click', () => {
        TEMPERATURE_CONFIG.SHOW_FAHRENHEIT = !TEMPERATURE_CONFIG.SHOW_FAHRENHEIT;
        const unit = TEMPERATURE_CONFIG.SHOW_FAHRENHEIT ? '°F' : '°C';
        temperatureElements.unitToggle.querySelector('.toggle-unit').textContent = unit;
       
        if (window.latestTemperature) {
          updateTemperatureDisplay(window.latestTemperature);
        }
      });
    }
   
    // Create alert modal
    createTemperatureAlertModal();
    requestNotificationPermission();
  }
}
// Create alert modal HTML (hidden by default)
function createTemperatureAlertModal() {
  const modalHtml = `
    <div id="temp-alert-modal" class="temp-alert-overlay" style="display: none;">
      <div class="temp-alert-content">
        <div class="temp-alert-header">
          <span class="temp-alert-icon">🔥</span>
          <h4 class="temp-alert-title">Temperature Alert!</h4>
          <button class="temp-alert-close" id="temp-alert-close" title="Dismiss" aria-label="Close alert">×</button>
        </div>
        <div class="temp-alert-body">
          <div class="temp-alert-display">
            <span id="temp-alert-value" class="temp-alert-value">--</span>
            <span id="temp-alert-unit" class="temp-alert-unit">°C</span>
          </div>
          <p class="temp-alert-message">
            Pi board temperature is critically high. Consider checking cooling or load.
          </p>
          <div id="temp-alert-status" class="temp-alert-status"></div>
        </div>
        <div class="temp-alert-footer">
          <button class="temp-alert-action" id="temp-alert-action" aria-label="Acknowledge alert">Monitor</button>
        </div>
      </div>
    </div>
  `;
 
  // Add styles (unchanged)
  const style = document.createElement('style');
  style.id = 'temp-alert-styles';
  style.textContent = `
    .temp-alert-overlay {
      font-size: 0.8em;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 3000;
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(5px);
      animation: fadeInAlert 0.3s ease-out;
    }
   
    @keyframes fadeInAlert {
      from { opacity: 0; transform: scale(0.9); }
      to { opacity: 1; transform: scale(1); }
    }
   
    .temp-alert-content {
      background: linear-gradient(135deg, #fff, #f8f9fa);
      border-radius: 16px;
      padding: 24px;
      max-width: 350px;
      width: 90%;
      max-height: 80vh;
      box-shadow: 0 20px 60px rgba(220, 53, 69, 0.3);
      border: 2px solid #dc3545;
      animation: slideInAlert 0.4s ease-out;
      font-family: 'Segoe UI', 'Roboto', sans-serif;
    }
   
    @keyframes slideInAlert {
      from { transform: translateY(-50px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
   
    .temp-alert-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      gap: 12px;
    }
   
    .temp-alert-icon {
      font-size: 24px;
    }
   
    .temp-alert-title {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      color: #dc3545;
      flex: 1;
    }
   
    .temp-alert-close {
      background: none;
      border: 2px solid #dc3545;
      color: #dc3545;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: bold;
      transition: all 0.2s ease;
    }
   
    .temp-alert-close:hover {
      background: #dc3545;
      color: white;
    }
   
    .temp-alert-body {
      text-align: center;
      margin-bottom: 20px;
    }
   
    .temp-alert-display {
      margin-bottom: 12px;
    }
   
    .temp-alert-value {
      display: block;
      font-size: 3rem;
      font-weight: 800;
      font-family: 'Roboto Mono', monospace;
      color: #dc3545;
      line-height: 1;
    }
   
    .temp-alert-unit {
      font-size: 1.2rem;
      color: #666;
      font-weight: 500;
    }
   
    .temp-alert-message {
      margin: 0 0 12px 0;
      font-size: 0.95rem;
      color: #333;
      line-height: 1.4;
    }
   
    .temp-alert-status {
      font-size: 0.8rem;
      color: #888;
      font-style: italic;
    }
   
    .temp-alert-footer {
      text-align: right;
    }
   
    .temp-alert-action {
      background: linear-gradient(135deg, #dc3545, #c82333);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 600;
      transition: all 0.2s ease;
    }
   
    .temp-alert-action:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(220, 53, 69, 0.3);
    }
   
    /* Responsive */
    @media (max-width: 480px) {
      .temp-alert-content {
        padding: 16px;
        margin: 20px;
      }
     
      .temp-alert-value {
        font-size: 2.5rem;
      }
    }
  `;
  document.head.appendChild(style);
 
  // Insert into DOM
  document.body.insertAdjacentHTML('beforeend', modalHtml);
 
  // Initialize elements
  alertModal = document.getElementById('temp-alert-modal');
  const closeBtn = document.getElementById('temp-alert-close');
  const actionBtn = document.getElementById('temp-alert-action');
  const valueEl = document.getElementById('temp-alert-value');
  const unitEl = document.getElementById('temp-alert-unit');
  const statusEl = document.getElementById('temp-alert-status');
 
  // Event listeners
  if (closeBtn && TEMPERATURE_ALERT_CONFIG.DISMISSIBLE) {
    closeBtn.addEventListener('click', hideTemperatureAlert);
  }
 
  if (actionBtn) {
    actionBtn.addEventListener('click', () => {
      hideTemperatureAlert();
      // Optionally open monitoring page or log
      console.log('Temperature alert acknowledged');
    });
  }
 
  // Close on overlay click
  alertModal.addEventListener('click', (e) => {
    if (e.target === alertModal) hideTemperatureAlert();
  });
 
  // Close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isAlertVisible) {
      hideTemperatureAlert();
    }
  });
}
// Show alert with current data
function showTemperatureAlert(data) {
  if (!alertModal || isAlertVisible) return;
 
  const formatted = formatTemperature(data, TEMPERATURE_ALERT_CONFIG.SHOW_FAHRENHEIT);
  const valueEl = document.getElementById('temp-alert-value');
  const unitEl = document.getElementById('temp-alert-unit');
  const statusEl = document.getElementById('temp-alert-status');
 
  if (valueEl) valueEl.textContent = formatted.value;
  if (unitEl) unitEl.textContent = formatted.unit;
  if (statusEl) {
    statusEl.textContent = `Alert at: ${new Date(data.timestamp).toLocaleTimeString()}`;
  }
 
  // Trigger browser notification if enabled and permitted
  if (TEMPERATURE_ALERT_CONFIG.NOTIFY_BROWSER && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification('Pi Temperature Alert!', {
        body: `Temperature reached ${formatted.value} ${formatted.unit}!`,
        icon: '/img/thermoSquidLogo.png', // Use your logo
        tag: 'pi-temp-alert'
      });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          showTemperatureAlert(data); // Retry
        }
      });
    }
  }
 
  alertModal.style.display = 'flex';
  isAlertVisible = true;
  document.body.style.overflow = 'hidden'; // Prevent scroll
 
  // Auto-hide after 10 seconds (optional)
  setTimeout(hideTemperatureAlert, 10000);
}
// Hide alert
function hideTemperatureAlert() {
  if (!isAlertVisible) return;
 
  alertModal.style.display = 'none';
  isAlertVisible = false;
  document.body.style.overflow = ''; // Restore scroll
}
// Request notification permission on load (optional)
function requestNotificationPermission() {
  if (TEMPERATURE_ALERT_CONFIG.NOTIFY_BROWSER && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
// Camera modal functionality
function openCameraModal(camera) {
  currentModalCamera = camera;
  modalIsPaused = false;
  modalTimestampEnabled = true;
 
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('modal-camera-title').textContent = `${camera.charAt(0).toUpperCase() + camera.slice(1)} Camera`;
   
    // Set up modal timestamp checkbox (only if it exists)
    if (modalTimestampCheckbox) {
      modalTimestampCheckbox.checked = true;
      // Remove existing listeners to prevent duplicates
      modalTimestampCheckbox.replaceWith(modalTimestampCheckbox.cloneNode(true));
      const newCheckbox = document.getElementById('modal-timestamp');
      newCheckbox.addEventListener('change', (e) => {
        modalTimestampEnabled = e.target.checked;
        if (currentModalCamera) {
          updateModalTimestampOverlay();
        }
      });
    }
  }
  // Set up modal video stream
  if (modalVideoStream && currentModalCamera) {
    const sourceStream = currentModalCamera === 'front' ? frontVideoStream : backVideoStream;
   
    // Add onload handler to modal image (for initial and future src changes)
    modalVideoStream.onload = () => {
      updateModalTimestampOverlay();
    };
   
    // Set src and style
    modalVideoStream.src = sourceStream.src;
    modalVideoStream.style.display = 'block';
   
    // Trigger initial update (in case image is already complete)
    if (modalVideoStream.complete) {
      updateModalTimestampOverlay();
    }
  }
  // Modal capture button
  if (modalCaptureBtn) {
    // Remove existing listeners
    modalCaptureBtn.replaceWith(modalCaptureBtn.cloneNode(true));
    const newCaptureBtn = document.getElementById('modal-capture-btn');
    newCaptureBtn.onclick = () => {
      if (currentModalCamera && imageWs.readyState === WebSocket.OPEN) {
        const lastImage = lastCapturedImages[currentModalCamera];
        if (lastImage && lastImage.image) {
          const customName = modalFilenameInput?.value?.trim() || '';
          const videoStream = currentModalCamera === 'front' ? frontVideoStream : backVideoStream;
         
          getTimestampedImage(videoStream, currentModalCamera, lastImage.timestamp,
            modalTimestampEnabled ? {checked: true} : {checked: false})
            .then((imageData) => {
              imageWs.send(JSON.stringify({
                action: 'save_image',
                door: currentModalCamera,
                image: imageData,
                timestamp: Date.now(),
                customName: customName
              }));
             
              // Flash feedback in modal
              const modalVideoContainer = document.querySelector('.camera-modal-video-container');
              if (modalVideoContainer) {
                modalVideoContainer.classList.add('camera-flash');
                setTimeout(() => modalVideoContainer.classList.remove('camera-flash'), 600);
              }
             
              showStatusMessage(`Captured: ${customName || 'image.jpg'}`, 2000);
            })
            .catch((error) => {
              console.error('Modal capture error:', error);
              showStatusMessage('Capture failed', 2000);
            });
        }
      }
    };
  }
  // Modal toggle button
  if (modalToggleBtn) {
    // Remove existing listeners
    modalToggleBtn.replaceWith(modalToggleBtn.cloneNode(true));
    const newToggleBtn = document.getElementById('modal-toggle-btn');
    newToggleBtn.onclick = () => {
      if (currentModalCamera) {
        modalIsPaused = !modalIsPaused;
        isPaused[currentModalCamera] = modalIsPaused; // Sync with main pause state
       
        const span = newToggleBtn.querySelector('span');
        const icon = newToggleBtn.querySelector('i');
        if (span && icon) {
          span.textContent = modalIsPaused ? 'Resume' : 'Pause';
          icon.className = modalIsPaused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
        }
      }
    };
  }
  // NEW: Modal record button
  if (modalRecordBtn) {
    // Remove existing listeners
    modalRecordBtn.replaceWith(modalRecordBtn.cloneNode(true));
    const newRecordBtn = document.getElementById('modal-record-btn');
    newRecordBtn.onclick = () => {
      if (currentModalCamera) {
        toggleRecording(currentModalCamera);
      }
    };
  }
  // Close modal handlers
  if (closeModalBtn) {
    // Remove existing listeners
    closeModalBtn.replaceWith(closeModalBtn.cloneNode(true));
    const newCloseBtn = document.getElementById('close-modal-btn');
    newCloseBtn.onclick = closeCameraModal;
  }
 
  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) closeCameraModal();
    };
  }
  // Close on Escape key
  const escapeHandler = function(e) {
    if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
      closeCameraModal();
      document.removeEventListener('keydown', escapeHandler);
    }
  };
  document.addEventListener('keydown', escapeHandler);
}
function closeCameraModal() {
  if (modal) {
    modal.style.display = 'none';
    currentModalCamera = null;
    modalIsPaused = false;
   
    // Reset modal controls
    if (modalToggleBtn) {
      const span = modalToggleBtn.querySelector('span');
      const icon = modalToggleBtn.querySelector('i');
      if (span && icon) {
        span.textContent = 'Pause';
        icon.className = 'fa-solid fa-pause';
      }
    }
   
    // Hide canvas
    if (modalCanvas) modalCanvas.style.display = 'none';
    if (modalVideoStream) modalVideoStream.style.display = 'block';
   
    // Clear filename input
    if (modalFilenameInput) modalFilenameInput.value = '';
  }
}
function updateModalTimestampOverlay() {
  if (!currentModalCamera || !modalVideoStream || !modalCanvas || !modalCtx) return;
 
  const now = Date.now();
  const timestampCheckbox = modalTimestampEnabled ? {checked: true} : {checked: false};
 
  // For modal, use a larger font size since the container is bigger
  const originalFont = modalCtx.font;
  if (modalTimestampEnabled) {
    modalCtx.font = 'bold 50px Arial'; // Larger for modal
    modalCtx.lineWidth = 3; // Thicker stroke for larger canvas
  }
 
  drawTimestamp(modalVideoStream, modalCanvas, modalCtx, currentModalCamera, now, timestampCheckbox);
 
  // Reset font for future draws
  if (modalTimestampEnabled) {
    modalCtx.font = originalFont;
  }
}
// Listen for new frames in modal
function setupModalFrameListener() {
  const originalOnLoad = frontVideoStream.onload;
  frontVideoStream.onload = function() {
    if (currentModalCamera === 'front' && modal.style.display === 'flex') {
      modalVideoStream.src = this.src; // Update modal src to new frame (will trigger modal's onload)
    }
    if (originalOnLoad) originalOnLoad.call(this);
  };
 
  const originalBackOnLoad = backVideoStream.onload;
  backVideoStream.onload = function() {
    if (currentModalCamera === 'back' && modal.style.display === 'flex') {
      modalVideoStream.src = this.src; // Update modal src to new frame (will trigger modal's onload)
    }
    if (originalBackOnLoad) originalBackOnLoad.call(this);
  };
}

function getLocalWindowsTime() {
  const now = new Date();

  const year   = now.getFullYear();
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const day    = String(now.getDate()).padStart(2, '0');
  const hours  = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
let timeWs = null;
function connectTimeServer() {
  // This is the important line - it uses whatever hostname/IP the page was loaded from
  const host = window.location.hostname;
  
  console.log(`[Time] Connecting to ws://${host}:3002`);
  
  timeWs = new WebSocket(`ws://${host}:3002`);

  timeWs.onopen = () => {
    console.log('%c[Time] ✅ Connected to time server', 'color: limegreen');
  };

  timeWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'success') {
        alert("✅ Time Sync Successful!\n\n" + data.message);
      }

      if (data.type === 'error') {
        alert("❌ Time Sync Failed:\n" + data.message);
      }
    } catch (e) {}
  };

  timeWs.onclose = () => {
    console.log('%c[Time] Disconnected from time server', 'color: red');
    // Auto-reconnect
    setTimeout(connectTimeServer, 5000);
  };

  timeWs.onerror = (err) => {
    console.error('%c[Time] WebSocket error', 'color: orange');
  };
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
connectTimeServer();
setTimeout(() => {
  if (frontCameraWs && frontCameraWs.readyState === WebSocket.OPEN && recordFrontButton) {
    recordFrontButton.disabled = false;
    recordFrontButton.classList.remove('disabled');
  }
  if (backCameraWs && backCameraWs.readyState === WebSocket.OPEN && recordBackButton) {
    recordBackButton.disabled = false;
    recordBackButton.classList.remove('disabled');
  }
}, 600);
// Sync button handler
const syncTimeBtn = document.getElementById('sync-time-btn');

if (syncTimeBtn) {
  syncTimeBtn.addEventListener('click', () => {
    if (!timeWs || timeWs.readyState !== WebSocket.OPEN) {
      if (typeof showStatusMessage === 'function') {
        showStatusMessage('Time server not connected', 2500);
      }
      return;
    }

    const localTime = getLocalWindowsTime();

    timeWs.send(JSON.stringify({
      type: 'sync-time',
      time: localTime,           // ← Send formatted local time
      password: 'Lasers4Life'
    }));

    if (typeof showStatusMessage === 'function') {
      showStatusMessage('Syncing server time...', 2000);
    }
  });
}
  // Make camera feeds clickable for modal - FIXED: Attach to .video-wrapper instead of .camera-feed
  const videoWrappers = document.querySelectorAll('.video-wrapper');
  videoWrappers.forEach(wrapper => {
    wrapper.style.cursor = 'zoom-in';
    wrapper.addEventListener('click', (e) => {
      e.preventDefault();
      const cameraSection = wrapper.closest('.camera-section');
      const camera = cameraSection.dataset.camera;
      openCameraModal(camera);
    });
   
  });
  // Listen for new frames in modal
  setupModalFrameListener();
  // Camera controls
  document.querySelectorAll('.control-btn').forEach(button => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const camera = button.dataset.camera;
      const action = button.dataset.action;
     
      if (action === 'record') {
        toggleRecording(camera);
        return;
      }
      if (action === 'capture') {
        const lastImage = lastCapturedImages[camera];
       
        // Check if we have a valid image
        if (!lastImage || !lastImage.image || lastImage.frames === 0) {
          showStatusMessage(`Wait for ${camera} image...`, 1500);
          return;
        }
       
        // Show loading state
        const originalText = button.querySelector('span').textContent;
        button.querySelector('span').textContent = 'Saving...';
        button.disabled = true;
       
        if (imageWs.readyState === WebSocket.OPEN) {
          try {
            const customName = (camera === 'front' ? customFileNameInputFront : customFileNameInputBack)?.value?.trim() || '';
            const timestampCheckbox = camera === 'front' ? frontTimestampCheckbox : backTimestampCheckbox;
            const videoStream = camera === 'front' ? frontVideoStream : backVideoStream;
           
            console.log('Starting capture process for', camera, 'timestamp enabled:', timestampCheckbox?.checked);
           
            // Get the image data (now returns a Promise)
            getTimestampedImage(videoStream, camera, lastImage.timestamp, timestampCheckbox)
              .then((imageData) => {
                console.log('Got image data, sending to server, length:', imageData.length);
               
                imageWs.send(JSON.stringify({
                  action: 'save_image',
                  door: camera,
                  image: imageData,
                  timestamp: Date.now(),
                  customName: customName
                }));
               
                console.log('Image sent to server');
               
                // Reset button
                setTimeout(() => {
                  button.querySelector('span').textContent = originalText;
                  button.disabled = false;
                }, 300);
               
              })
              .catch((error) => {
                console.error('Failed to get image data:', error);
                button.querySelector('span').textContent = originalText;
                button.disabled = false;
                showStatusMessage('Image processing failed', 2000);
              });
             
          } catch (error) {
            console.error('Capture setup error:', error);
            button.querySelector('span').textContent = originalText;
            button.disabled = false;
            showStatusMessage('Capture failed', 2000);
          }
        } else {
          button.querySelector('span').textContent = originalText;
          button.disabled = false;
          showStatusMessage('Image service busy', 1500);
        }
      } else if (action === 'toggle') {
        isPaused[camera] = !isPaused[camera];
        updateToggleButtonUI(camera);
        showStatusMessage(isPaused[camera] ? `${camera} paused` : `${camera} resumed`, 1000);
      } else if (action === 'settings') {
        toggleSettingsMenu(camera);
      }
    });
  });
  // Apply settings buttons
  applyFrontSettings.addEventListener('click', () => applyCameraSettings('front'));
  applyBackSettings.addEventListener('click', () => applyCameraSettings('back'));
  // Door controls
  document.querySelectorAll('.door-btn, .auto-btn').forEach(button => {
    const door = button.dataset.door ||
      (button.id.includes('both') ? 'both' :
       button.id.includes('front') ? 'front' : 'back');
   
    let action;
    if (button.id.includes('open')) {
      action = 'start_open';
    } else if (button.id.includes('close')) {
      action = 'start_close';
    }
   
    const isAuto = button.classList.contains('auto-btn');
   
    if (isAuto && action) {
      button.addEventListener('click', debounce((event) => {
        event.preventDefault();
      
       
        const targetDoors = door === 'both' ? ['front', 'back'] : [door];
        const isMoving = targetDoors.some(d => activeMoves.has(d));
       
        if (isMoving) {
          targetDoors.forEach(d => stopMove(d, 'auto-stop', event.clientX, event.clientY));
          showStatusMessage(`${door} stopped`, 1000);
        } else {
          let seconds;
          if (door === 'both') {
            const frontTimeId = action === 'start_open' ? 'front-open-time' : 'front-close-time';
            const backTimeId = action === 'start_open' ? 'back-open-time' : 'back-close-time';
            const frontInput = document.getElementById(frontTimeId);
            const backInput = document.getElementById(backTimeId);
            seconds = [
              parseFloat(frontInput?.value || 1.0),
              parseFloat(backInput?.value || 1.0)
            ];
          } else {
            const timeId = `${door}-${action === 'start_open' ? 'open' : 'close'}-time`;
            const timeInput = document.getElementById(timeId);
            seconds = parseFloat(timeInput?.value || 1.0);
          }
         
          startMove(door, action, 'auto-click', event.clientX, event.clientY, seconds);
          showStatusMessage(`${door} ${action.includes('open') ? 'opening' : 'closing'} for ${Array.isArray(seconds) ? seconds.join('/') : seconds}s`, 1500);
        }
      }, 100));
    } else if (action) {
      // Manual buttons
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        startMove(door, action, 'manual-hold', event.clientX, event.clientY);
      });
     
      button.addEventListener('mouseup', debounce((event) => {
        event.preventDefault();
        stopMove(door, 'manual-release', event.clientX, event.clientY);
      }, 50));
     
      button.addEventListener('mouseleave', debounce((event) => {
        event.preventDefault();
        stopMove(door, 'manual-leave', event.clientX, event.clientY);
      }, 50));
    }
  });

  // Connect WebSockets
  setTimeout(() => {
    connectImageWebSocket();
    if (frontVideoStream) {
      connectCameraWebSocket('front', frontCameraWs, frontVideoStream, frontCanvas, frontCtx, frontTimestampCheckbox, captureFrontImageButton, toggleFrontStreamButton);
    }
    if (backVideoStream) {
      connectCameraWebSocket('back', backCameraWs, backVideoStream, backCanvas, backCtx, backTimestampCheckbox, captureBackImageButton, toggleBackStreamButton);
    }
   
    // Initialize temperature widget after a short delay
    setTimeout(() => {
      initializeTemperatureWidget();
      connectTemperatureWebSocket();
    }, 1000);
  }, 100);
});
// Cleanup
window.addEventListener('beforeunload', () => {
  activeMoves.forEach((_, door) => stopMove(door, 'unload', 0, 0));
 
  // Clean up WebSocket URLs
  Object.values(lastCapturedImages).forEach(image => {
    if (image && image.image) {
      URL.revokeObjectURL(image.image);
    }
  });
 
  if (temperatureWs) {
    temperatureWs.close();
  }
});
// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Pause timers when tab is hidden
    Object.keys(stopwatchState).forEach(door => {
      if (stopwatchState[door].isRunning) {
        stopStopwatch(door);
      }
    });
    Object.keys(autoTimerState).forEach(door => {
      if (autoTimerState[door].isRunning) {
        stopAutoTimer(door);
      }
    });
  }
});

// NEW: Toggle recording function
function toggleRecording(camera) {
  if (recordingState[camera]) {
    // Stop recording
    recordingState[camera] = false;
    const frames = recordedFrames[camera];
    console.log('Stopping recording, frames length:', frames.length);
    recordedFrames[camera] = []; // Clear frames
    const customName = (camera === 'front' ? customFileNameInputFront : customFileNameInputBack)?.value?.trim() || '';
    const fpsSelect = camera === 'front' ? frontFramerateSelect : backFramerateSelect;
    const fps = parseInt(fpsSelect.value, 10) || 30;
    const resolutionSelect = camera === 'front' ? frontResolutionSelect : backResolutionSelect;
    const resolution = resolutionSelect.value;
    if (imageWs.readyState === WebSocket.OPEN && frames.length > 0) {
      imageWs.send(JSON.stringify({
        action: 'save_video',
        door: camera,
        frames: frames.map(base64 => ({ data: base64 })),
        timestamp: Date.now(),
        customName: customName,
        fps: fps,
        resolution: resolution
      }));
      showStatusMessage(`Video saved from ${camera}`, 2000);
    } else if (frames.length === 0) {
      showStatusMessage(`No frames captured for ${camera} video`, 2000);
    } else {
      showStatusMessage('Image service unavailable', 2000);
    }
  } else {
    // Start recording
    if (isPaused[camera]) {
      isPaused[camera] = false;
      updateToggleButtonUI(camera);
      showStatusMessage(`${camera} stream resumed for recording`, 1000);
    }
    recordingState[camera] = true;
    recordedFrames[camera] = [];
    lastRecordTime[camera] = 0;
    showStatusMessage(`Recording ${camera} started`, 1000);
    setTimeout(() => {
      if (recordingState[camera]) toggleRecording(camera); // Auto-stop after max duration
    }, maxRecordDuration);
  }
  updateRecordButtonUI(camera);
}

function updateRecordButtonUI(camera) {
  const recordButton = camera === 'front' ? recordFrontButton : recordBackButton;
  if (recordButton) {
    const span = recordButton.querySelector('span');
    const icon = recordButton.querySelector('i');
    if (recordingState[camera]) {
      recordButton.classList.add('recording');
      if (span) span.textContent = 'Stop';
      if (icon) icon.className = 'fa-solid fa-stop';
    } else {
      recordButton.classList.remove('recording');
      if (span) span.textContent = 'Record';
      if (icon) icon.className = 'fa-solid fa-video';
    }
  }
}

function updateToggleButtonUI(camera) {
  const toggleButton = camera === 'front' ? toggleFrontStreamButton : toggleBackStreamButton;
  if (toggleButton) {
    const span = toggleButton.querySelector('span');
    const icon = toggleButton.querySelector('i');
    if (span && icon) {
      span.textContent = isPaused[camera] ? 'Resume Stream' : 'Pause Stream';
      icon.className = isPaused[camera] ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    }
  }
}

// NEW: Toggle settings menu
function toggleSettingsMenu(camera) {
  const menu = camera === 'front' ? frontSettingsMenu : backSettingsMenu;
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function applyCameraSettings(camera) {
  const resolutionSelect = camera === 'front' ? frontResolutionSelect : backResolutionSelect;
  const framerateSelect = camera === 'front' ? frontFramerateSelect : backFramerateSelect;
  const [width, height] = resolutionSelect.value.split('x');
  const framerate = parseInt(framerateSelect.value);

  const settings = {
    action: 'set_config',
    width: parseInt(width),
    height: parseInt(height),
    framerate: framerate,
    brightness: parseFloat(document.getElementById(`${camera}-brightness`).value) || 0,
    contrast: parseFloat(document.getElementById(`${camera}-contrast`).value) || 1,
    sharpness: parseFloat(document.getElementById(`${camera}-sharpness`).value) || 1,
    saturation: parseFloat(document.getElementById(`${camera}-saturation`).value) || 1,
    ev: parseInt(document.getElementById(`${camera}-ev`).value) || 0,
    shutter: parseInt(document.getElementById(`${camera}-shutter`).value) || 0,
    gain: parseFloat(document.getElementById(`${camera}-gain`).value) || 0,
    metering: document.getElementById(`${camera}-metering`).value || 'centre',
    exposure: document.getElementById(`${camera}-exposure`).value || 'normal',
    awb: document.getElementById(`${camera}-awb`).value || 'auto',
    awb_red: parseFloat(document.getElementById(`${camera}-awb-red`).value) || 0,
    awb_blue: parseFloat(document.getElementById(`${camera}-awb-blue`).value) || 0,
    denoise: document.getElementById(`${camera}-denoise`).value || 'auto'
  };

  let timeWs = null;

function connectTimeServer() {
  const host = window.location.hostname;
  console.log(`[Time] Trying to connect to ws://${host}:3002`);


  timeWs = new WebSocket(`ws://${host}:3002`);

  timeWs.onopen = () => {
    console.log('%c[Time] ✅ Connected to time server', 'color: limegreen');
    showStatusMessage('Time server connected', 2000);
  };

  timeWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'success') {
        alert("✅ Time Sync Successful!\n\n" + data.message);
      }
      if (data.type === 'error') {
        alert("❌ Time Sync Failed:\n" + data.message);
      }
    } catch (e) {}
  };

  timeWs.onclose = () => {
    console.log('%c[Time] ❌ Disconnected from time server', 'color: red');
    showStatusMessage('Time server disconnected', 2000);
  };

  timeWs.onerror = (err) => {
    console.error('%c[Time] Connection error', 'color: orange', err);
    showStatusMessage('Time server connection failed', 3000);
  };

  // Sync button
const syncTimeBtn = document.getElementById('sync-time-btn');
if (syncTimeBtn) {
  syncTimeBtn.addEventListener('click', () => {
    if (!timeWs || timeWs.readyState !== WebSocket.OPEN) {
      alert("Time server is NOT connected.\nCheck console for errors.");
      return;
    }

    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ` +
                    `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    timeWs.send(JSON.stringify({
      type: 'sync-time',
      time: timeStr,
      password: 'Lasers4Life'
    }));

    showStatusMessage('Sending time to server...', 1500);
  });
}

  showStatusMessage(`${camera.toUpperCase()} settings applied – restarting stream...`, 3000);
}




  const cameraWs = camera === 'front' ? frontCameraWs : backCameraWs;

  // ──────────────────────────────────────────────────────────────
  // CRITICAL FIX: Send config even if connection is closing/closed
  // The server restarts rpicam-vid immediately → old socket dies
  // ──────────────────────────────────────────────────────────────
  const sendConfig = () => {
    if (cameraWs.readyState === WebSocket.OPEN) {
      cameraWs.send(JSON.stringify(settings));
    } else if (cameraWs.readyState === WebSocket.CONNECTING) {
      // Still connecting → queue it
      setTimeout(sendConfig, 100);
    }
    // If CLOSED or CLOSING → the reconnect in connectCameraWebSocket() will start the new process with the OLD config
    // → so we store it temporarily and re-apply on next open
    else {
      window.pendingCameraConfig = window.pendingCameraConfig || {};
      window.pendingCameraConfig[camera] = settings;
    }
  };
  sendConfig();
  setTimeout(() => {
  const ws = camera === 'front' ? frontCameraWs : backCameraWs;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
  // Reconnect with fresh config
  setTimeout(() => {
    if (camera === 'front') {
      frontCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV, 8081));
      connectCameraWebSocket('front', frontCameraWs, frontVideoStream, frontCanvas, frontCtx, frontTimestampCheckbox, captureFrontImageButton, toggleFrontStreamButton);
    } else {
      backCameraWs = new WebSocket(Config.getSocketUrl(Config.IPs.DEV, 8082));
      connectCameraWebSocket('back', backCameraWs, backVideoStream, backCanvas, backCtx, backTimestampCheckbox, captureBackImageButton, toggleBackStreamButton);
    }
    showStatusMessage(`${camera} camera restarted with new settings`, 2000);
  }, 500);
}, 1500);
}
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon?.('/api/camera/stop', '');
});