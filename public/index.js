import { zipStored } from './session_pack.js';

const host = window.location.hostname;
// Picture settings are posted to the camera Pi named in each stream URL.
// Live video still plays from that mediaMTX path.
let frontCameraWs = null;
let backCameraWs = null;
let imageWs = new WebSocket(`ws://${host}:3000/ws`);
let temperatureWs = null;
const lastCapturedImages = { front: null, back: null };
let isPaused = { front: false, back: false };
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
const statusMessage = document.getElementById('status-message');
const settingsFrontButton = document.getElementById('settings-front');
const settingsBackButton = document.getElementById('settings-back');
const frontSettingsMenu = document.getElementById('front-settings-menu');
const backSettingsMenu = document.getElementById('back-settings-menu');
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
const closeModalBtn = document.getElementById('close-modal-btn');
// Modal state
let currentModalCamera = null;
let modalIsPaused = false;
let modalTimestampEnabled = false;
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

// Status messages - only show helpful ones
const captureConfirmTimers = new Map();

function fileNameFromPath(imagePath) {
  if (!imagePath) return '';
  const parts = String(imagePath).split('/');
  return parts[parts.length - 1] || '';
}

function captureFileName(door, customName, timestamp) {
  const cleaned = String(customName || '').replace(/[^a-zA-Z0-9-_]/g, '');
  return `${timestamp}-${cleaned || door}.jpg`;
}

function sendSaveImage(door, imageData, customName, fileName) {
  const timestamp = Date.now();
  const name = customName || '';
  const payload = {
    action: 'save_image',
    door,
    image: imageData,
    timestamp,
    customName: name
  };
  let shown = captureFileName(door, name, timestamp);
  if (fileName) {
    payload.fileName = fileName;
    shown = `${fileName}.jpg`;
  }
  imageWs.send(JSON.stringify(payload));
  showCaptureConfirm(door, shown, true);
}

function showCaptureConfirm(door, filename, ok, options) {
  if (door !== 'front' && door !== 'back') return;
  const flash = !options || options.flash !== false;
  const targets = [document.getElementById(`${door}-capture-confirm`)];
  if (currentModalCamera === door) targets.push(document.getElementById('modal-capture-confirm'));

  targets.forEach((el) => {
    if (!el) return;
    el.dataset.camera = door;
    el.hidden = false;
    el.classList.toggle('is-error', !ok);
    const icon = el.querySelector('i');
    if (icon) icon.className = ok ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-exclamation';
    const label = el.querySelector('.capture-confirm-label');
    if (label) label.textContent = ok ? 'Saved' : 'Capture failed';
    const name = el.querySelector('.capture-confirm-name');
    if (name) {
      name.textContent = ok ? filename : '';
      name.hidden = !ok || !filename;
      name.title = ok ? filename : '';
    }
    const frame = el.closest('.video-container, .camera-modal-video-container');
    if (frame && ok && flash) {
      frame.classList.remove('is-flash');
      void frame.offsetWidth;
      frame.classList.add('is-flash');
      setTimeout(() => frame.classList.remove('is-flash'), 500);
    }
  });

  clearTimeout(captureConfirmTimers.get(door));
  captureConfirmTimers.set(door, setTimeout(() => {
    const panel = document.getElementById(`${door}-capture-confirm`);
    if (panel) panel.hidden = true;
    const modalConfirm = document.getElementById('modal-capture-confirm');
    if (modalConfirm && modalConfirm.dataset.camera === door) modalConfirm.hidden = true;
  }, 4500));
}

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

function mediaBox(element) {
  if (!element) return { width: 0, height: 0, ready: false };
  if (element.tagName === 'VIDEO') {
    const width = element.videoWidth || 0;
    const height = element.videoHeight || 0;
    return { width, height, ready: element.readyState >= 2 && width > 0 && height > 0 };
  }
  const width = element.naturalWidth || 0;
  const height = element.naturalHeight || 0;
  return { width, height, ready: Boolean(element.complete && width > 0 && height > 0) };
}

function drawTimestamp(imageElement, canvas, ctx, door, timestamp, timestampCheckbox) {
  const box = mediaBox(imageElement);
  // Keep a playing <video> in the layout. display:none can stall WebRTC decoding.
  if (!timestampCheckbox?.checked || !canvas || !ctx || !box.ready) {
    if (canvas) canvas.style.display = 'none';
    if (imageElement && imageElement.tagName !== 'VIDEO') imageElement.style.display = 'block';
    return;
  }

  const imgWidth = box.width;
  const imgHeight = box.height;
  canvas.width = imgWidth;
  canvas.height = imgHeight;

  // Clear canvas and draw the full-resolution image
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imageElement, 0, 0, imgWidth, imgHeight);

  // === Styling ===
  ctx.font = 'bold 35px Arial';
  ctx.lineWidth = 2;

  const dateObj = new Date(timestamp);
  const timeText = dateObj.toLocaleTimeString();
  const dateText = dateObj.toLocaleDateString();

  // === RIGHT: Timestamp in WHITE ===
  ctx.textAlign = 'right';
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';
  const dateTime = timeText + "  " + dateText;
  ctx.strokeText(dateTime, canvas.width - 20, 40);
  ctx.fillText(dateTime, canvas.width - 20, 40);

  ctx.textAlign = 'left';

  // CSS object-fit sizes this canvas the same way as the image underneath.
  canvas.style.transform = '';
  canvas.style.display = 'block';
  if (imageElement.tagName !== 'VIDEO') imageElement.style.display = 'none';
}
// Enhanced image capture with Promise handling
function getTimestampedImage(imageElement, door, timestamp, timestampCheckbox) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  return new Promise((resolve) => {
    const draw = () => {
      const box = mediaBox(imageElement);
      canvas.width = box.width || 1080;
      canvas.height = box.height || 720;
      drawImageToCanvas(ctx, imageElement, canvas, door, timestamp, timestampCheckbox, resolve);
    };
    if (mediaBox(imageElement).ready) {
      draw();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (mediaBox(imageElement).ready) {
        draw();
        return;
      }
      canvas.width = 1080;
      canvas.height = 720;
      ctx.fillStyle = '#f0f0f0';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#999';
      ctx.font = '30px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('No Image', canvas.width / 2, canvas.height / 2);
      resolve(canvas.toDataURL('image/jpeg', 0.5));
    };
    const eventName = imageElement && imageElement.tagName === 'VIDEO' ? 'loadeddata' : 'load';
    if (imageElement) imageElement.addEventListener(eventName, finish, { once: true });
    setTimeout(finish, 1000);
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
  ctx.lineWidth = 2;

  const dateObj = new Date(timestamp);
  const timeText = dateObj.toLocaleTimeString();
  const dateText = dateObj.toLocaleDateString();

  // === RIGHT: Time + Date (white, right aligned) ===
  ctx.textAlign = 'right';
  ctx.fillStyle = 'white';
  ctx.strokeStyle = 'black';

  const dateTime = timeText + " " + dateText;
  // Time on top right
  ctx.strokeText(dateTime, ctx.canvas.width - 20, 40);
  ctx.fillText(dateTime, ctx.canvas.width - 20, 40);

  // Reset alignment
  ctx.textAlign = 'left';
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
// Each card plays a mediaMTX WebRTC path. Port 8889 plus the path is the reader
// address; playback POSTs the SDP offer to that path with /whep appended.
const STREAM_URLS_KEY = 'thermosquid.streamUrls';
const DEFAULT_STREAM_URLS = {
  front: 'http://192.168.1.37:8889/cam_ribbon',
  back: 'http://192.168.1.37:8889/cam_usb'
};
const streamPlayers = {
  front: { generation: 0, pc: null, sessionUrl: '', retryTimer: null },
  back: { generation: 0, pc: null, sessionUrl: '', retryTimer: null }
};
let overlayStamp = 0;

function videoFor(camera) {
  return camera === 'front' ? frontVideoStream : backVideoStream;
}

function captureButtonFor(camera) {
  return camera === 'front' ? captureFrontImageButton : captureBackImageButton;
}

function readStoredStreamUrls() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STREAM_URLS_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_STREAM_URLS };
    return {
      front: typeof parsed.front === 'string' ? parsed.front : DEFAULT_STREAM_URLS.front,
      back: typeof parsed.back === 'string' ? parsed.back : DEFAULT_STREAM_URLS.back
    };
  } catch (error) {
    return { ...DEFAULT_STREAM_URLS };
  }
}

function saveStreamUrls() {
  try {
    localStorage.setItem(STREAM_URLS_KEY, JSON.stringify({
      front: document.getElementById('front-stream-url').value.trim(),
      back: document.getElementById('back-stream-url').value.trim()
    }));
  } catch (error) {
    console.debug('Stream URLs were not stored');
  }
}

function restoreStreamUrls() {
  const stored = readStoredStreamUrls();
  const front = document.getElementById('front-stream-url');
  const back = document.getElementById('back-stream-url');
  if (front) front.value = stored.front;
  if (back) back.value = stored.back;
}

function streamPageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  parsed.search = '';
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/whep')) path = path.slice(0, -5).replace(/\/+$/, '');
  parsed.pathname = path || '/';
  return parsed.toString();
}

function whepUrlFor(pageUrl) {
  const parsed = new URL(pageUrl);
  const path = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = `${path}/whep`;
  return parsed.toString();
}

function setStreamStatus(camera, text, kind) {
  const el = document.getElementById(`${camera}-stream-status`);
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('is-error', kind === 'error');
}

function markStreamLive(camera) {
  const previous = lastCapturedImages[camera];
  lastCapturedImages[camera] = {
    door: camera,
    image: 'stream',
    timestamp: Date.now(),
    frames: Math.max(1, previous && previous.frames ? previous.frames : 1)
  };
  const button = captureButtonFor(camera);
  if (button) {
    button.disabled = false;
    button.classList.remove('disabled');
  }
  const video = videoFor(camera);
  if (video) video.style.display = 'block';
  setStreamStatus(camera, '');
}

function markStreamDown(camera) {
  lastCapturedImages[camera] = null;
}

function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, 2000);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

async function closeStreamSession(player) {
  const sessionUrl = player.sessionUrl;
  const pc = player.pc;
  player.sessionUrl = '';
  player.pc = null;
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    try { pc.close(); } catch (error) { /* already closed */ }
  }
  if (sessionUrl) {
    try { await fetch(sessionUrl, { method: 'DELETE' }); } catch (error) { /* reader already gone */ }
  }
}

function scheduleStreamRetry(camera, generation) {
  const player = streamPlayers[camera];
  clearTimeout(player.retryTimer);
  player.retryTimer = setTimeout(() => {
    if (player.generation !== generation) return;
    const pageUrl = streamPageUrl(document.getElementById(`${camera}-stream-url`).value);
    if (!pageUrl) return;
    openStream(camera, generation, pageUrl);
  }, 3000);
}

function attachModalStream(camera) {
  const source = videoFor(camera);
  if (!modalVideoStream || !source) return;
  modalVideoStream.srcObject = source.srcObject || null;
  modalVideoStream.muted = true;
  if (!source.srcObject) return;
  if (isPaused[camera]) modalVideoStream.pause();
  else modalVideoStream.play().catch(() => {});
}

async function openStream(camera, generation, pageUrl) {
  const player = streamPlayers[camera];
  const video = videoFor(camera);
  if (!video || player.generation !== generation) return;
  player.connectId = (player.connectId || 0) + 1;
  const connectId = player.connectId;
  await closeStreamSession(player);
  if (player.generation !== generation || player.connectId !== connectId) return;

  setStreamStatus(camera, 'Connecting…');
  const pc = new RTCPeerConnection();
  player.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  const remoteStream = new MediaStream();
  let gotTrack = false;
  let gaveUp = false;

  const giveUp = (message) => {
    if (gaveUp || player.generation !== generation || player.connectId !== connectId) return;
    gaveUp = true;
    markStreamDown(camera);
    setStreamStatus(camera, message, 'error');
    scheduleStreamRetry(camera, generation);
  };

  const noteReady = () => {
    if (player.generation !== generation || player.connectId !== connectId || video.videoWidth <= 0) return;
    gotTrack = true;
    if (!isPaused[camera]) video.play().catch(() => {});
    markStreamLive(camera);
    if (currentModalCamera === camera) attachModalStream(camera);
  };
  if (video._streamReady) {
    video.removeEventListener('loadeddata', video._streamReady);
    video.removeEventListener('resize', video._streamReady);
  }
  video._streamReady = noteReady;
  video.addEventListener('loadeddata', noteReady);
  video.addEventListener('resize', noteReady);

  pc.ontrack = (event) => {
    if (player.generation !== generation || player.connectId !== connectId) return;
    if (!remoteStream.getTracks().includes(event.track)) remoteStream.addTrack(event.track);
    video.srcObject = remoteStream;
    video.muted = true;
    video.playsInline = true;
    video.style.display = 'block';
    if (currentModalCamera === camera) attachModalStream(camera);
    noteReady();
  };

  pc.onconnectionstatechange = () => {
    if (player.generation !== generation || player.connectId !== connectId) return;
    if (pc.connectionState === 'failed') {
      giveUp('Stream disconnected. Retrying…');
      return;
    }
    if (pc.connectionState !== 'disconnected') return;
    setTimeout(() => {
      if (player.generation !== generation || player.connectId !== connectId) return;
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        giveUp('Stream disconnected. Retrying…');
      }
    }, 4000);
  };

  try {
    const offer = await pc.createOffer();
    if (player.generation !== generation || player.connectId !== connectId) return;
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    if (player.generation !== generation || player.connectId !== connectId) return;
    const whepUrl = whepUrlFor(pageUrl);
    const response = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp
    });
    if (player.generation !== generation || player.connectId !== connectId) return;
    if (!response.ok) throw new Error(`mediaMTX returned ${response.status}`);
    const answer = await response.text();
    const location = response.headers.get('Location');
    if (location) player.sessionUrl = new URL(location, whepUrl).toString();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    setTimeout(() => {
      if (gotTrack) return;
      giveUp('No video from mediaMTX. Retrying…');
    }, 15000);
  } catch (error) {
    if (player.generation !== generation || player.connectId !== connectId) return;
    console.warn(`${camera} stream failed`, error);
    await closeStreamSession(player);
    giveUp('Cannot reach the stream. Retrying…');
  }
}

async function beginStream(camera) {
  const player = streamPlayers[camera];
  player.generation += 1;
  const generation = player.generation;
  clearTimeout(player.retryTimer);
  player.retryTimer = null;
  const video = videoFor(camera);
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  const canvas = camera === 'front' ? frontCanvas : backCanvas;
  if (canvas) canvas.style.display = 'none';
  if (currentModalCamera === camera && modalVideoStream) {
    modalVideoStream.pause();
    modalVideoStream.srcObject = null;
  }
  await closeStreamSession(player);
  if (player.generation !== generation) return;

  const input = document.getElementById(`${camera}-stream-url`);
  const pageUrl = streamPageUrl(input ? input.value : '');
  if (pageUrl == null) {
    markStreamDown(camera);
    setStreamStatus(camera, 'Stream URL is not valid', 'error');
    return;
  }
  if (!pageUrl) {
    markStreamDown(camera);
    setStreamStatus(camera, 'Enter a stream URL');
    return;
  }
  if (typeof RTCPeerConnection !== 'function') {
    markStreamDown(camera);
    setStreamStatus(camera, 'This browser cannot play WebRTC', 'error');
    return;
  }
  await openStream(camera, generation, pageUrl);
}

function bindStreamField(camera) {
  const input = document.getElementById(`${camera}-stream-url`);
  if (!input) return;
  input.addEventListener('change', () => {
    saveStreamUrls();
    beginStream(camera);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    input.blur();
  });
}

function paintCameraOverlay(camera, video, canvas, ctx, checkbox, paused) {
  if (!checkbox || !checkbox.checked) {
    if (canvas) canvas.style.display = 'none';
    return;
  }
  if (paused && canvas && canvas.style.display === 'block') return;
  drawTimestamp(video, canvas, ctx, camera, Date.now(), checkbox);
}

function paintTimestampOverlays() {
  paintCameraOverlay('front', frontVideoStream, frontCanvas, frontCtx, frontTimestampCheckbox, isPaused.front);
  paintCameraOverlay('back', backVideoStream, backCanvas, backCtx, backTimestampCheckbox, isPaused.back);
  if (!modal || modal.style.display !== 'flex' || !currentModalCamera || !modalVideoStream || !modalCanvas || !modalCtx) return;
  const stampOn = { checked: Boolean(modalTimestampEnabled) };
  paintCameraOverlay(currentModalCamera, modalVideoStream, modalCanvas, modalCtx, stampOn, isPaused[currentModalCamera]);
}

function overlayLoop(now) {
  if (now - overlayStamp > 120) {
    overlayStamp = now;
    paintTimestampOverlays();
    ['front', 'back'].forEach((camera) => {
      const video = videoFor(camera);
      const shot = lastCapturedImages[camera];
      if (!shot || isPaused[camera] || !mediaBox(video).ready) return;
      shot.timestamp = Date.now();
      shot.frames = Math.max(1, shot.frames || 1);
    });
  }
  requestAnimationFrame(overlayLoop);
}

function setCameraPaused(camera, paused) {
  isPaused[camera] = paused;
  if (currentModalCamera === camera) modalIsPaused = paused;
  const video = videoFor(camera);
  if (video) {
    if (paused) video.pause();
    else if (video.srcObject) video.play().catch(() => {});
  }
  if (currentModalCamera === camera && modalVideoStream && modalVideoStream.srcObject) {
    if (paused) modalVideoStream.pause();
    else modalVideoStream.play().catch(() => {});
  }
  updateToggleButtonUI(camera);
  const liveToggle = document.getElementById('modal-toggle-btn');
  if (currentModalCamera === camera && liveToggle) {
    const span = liveToggle.querySelector('span');
    const icon = liveToggle.querySelector('i');
    if (span && icon) {
      span.textContent = paused ? 'Resume' : 'Pause';
      icon.className = paused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    }
  }
  paintTimestampOverlays();
}

let imageListWaiter = null;
let imageListSeq = 0;

function requestImageList() {
  return new Promise((resolve, reject) => {
    if (!imageWs || imageWs.readyState !== WebSocket.OPEN) {
      reject(new Error('closed'));
      return;
    }
    if (imageListWaiter) {
      clearTimeout(imageListWaiter.timer);
      imageListWaiter.reject(new Error('replaced'));
      imageListWaiter = null;
    }
    const id = `list-${Date.now()}-${imageListSeq += 1}`;
    const timer = setTimeout(() => {
      if (!imageListWaiter || imageListWaiter.id !== id) return;
      imageListWaiter = null;
      reject(new Error('timeout'));
    }, 8000);
    imageListWaiter = { id, resolve, reject, timer };
    imageWs.send(JSON.stringify({ action: 'list_images', door: null, date: null, requestId: id }));
  });
}

function connectImageWebSocket() {
  imageWs.onopen = () => {
    console.log('Image service connected');
  };
  imageWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.status === 'image_list') {
        if (imageListWaiter && data.requestId === imageListWaiter.id) {
          const waiter = imageListWaiter;
          imageListWaiter = null;
          clearTimeout(waiter.timer);
          waiter.resolve(Array.isArray(data.images) ? data.images : []);
        }
        return;
      }
      if (data.action === 'save_session_data') {
        if (data.status === 'error') showStatusMessage(data.message || 'Could not save the shot data', 2000);
        return;
      }
      if (data.action === 'notify_device') {
        if (data.status === 'error') {
          showStatusMessage(notifyStatusText(data.message), 2000);
          return;
        }
        if (data.status === 'ok' && !applyShotReading(data.shot, data.at, data.temperatures)) {
          showStatusMessage('Temperature reading was not valid', 2000);
        }
        return;
      }
      const door = data.door;
      if (door !== 'front' && door !== 'back') return;
      if (data.action && data.action !== 'save_image') return;
      if (data.status === 'saved' && (data.action === 'save_image' || data.filename || data.path)) {
        showCaptureConfirm(door, data.filename || fileNameFromPath(data.path), true, { flash: false });
      } else if (data.status === 'error' && data.action === 'save_image') {
        showCaptureConfirm(door, '', false);
      }
    } catch (e) {
      console.debug('Image message ignored');
    }
  };
  imageWs.onclose = () => {
    console.log('Image service disconnected');
    // Auto-reconnect image service
    setTimeout(() => {
      imageWs = new WebSocket(`ws://${host}:3000/ws`);
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
 
  temperatureWs = new WebSocket(`ws://${host}:8083/ws`);
 
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
  modalIsPaused = Boolean(isPaused[camera]);
  const sourceTimestamp = camera === 'front' ? frontTimestampCheckbox : backTimestampCheckbox;
  modalTimestampEnabled = Boolean(sourceTimestamp?.checked);
 
  if (modal) {
    modal.style.display = 'flex';
    document.getElementById('modal-camera-title').textContent = cameraName(camera);
   
    // Set up modal timestamp checkbox (only if it exists)
    const liveTimestamp = document.getElementById('modal-timestamp');
    if (liveTimestamp) {
      liveTimestamp.checked = modalTimestampEnabled;
      // Remove existing listeners to prevent duplicates
      liveTimestamp.replaceWith(liveTimestamp.cloneNode(true));
      const newCheckbox = document.getElementById('modal-timestamp');
      newCheckbox.addEventListener('change', (e) => {
        modalTimestampEnabled = e.target.checked;
        if (currentModalCamera) {
          updateModalTimestampOverlay();
        }
      });
    }
  }
  if (modalVideoStream && currentModalCamera) {
    attachModalStream(currentModalCamera);
    modalVideoStream.style.display = 'block';
    updateModalTimestampOverlay();
  }
  // Modal capture button
  if (modalCaptureBtn) {
    // Remove existing listeners
    modalCaptureBtn.replaceWith(modalCaptureBtn.cloneNode(true));
    const newCaptureBtn = document.getElementById('modal-capture-btn');
    newCaptureBtn.onclick = () => {
      const camera = currentModalCamera;
      if (camera && imageWs.readyState === WebSocket.OPEN) {
        const lastImage = lastCapturedImages[camera];
        if (lastImage && lastImage.image) {
          const customName = modalFilenameInput?.value?.trim() || '';
          const videoStream = camera === 'front' ? frontVideoStream : backVideoStream;
         
          getTimestampedImage(videoStream, camera, lastImage.timestamp,
            modalTimestampEnabled ? {checked: true} : {checked: false})
            .then((imageData) => {
              sendSaveImage(camera, imageData, customName);
            })
            .catch((error) => {
              console.error('Modal capture error:', error);
              showCaptureConfirm(camera, '', false);
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
      if (currentModalCamera) setCameraPaused(currentModalCamera, !isPaused[currentModalCamera]);
    };
    const span = newToggleBtn.querySelector('span');
    const icon = newToggleBtn.querySelector('i');
    if (span && icon) {
      span.textContent = modalIsPaused ? 'Resume' : 'Pause';
      icon.className = modalIsPaused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    }
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
   
    // Reset modal controls. openCameraModal replaces the button node, so look it up again.
    const liveToggleBtn = document.getElementById('modal-toggle-btn');
    if (liveToggleBtn) {
      const span = liveToggleBtn.querySelector('span');
      const icon = liveToggleBtn.querySelector('i');
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
let timeSyncPending = false;
let timeSyncTimer = null;

function showTimeSyncStatus(text, kind) {
  const status = document.getElementById('time-sync-status');
  if (!status) return;
  const icon = status.querySelector('i');
  const label = status.querySelector('span');
  status.hidden = !text;
  status.classList.toggle('is-success', kind === 'success');
  status.classList.toggle('is-error', kind === 'error');
  status.classList.toggle('is-pending', kind === 'pending');
  if (icon) {
    icon.className = kind === 'success'
      ? 'fa-solid fa-check'
      : kind === 'error'
        ? 'fa-solid fa-triangle-exclamation'
        : 'fa-solid fa-clock';
  }
  if (label) label.textContent = text || '';
}

function setSyncButtonBusy(busy) {
  const button = document.getElementById('sync-time-btn');
  if (!button) return;
  button.disabled = busy;
  const label = button.querySelector('span');
  if (label) label.textContent = busy ? 'Syncing...' : 'Sync time';
}

function finishTimeSync(text, kind) {
  timeSyncPending = false;
  clearTimeout(timeSyncTimer);
  timeSyncTimer = null;
  setSyncButtonBusy(false);
  showTimeSyncStatus(text, kind);
}

function timeSyncSuccessText(message) {
  const text = typeof message === 'string' ? message.trim() : '';
  const match = text.match(/set to\s+(.+)$/i);
  if (match) return `Synced to ${match[1].trim()}`;
  return text || 'Time synced';
}

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
        finishTimeSync(timeSyncSuccessText(data.message), 'success');
      } else if (data.type === 'error') {
        const message = typeof data.message === 'string' ? data.message.trim() : '';
        finishTimeSync(message || 'Time sync failed', 'error');
      }
    } catch (e) {}
  };

  timeWs.onclose = () => {
    console.log('%c[Time] Disconnected from time server', 'color: red');
    if (timeSyncPending) finishTimeSync('Time server not connected', 'error');
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
// Sync button handler
const syncTimeBtn = document.getElementById('sync-time-btn');

if (syncTimeBtn) {
  syncTimeBtn.addEventListener('click', () => {
    if (!timeWs || timeWs.readyState !== WebSocket.OPEN) {
      finishTimeSync('Time server not connected', 'error');
      return;
    }
    if (timeSyncPending) return;

    const localTime = getLocalWindowsTime();
    timeSyncPending = true;
    setSyncButtonBusy(true);
    showTimeSyncStatus('Syncing Pi time...', 'pending');
    clearTimeout(timeSyncTimer);
    timeSyncTimer = setTimeout(() => {
      if (!timeSyncPending) return;
      finishTimeSync('No reply from the time server', 'error');
    }, 8000);

    try {
      timeWs.send(JSON.stringify({
        type: 'sync-time',
        time: localTime,
        password: 'Lasers4Life'
      }));
    } catch (err) {
      finishTimeSync('Time server not connected', 'error');
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
  [frontTimestampCheckbox, backTimestampCheckbox].forEach((box) => {
    if (box) box.addEventListener('change', paintTimestampOverlays);
  });
  // Camera controls
  document.querySelectorAll('.control-btn').forEach(button => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const camera = button.dataset.camera;
      const action = button.dataset.action;

      if (action === 'capture') {
        const lastImage = lastCapturedImages[camera];

        if (button.dataset.busy === 'true') return;

        if (!lastImage || !lastImage.image || lastImage.frames === 0) {
          showStatusMessage(`Wait for ${camera} image...`, 1500);
          return;
        }

        if (imageWs.readyState !== WebSocket.OPEN) {
          showStatusMessage('Image service busy', 1500);
          return;
        }

        button.dataset.busy = 'true';
        button.classList.add('is-capturing');

        try {
          const customName = (camera === 'front' ? customFileNameInputFront : customFileNameInputBack)?.value?.trim() || '';
          const timestampCheckbox = camera === 'front' ? frontTimestampCheckbox : backTimestampCheckbox;
          const videoStream = camera === 'front' ? frontVideoStream : backVideoStream;

          getTimestampedImage(videoStream, camera, lastImage.timestamp, timestampCheckbox)
            .then((imageData) => {
              sendSaveImage(camera, imageData, customName);
            })
            .catch((error) => {
              console.error('Failed to get image data:', error);
              showCaptureConfirm(camera, '', false);
              showStatusMessage('Capture failed', 2000);
            })
            .finally(() => {
              button.dataset.busy = 'false';
              button.classList.remove('is-capturing');
            });
        } catch (error) {
          console.error('Capture setup error:', error);
          button.dataset.busy = 'false';
          button.classList.remove('is-capturing');
          showStatusMessage('Capture failed', 2000);
        }
      } else if (action === 'toggle') {
        setCameraPaused(camera, !isPaused[camera]);
      } else if (action === 'settings') {
        toggleSettingsMenu(camera);
      }
    });
  });
  restoreStreamUrls();
  bindStreamField('front');
  bindStreamField('back');
  syncCameraSettings('front');
  syncCameraSettings('back');
  beginStream('front');
  beginStream('back');
  requestAnimationFrame(overlayLoop);
  // Connect WebSockets
  setTimeout(() => {
    connectImageWebSocket();

    // Initialize temperature widget after a short delay
    setTimeout(() => {
      initializeTemperatureWidget();
      connectTemperatureWebSocket();
    }, 1000);
  }, 100);
});
// Cleanup
window.addEventListener('beforeunload', () => {
  Object.values(lastCapturedImages).forEach(image => {
    if (image && typeof image.image === 'string' && image.image.startsWith('blob:')) {
      URL.revokeObjectURL(image.image);
    }
  });
  ['front', 'back'].forEach((camera) => {
    const player = streamPlayers[camera];
    player.generation += 1;
    clearTimeout(player.retryTimer);
    if (player.pc) {
      try { player.pc.close(); } catch (error) { /* already closed */ }
    }
    if (player.sessionUrl) fetch(player.sessionUrl, { method: 'DELETE' }).catch(() => {});
  });

  if (temperatureWs) {
    temperatureWs.close();
  }
});

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

const CAMERA_SETTING_GROUPS = [
  {
    title: 'Picture',
    fields: [
      {
        type: 'select', id: 'resolution', label: 'Resolution',
        options: [
          ['640x480', '640×480'],
          ['1280x720', '1280×720'],
          ['1920x1080', '1920×1080'],
          ['1536x864', '1536×864', true]
        ]
      },
      {
        type: 'select', id: 'framerate', label: 'Framerate',
        options: [
          ['10', '10 fps'],
          ['15', '15 fps'],
          ['30', '30 fps', true],
          ['60', '60 fps']
        ]
      }
    ]
  },
  {
    title: 'Image',
    fields: [
      { type: 'slider', id: 'brightness', label: 'Brightness', min: -1, max: 1, step: 0.05, value: 0 },
      { type: 'slider', id: 'contrast', label: 'Contrast', min: 0, max: 32, step: 0.1, value: 1 },
      { type: 'slider', id: 'sharpness', label: 'Sharpness', min: 0, max: 16, step: 0.1, value: 1 },
      { type: 'slider', id: 'saturation', label: 'Saturation', min: 0, max: 32, step: 0.1, value: 1 },
      { type: 'slider', id: 'ev', label: 'EV', title: 'Exposure value', min: -8, max: 8, step: 1, value: 0 }
    ]
  },
  {
    title: 'Exposure',
    fields: [
      { type: 'slider', id: 'shutter', label: 'Shutter', hint: 'µs', min: 0, max: 100000, step: 1, value: 0, scale: 'log' },
      { type: 'slider', id: 'gain', label: 'Gain', min: 0, max: 32, step: 0.1, value: 0 },
      {
        type: 'select', id: 'metering', label: 'Metering',
        options: [
          ['centre', 'Centre'],
          ['spot', 'Spot'],
          ['average', 'Average'],
          ['custom', 'Custom']
        ]
      },
      {
        type: 'select', id: 'exposure', label: 'Exposure', title: 'Exposure mode',
        options: [
          ['normal', 'Normal'],
          ['sport', 'Sport'],
          ['long', 'Long']
        ]
      }
    ]
  },
  {
    title: 'Color',
    fields: [
      {
        type: 'select', id: 'awb', label: 'White balance',
        options: [
          ['auto', 'Auto'],
          ['incandescent', 'Incandescent'],
          ['tungsten', 'Tungsten'],
          ['fluorescent', 'Fluorescent'],
          ['indoor', 'Indoor'],
          ['daylight', 'Daylight'],
          ['cloudy', 'Cloudy'],
          ['off', 'Manual']
        ]
      },
      { type: 'slider', id: 'awb-red', label: 'Red gain', hint: 'Manual white balance', min: 0.1, max: 8, step: 0.1, value: 1, awbGain: true },
      { type: 'slider', id: 'awb-blue', label: 'Blue gain', hint: 'Manual white balance', min: 0.1, max: 8, step: 0.1, value: 1, awbGain: true },
      {
        type: 'select', id: 'denoise', label: 'Denoise',
        options: [
          ['auto', 'Auto'],
          ['off', 'Off'],
          ['cdn_off', 'CDN Off'],
          ['cdn_fast', 'CDN Fast']
        ]
      }
    ]
  }
];

function settingStepDecimals(step) {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function formatSettingValue(value, step) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return number.toFixed(settingStepDecimals(step));
}

function clampSetting(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logSliderPosition(field, value) {
  if (value <= field.min) return 0;
  const minPositive = Math.max(field.step, 1);
  const clamped = clampSetting(value, minPositive, field.max);
  const t = Math.log(clamped / minPositive) / Math.log(field.max / minPositive);
  return String(Math.round(t * 1000));
}

function valueFromLogSlider(field, position) {
  const pos = Number(position);
  if (pos <= 0) return field.min;
  const minPositive = Math.max(field.step, 1);
  const t = pos / 1000;
  const raw = minPositive * Math.pow(field.max / minPositive, t);
  return clampSetting(Math.round(raw / field.step) * field.step, field.min, field.max);
}

function sliderPositionFor(field, value) {
  if (field.scale === 'log') return logSliderPosition(field, value);
  return formatSettingValue(value, field.step);
}

function valueFromSlider(field, position) {
  if (field.scale === 'log') return valueFromLogSlider(field, position);
  return clampSetting(Number(position), field.min, field.max);
}

function renderCameraSettings(camera) {
  const menu = document.getElementById(`${camera}-settings-menu`);
  if (!menu) return;

  const groups = CAMERA_SETTING_GROUPS.map(group => {
    const fields = group.fields.map(field => renderSettingField(camera, field)).join('');
    return `<section class="settings-group"><h4>${group.title}</h4>${fields}</section>`;
  }).join('');

  menu.innerHTML = `<div class="settings-groups">${groups}</div>
    <div class="settings-reset-row">
      <button type="button" class="settings-reset" data-camera="${camera}">Reset</button>
    </div>`;

  CAMERA_SETTING_GROUPS.forEach(group => {
    group.fields.forEach(field => bindSettingField(camera, field));
  });
  menu.querySelector('.settings-reset').addEventListener('click', () => openSettingsReset(camera));
  updateAwbGainFields(camera);
}

function renderSettingField(camera, field) {
  const inputId = `${camera}-${field.id}`;
  const labelId = `${inputId}-label`;
  const awbClass = field.awbGain ? ' awb-gain' : '';
  const title = field.title || field.hint || '';
  const titleAttr = title ? ` title="${title}"` : '';

  if (field.type === 'select') {
    const options = field.options.map(([value, label, selected]) => {
      return `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;
    }).join('');
    return `
      <div class="setting-field is-choice${awbClass}">
        <label id="${labelId}" for="${inputId}"${titleAttr}>${field.label}</label>
        <select id="${inputId}" aria-labelledby="${labelId}">${options}</select>
      </div>
    `;
  }

  const value = formatSettingValue(field.value, field.step);
  const sliderValue = sliderPositionFor(field, field.value);
  const sliderMax = field.scale === 'log' ? 1000 : field.max;
  const sliderMin = field.scale === 'log' ? 0 : field.min;
  const sliderStep = field.scale === 'log' ? 1 : field.step;
  return `
    <div class="setting-field${awbClass}">
      <label id="${labelId}" for="${inputId}"${titleAttr}>${field.label}</label>
      <input type="range" id="${inputId}-slider" min="${sliderMin}" max="${sliderMax}" step="${sliderStep}" value="${sliderValue}" aria-labelledby="${labelId}">
      <input type="number" id="${inputId}" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}" inputmode="decimal" aria-label="${field.label} value">
    </div>
  `;
}

function bindSettingField(camera, field) {
  const input = document.getElementById(`${camera}-${field.id}`);
  if (!input) return;

  if (field.type === 'select') {
    input.addEventListener('change', () => {
      if (field.id === 'awb') updateAwbGainFields(camera);
      applyCameraSettings(camera);
    });
    return;
  }

  const slider = document.getElementById(`${camera}-${field.id}-slider`);
  slider.addEventListener('input', () => {
    input.value = formatSettingValue(valueFromSlider(field, slider.value), field.step);
  });
  slider.addEventListener('change', () => {
    input.value = formatSettingValue(valueFromSlider(field, slider.value), field.step);
    applyCameraSettings(camera);
  });
  input.addEventListener('change', () => {
    const parsed = parseFloat(input.value);
    const value = Number.isFinite(parsed)
      ? clampSetting(parsed, field.min, field.max)
      : valueFromSlider(field, slider.value);
    input.value = formatSettingValue(value, field.step);
    slider.value = sliderPositionFor(field, value);
    applyCameraSettings(camera);
  });
}

function updateAwbGainFields(camera) {
  const manual = document.getElementById(`${camera}-awb`).value === 'off';
  document.querySelectorAll(`#${camera}-settings-menu .awb-gain`).forEach(row => {
    row.classList.toggle('is-disabled', !manual);
    row.querySelectorAll('input').forEach(input => {
      input.disabled = !manual;
    });
  });
}

function toggleSettingsMenu(camera) {
  const menu = camera === 'front' ? frontSettingsMenu : backSettingsMenu;
  if (!menu) return;
  menu.classList.toggle('is-open');
}

const CAMERA_SETTINGS_STORAGE_KEY = 'thermosquid.cameraSettings';
const CAMERA_SETTING_FIELDS = new Map();
CAMERA_SETTING_GROUPS.forEach(group => {
  group.fields.forEach(field => CAMERA_SETTING_FIELDS.set(field.id, field));
});
const lastSentCameraSettings = { front: '', back: '' };

function readSettingNumber(id, fallback) {
  const parsed = parseFloat(document.getElementById(id).value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readStoredCameraSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAMERA_SETTINGS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (error) {
    return {};
  }
}

function writeStoredCameraSettings(camera, settings) {
  try {
    const all = readStoredCameraSettings();
    all[camera] = settings;
    localStorage.setItem(CAMERA_SETTINGS_STORAGE_KEY, JSON.stringify(all));
  } catch (error) {
    console.debug('Camera settings were not stored');
  }
}

function restoreSelect(id, value) {
  const select = document.getElementById(id);
  if (!select || value == null) return;
  const text = String(value);
  if ([...select.options].some(option => option.value === text)) {
    select.value = text;
  }
}

function restoreSlider(camera, fieldId, raw) {
  const field = CAMERA_SETTING_FIELDS.get(fieldId);
  const input = document.getElementById(`${camera}-${fieldId}`);
  const slider = document.getElementById(`${camera}-${fieldId}-slider`);
  const value = Number(raw);
  if (!field || !input || !slider || !Number.isFinite(value)) return;
  const clamped = clampSetting(value, field.min, field.max);
  input.value = formatSettingValue(clamped, field.step);
  slider.value = sliderPositionFor(field, clamped);
}

function hasStoredCameraSettings(camera) {
  const stored = readStoredCameraSettings()[camera];
  return Boolean(stored && typeof stored === 'object' && Number.isFinite(Number(stored.width)) && Number.isFinite(Number(stored.height)));
}

function applySettingsObject(camera, stored) {
  if (!stored || typeof stored !== 'object') return false;
  if (!Number.isFinite(Number(stored.width)) || !Number.isFinite(Number(stored.height))) return false;

  restoreSelect(`${camera}-resolution`, `${stored.width}x${stored.height}`);
  restoreSelect(`${camera}-framerate`, stored.framerate);
  restoreSelect(`${camera}-metering`, stored.metering);
  restoreSelect(`${camera}-exposure`, stored.exposure);
  restoreSelect(`${camera}-awb`, stored.awb);
  restoreSelect(`${camera}-denoise`, stored.denoise);
  restoreSlider(camera, 'brightness', stored.brightness);
  restoreSlider(camera, 'contrast', stored.contrast);
  restoreSlider(camera, 'sharpness', stored.sharpness);
  restoreSlider(camera, 'saturation', stored.saturation);
  restoreSlider(camera, 'ev', stored.ev);
  restoreSlider(camera, 'shutter', stored.shutter);
  restoreSlider(camera, 'gain', stored.gain);
  restoreSlider(camera, 'awb-red', stored.awb_red);
  restoreSlider(camera, 'awb-blue', stored.awb_blue);
  updateAwbGainFields(camera);
  return true;
}

function restoreCameraSettings(camera) {
  applySettingsObject(camera, readStoredCameraSettings()[camera]);
}

function adoptCameraConfig(camera, config) {
  if (hasStoredCameraSettings(camera)) return;
  if (!applySettingsObject(camera, config)) return;
  const settings = buildCameraSettings(camera);
  writeStoredCameraSettings(camera, settings);
  lastSentCameraSettings[camera] = JSON.stringify(settings);
}

function buildCameraSettings(camera) {
  const resolutionSelect = document.getElementById(`${camera}-resolution`);
  const framerateSelect = document.getElementById(`${camera}-framerate`);
  const [width, height] = resolutionSelect.value.split('x');

  return {
    action: 'set_config',
    width: parseInt(width, 10),
    height: parseInt(height, 10),
    framerate: parseInt(framerateSelect.value, 10),
    brightness: readSettingNumber(`${camera}-brightness`, 0),
    contrast: readSettingNumber(`${camera}-contrast`, 1),
    sharpness: readSettingNumber(`${camera}-sharpness`, 1),
    saturation: readSettingNumber(`${camera}-saturation`, 1),
    ev: Math.round(readSettingNumber(`${camera}-ev`, 0)),
    shutter: Math.round(readSettingNumber(`${camera}-shutter`, 0)),
    gain: readSettingNumber(`${camera}-gain`, 0),
    metering: document.getElementById(`${camera}-metering`).value || 'centre',
    exposure: document.getElementById(`${camera}-exposure`).value || 'normal',
    awb: document.getElementById(`${camera}-awb`).value || 'auto',
    awb_red: readSettingNumber(`${camera}-awb-red`, 1),
    awb_blue: readSettingNumber(`${camera}-awb-blue`, 1),
    denoise: document.getElementById(`${camera}-denoise`).value || 'auto'
  };
}

function pushStoredCameraSettings(camera, ws) {
  const stored = readStoredCameraSettings()[camera];
  if (!stored || typeof stored !== 'object') return;
  if (!Number.isFinite(Number(stored.width)) || !Number.isFinite(Number(stored.height))) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const payload = JSON.stringify(buildCameraSettings(camera));
  try {
    ws.send(payload);
  } catch (error) {
    console.debug(`${camera} settings were not sent`);
    return;
  }
  lastSentCameraSettings[camera] = payload;
}

function defaultSelectValue(field) {
  const chosen = field.options.find((option) => option[2]);
  return (chosen || field.options[0])[0];
}

let settingsResetCamera = null;
let settingsResetReturn = null;

function openSettingsReset(camera) {
  settingsResetCamera = camera;
  settingsResetReturn = document.querySelector(`#${camera}-settings-menu .settings-reset`);
  const dialog = document.getElementById('settings-reset-dialog');
  dialog.hidden = false;
  document.getElementById('settings-reset-cancel').focus();
}

function closeSettingsReset() {
  const dialog = document.getElementById('settings-reset-dialog');
  dialog.hidden = true;
  const returnFocus = settingsResetReturn;
  settingsResetCamera = null;
  settingsResetReturn = null;
  if (returnFocus) returnFocus.focus();
}

function resetCameraSettings(camera) {
  CAMERA_SETTING_GROUPS.forEach((group) => {
    group.fields.forEach((field) => {
      if (field.type === 'select') restoreSelect(`${camera}-${field.id}`, defaultSelectValue(field));
      else restoreSlider(camera, field.id, field.value);
    });
  });
  updateAwbGainFields(camera);
  applyCameraSettings(camera);
}

function confirmSettingsReset() {
  const camera = settingsResetCamera;
  closeSettingsReset();
  if (camera) resetCameraSettings(camera);
}

function bindSettingsResetDialog() {
  const dialog = document.getElementById('settings-reset-dialog');
  document.getElementById('settings-reset-cancel').addEventListener('click', closeSettingsReset);
  document.getElementById('settings-reset-confirm').addEventListener('click', confirmSettingsReset);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeSettingsReset();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dialog.hidden) closeSettingsReset();
  });
}

function controlUrl(camera) {
  const input = document.getElementById(`${camera}-stream-url`);
  const pageUrl = streamPageUrl(input ? input.value : '');
  if (!pageUrl) return '';
  const parsed = new URL(pageUrl);
  const name = parsed.pathname.split('/').filter(Boolean)[0];
  if (!name) return '';
  parsed.username = '';
  parsed.password = '';
  parsed.port = '8090';
  parsed.pathname = `/controls/${name}`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function applyCameraSettings(camera) {
  const settings = buildCameraSettings(camera);
  const payload = JSON.stringify(settings);
  writeStoredCameraSettings(camera, settings);
  if (lastSentCameraSettings[camera] === payload) return;

  const url = controlUrl(camera);
  if (!url) {
    showStatusMessage('Enter a stream URL first', 2000);
    return;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.status === 'error') {
      showStatusMessage(data.error || `Could not apply ${cameraName(camera)} settings`, 2500);
      return;
    }
    lastSentCameraSettings[camera] = payload;
    showStatusMessage(`${cameraName(camera)} settings applied`, 1000);
  } catch (error) {
    showStatusMessage(`Could not apply ${cameraName(camera)} settings`, 2500);
  }
}

async function syncCameraSettings(camera) {
  const url = controlUrl(camera);
  if (!url) return;
  if (hasStoredCameraSettings(camera)) {
    await applyCameraSettings(camera);
    return;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const config = await response.json();
    if (!config || config.status === 'error') return;
    adoptCameraConfig(camera, config);
    lastSentCameraSettings[camera] = JSON.stringify(buildCameraSettings(camera));
  } catch (error) {
    console.debug(`${camera} settings were not loaded`);
  }
}

renderCameraSettings('front');
renderCameraSettings('back');
bindSettingsResetDialog();
restoreCameraSettings('front');
restoreCameraSettings('back');

const CAMERA_NAMES_KEY = 'thermosquid.cameraNames';
const SESSION_STORAGE_KEY = 'thermosquid.session';
const NOTIFY_HOST_KEY = 'thermosquid.notifyHost';
const THERMOCOUPLE_KEY = 'thermosquid.thermocouples';
const THERMOCOUPLE_COUNT = 8;
const DEFAULT_CAMERA_NAMES = { front: 'Front', back: 'Back' };
const sessionState = {
  active: false,
  name: '',
  expected: 0,
  count: 0,
  startedAt: 0,
  timerId: null,
  entries: [],
  queue: [],
  delayMs: 0,
  intervalMs: 0,
  imageCount: 1,
  names: { front: DEFAULT_CAMERA_NAMES.front, back: DEFAULT_CAMERA_NAMES.back },
  frozenElapsed: 0,
  shotsCancelled: false,
  pendingShots: [],
  shotTimers: new Set(),
  captureChain: Promise.resolve(),
  exportColumns: null,
  dataCsv: '',
  dismissed: false
};
function isNotifyHost(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

function saveNotifyHost() {
  try {
    localStorage.setItem(NOTIFY_HOST_KEY, document.getElementById('session-device').value.trim());
  } catch (error) {
    console.debug('Device address was not stored');
  }
}

function restoreNotifyHost() {
  try {
    const stored = localStorage.getItem(NOTIFY_HOST_KEY);
    if (typeof stored === 'string') document.getElementById('session-device').value = stored;
  } catch (error) {
    console.debug('Device address was not restored');
  }
}

function notifyShot(count) {
  const deviceHost = document.getElementById('session-device').value.trim();
  if (!deviceHost) return;
  if (!isNotifyHost(deviceHost)) {
    showStatusMessage('Device IP is not valid', 2000);
    return;
  }
  if (!imageWs || imageWs.readyState !== WebSocket.OPEN) {
    showStatusMessage('Image service is not connected', 2000);
    return;
  }
  imageWs.send(JSON.stringify({ action: 'notify_device', host: deviceHost, shot: count }));
}

function notifyStatusText(message) {
  if (message === 'Device IP is not valid' || message === 'No temperature reading') return message;
  if (typeof message === 'string' && message.startsWith('Temperature reading was not valid')) return message;
  return 'Could not reach the device';
}

function normalizeShotTemperature(item) {
  if (item == null || item === '') return null;
  const value = Number(item);
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function normalizeReading(reading) {
  if (!reading || (typeof reading.at !== 'string' && typeof reading.at !== 'number') || !Array.isArray(reading.temperatures)) return null;
  const at = String(reading.at).trim();
  if (!at) return null;
  return {
    at,
    temperatures: reading.temperatures.slice(0, THERMOCOUPLE_COUNT).map(normalizeShotTemperature)
  };
}

function formatShotTemperature(value) {
  return Number(value).toFixed(1);
}

const MISSING_TEMPERATURE = '\u2014';

function storedThermocouples() {
  try {
    const saved = JSON.parse(localStorage.getItem(THERMOCOUPLE_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.filter((index) => Number.isInteger(index) && index >= 1 && index <= THERMOCOUPLE_COUNT))].sort((a, b) => a - b);
  } catch (error) {
    return [];
  }
}

function selectedThermocoupleIndexes() {
  const list = document.getElementById('session-thermocouple-list');
  const boxes = list ? [...list.querySelectorAll('input')] : [];
  if (!boxes.length) return storedThermocouples();
  return boxes.filter((box) => box.checked).map((box) => Number(box.value));
}

function saveThermocouples() {
  try {
    localStorage.setItem(THERMOCOUPLE_KEY, JSON.stringify(selectedThermocoupleIndexes()));
  } catch (error) {
    console.debug('Thermocouples were not stored');
  }
}

function renderThermocoupleChoices() {
  const list = document.getElementById('session-thermocouple-list');
  if (!list) return;
  const selected = new Set(list.querySelector('input') ? selectedThermocoupleIndexes() : storedThermocouples());
  for (let index = 1; index <= THERMOCOUPLE_COUNT; index += 1) {
    if (document.getElementById(`thermocouple-${index}`)) continue;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `thermocouple-${index}`;
    input.value = String(index);
    input.checked = selected.has(index);
    input.setAttribute('aria-label', `Thermocouple ${index}`);
    input.addEventListener('change', () => {
      saveThermocouples();
      renderSessionLog();
    });
    const name = document.createElement('span');
    name.textContent = `TC${index}`;
    label.append(input, name);
    list.append(label);
  }
  list.querySelectorAll('input').forEach((input) => {
    if (Number(input.value) > THERMOCOUPLE_COUNT && input.parentElement) input.parentElement.remove();
  });
}

function applyShotReading(shot, at, temperatures) {
  const reading = normalizeReading({ at, temperatures });
  if (!reading || !Number.isInteger(shot)) return false;
  const entry = sessionState.entries.find((item) => item.number === shot);
  if (!entry) return true;
  entry.reading = reading;
  renderThermocoupleChoices();
  renderSessionLog();
  persistSession();
  if (!sessionState.active && sessionState.exportColumns) saveSessionDataFile();
  return true;
}

function fileToken(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function cameraName(door) {
  const input = document.getElementById(`${door}-camera-name`);
  const value = input?.value?.trim();
  return value || DEFAULT_CAMERA_NAMES[door] || door;
}

function saveCameraNames() {
  try {
    localStorage.setItem(CAMERA_NAMES_KEY, JSON.stringify({
      front: document.getElementById('front-camera-name').value.trim() || DEFAULT_CAMERA_NAMES.front,
      back: document.getElementById('back-camera-name').value.trim() || DEFAULT_CAMERA_NAMES.back
    }));
  } catch (error) {
    console.debug('Camera names were not stored');
  }
}

function restoreCameraNames() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(CAMERA_NAMES_KEY) || '{}') || {};
  } catch (error) {
    stored = {};
  }
  document.getElementById('front-camera-name').value = typeof stored.front === 'string' && stored.front.trim()
    ? stored.front.trim()
    : DEFAULT_CAMERA_NAMES.front;
  document.getElementById('back-camera-name').value = typeof stored.back === 'string' && stored.back.trim()
    ? stored.back.trim()
    : DEFAULT_CAMERA_NAMES.back;
}

function secondsFieldValue(ms) {
  return String(Number((ms / 1000).toFixed(3)));
}

function serializeShot(job) {
  return {
    inputNumber: job.inputNumber,
    shotIndex: job.shotIndex,
    total: job.total,
    dueAt: job.dueAt,
    when: job.when instanceof Date ? job.when.getTime() : Number(job.when),
    sessionName: job.sessionName,
    names: {
      front: job.names?.front || DEFAULT_CAMERA_NAMES.front,
      back: job.names?.back || DEFAULT_CAMERA_NAMES.back
    }
  };
}

function persistSession() {
  try {
    if (sessionState.dismissed) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    const pendingShots = sessionState.pendingShots.map(serializeShot);
    if (!sessionState.active && !pendingShots.length) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      active: sessionState.active,
      name: sessionState.name,
      expected: sessionState.expected,
      count: sessionState.count,
      startedAt: sessionState.startedAt,
      entries: sessionState.entries,
      queue: sessionState.queue,
      delayMs: sessionState.delayMs,
      intervalMs: sessionState.intervalMs,
      imageCount: sessionState.imageCount,
      names: sessionState.names,
      frozenElapsed: sessionState.active ? 0 : sessionState.frozenElapsed,
      pendingShots
    }));
  } catch (error) {
    console.debug('Session was not stored');
  }
}

function savedSessionRecord() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || 'null');
    if (!saved || typeof saved.name !== 'string' || !saved.name.trim()) return null;
    if (!Number.isInteger(saved.expected) || saved.expected < 1 || saved.expected > 99) return null;
    if (!Number.isInteger(saved.count) || saved.count < 0 || saved.count > saved.expected) return null;
    if (!Number.isFinite(saved.startedAt) || saved.startedAt <= 0) return null;
    if (!Number.isFinite(saved.delayMs) || saved.delayMs < 0 || saved.delayMs > 3600000) return null;
    if (!Number.isFinite(saved.intervalMs) || saved.intervalMs < 0 || saved.intervalMs > 3600000) return null;
    if (!Number.isInteger(saved.imageCount) || saved.imageCount < 1 || saved.imageCount > 20) return null;
    if (!Array.isArray(saved.entries) || !Array.isArray(saved.queue) || !Array.isArray(saved.pendingShots)) return null;
    if (!saved.active && !saved.pendingShots.length) return null;
    return saved;
  } catch (error) {
    return null;
  }
}

function restoreSession() {
  const saved = savedSessionRecord();
  if (!saved) {
    try { localStorage.removeItem(SESSION_STORAGE_KEY); } catch (error) { /* ignore */ }
    updateSessionControls();
    return;
  }
  sessionState.active = Boolean(saved.active);
  sessionState.name = saved.name.trim();
  sessionState.expected = saved.expected;
  sessionState.count = saved.count;
  sessionState.startedAt = saved.startedAt;
  sessionState.delayMs = saved.delayMs;
  sessionState.intervalMs = saved.intervalMs;
  sessionState.imageCount = saved.imageCount;
  sessionState.frozenElapsed = Number.isFinite(saved.frozenElapsed) ? saved.frozenElapsed : 0;
  sessionState.shotsCancelled = false;
  sessionState.entries = saved.entries.filter((entry) => (
    Number.isInteger(entry?.number) && Number.isFinite(entry.elapsed) && Number.isFinite(entry.at)
  )).map((entry) => {
    const reading = normalizeReading(entry.reading);
    const next = { number: entry.number, elapsed: entry.elapsed, at: entry.at };
    if (reading) next.reading = reading;
    return next;
  });
  sessionState.queue = saved.queue.filter((at) => Number.isFinite(at));
  sessionState.names = {
    front: typeof saved.names?.front === 'string' && saved.names.front.trim() ? saved.names.front.trim() : cameraName('front'),
    back: typeof saved.names?.back === 'string' && saved.names.back.trim() ? saved.names.back.trim() : cameraName('back')
  };
  document.getElementById('session-name').value = sessionState.name;
  document.getElementById('session-input-count').value = String(sessionState.expected);
  document.getElementById('session-delay').value = secondsFieldValue(sessionState.delayMs);
  document.getElementById('session-image-count').value = String(sessionState.imageCount);
  document.getElementById('session-interval').value = secondsFieldValue(sessionState.intervalMs);
  document.getElementById('front-camera-name').value = sessionState.names.front;
  document.getElementById('back-camera-name').value = sessionState.names.back;
  saveCameraNames();
  renderThermocoupleChoices();
  renderSessionLog();
  updateSessionProgress();
  if (sessionState.active) {
    setSessionLocked(true);
    startSessionTimer();
  } else {
    setSessionLocked(false);
    document.getElementById('session-timer').textContent = formatElapsed(sessionState.frozenElapsed);
  }
  updateSessionControls();
  const pending = saved.pendingShots.filter((job) => (
    Number.isInteger(job?.inputNumber)
    && Number.isInteger(job.shotIndex)
    && Number.isInteger(job.total)
    && Number.isFinite(job.dueAt)
    && typeof job.sessionName === 'string'
  ));
  pending.forEach((job) => scheduleShot({
    inputNumber: job.inputNumber,
    shotIndex: job.shotIndex,
    total: job.total,
    dueAt: job.dueAt,
    when: new Date(job.when),
    sessionName: job.sessionName,
    names: {
      front: job.names?.front || sessionState.names.front,
      back: job.names?.back || sessionState.names.back
    }
  }));
  if (sessionState.active) drainSessionInputs();
}

function formatElapsed(ms) {
  const clamped = Math.max(0, ms);
  const totalTenths = Math.floor(clamped / 100);
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

function sessionImageBaseName(sessionName, cameraLabel, inputNumber, when, shotIndex, total) {
  const date = when instanceof Date ? when : new Date();
  const datePart = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}${String(date.getFullYear()).slice(-2)}`;
  const count = String(inputNumber).padStart(2, '0');
  const shot = total > 1 ? `--${String(shotIndex).padStart(2, '0')}` : '';
  let sessionToken = fileToken(sessionName, 'Session');
  let cameraToken = fileToken(cameraLabel, 'Camera');
  const fixed = datePart.length + count.length + shot.length + 6;
  const room = 80 - fixed;
  if (sessionToken.length + cameraToken.length > room) {
    sessionToken = sessionToken.slice(0, Math.max(1, room - 1));
    cameraToken = cameraToken.slice(0, Math.max(1, room - sessionToken.length));
  }
  return `${datePart}--${sessionToken}--${cameraToken}--${count}${shot}`;
}

function readSecondsField(id) {
  const value = document.getElementById(id).valueAsNumber;
  if (!Number.isFinite(value) || value < 0 || value > 3600) return null;
  return Math.round(value * 1000);
}

function readImageCount() {
  const value = document.getElementById('session-image-count').valueAsNumber;
  if (!Number.isInteger(value) || value < 1 || value > 20) return null;
  return value;
}

function readExpectedInputs() {
  const raw = document.getElementById('session-input-count').value.trim();
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (value < 1 || value > 99) return null;
  return value;
}

function setSessionLocked(locked) {
  document.getElementById('session-name').disabled = locked;
  document.getElementById('session-input-count').disabled = locked;
  document.getElementById('session-delay').disabled = locked;
  document.getElementById('session-image-count').disabled = locked;
  document.getElementById('session-interval').disabled = locked;
  document.getElementById('front-camera-name').disabled = locked;
  document.getElementById('back-camera-name').disabled = locked;
}

function updateSessionControls() {
  const active = sessionState.active;
  const started = sessionState.startedAt > 0;
  document.getElementById('session-bar').classList.toggle('is-running', active);
  document.getElementById('session-input').hidden = !active;
  document.getElementById('session-live').hidden = !started;
  document.getElementById('session-side').hidden = !started;
  const finished = started && !active;
  const archiveButton = document.getElementById('session-archive');
  const deleteButton = document.getElementById('session-delete');
  archiveButton.hidden = !finished;
  deleteButton.hidden = !finished;
  archiveButton.title = finished ? 'Keep the images and shot data, and clear this session' : '';
  deleteButton.title = finished ? 'Delete the images and shot data, and clear this session' : '';
  if (finished) deleteButton.disabled = false;
  const exportData = document.getElementById('session-export');
  const canExport = !active && sessionState.entries.length > 0;
  exportData.disabled = !canExport;
  exportData.title = active
    ? 'Available after the session ends'
    : (canExport ? 'Download the session images and shot data' : 'No shot data to export');
  const start = document.getElementById('session-start');
  const icon = start.querySelector('i');
  const label = start.querySelector('span');
  const nameOk = Boolean(fileToken(document.getElementById('session-name').value, ''));
  const imageCount = readImageCount();
  const intervalApplies = imageCount != null && imageCount >= 2;
  const intervalInput = document.getElementById('session-interval');
  intervalInput.disabled = active || !intervalApplies;
  intervalInput.title = !active && !intervalApplies ? 'Available when taking 2 or more images' : '';
  const timingOk = readSecondsField('session-delay') != null
    && imageCount != null
    && (!intervalApplies || readSecondsField('session-interval') != null);
  if (active) {
    start.disabled = false;
    start.classList.add('is-stop');
    if (icon) icon.className = 'fa-solid fa-stop';
    if (label) label.textContent = 'Stop';
    start.setAttribute('aria-label', 'Stop session');
  } else {
    start.classList.remove('is-stop');
    if (icon) icon.className = 'fa-solid fa-play';
    if (label) label.textContent = 'Start';
    start.setAttribute('aria-label', 'Start session');
    start.disabled = !nameOk || readExpectedInputs() == null || !timingOk;
  }
}

function updateSessionProgress() {
  document.getElementById('session-progress').textContent = `${sessionState.count} of ${sessionState.expected}`;
}

function renderSessionLog() {
  const list = document.getElementById('session-log');
  const selected = selectedThermocoupleIndexes();
  if (!sessionState.entries.length) {
    list.replaceChildren();
    return;
  }
  const table = document.createElement('table');
  table.style.setProperty('--session-temp-cols', String(selected.length));
  const headRow = document.createElement('tr');
  ['Shot', 'Time', ...selected.map((index) => `TC${index}`)].forEach((label) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  });
  const head = document.createElement('thead');
  head.append(headRow);
  const body = document.createElement('tbody');
  sessionState.entries.forEach((entry) => {
    const row = document.createElement('tr');
    row.dataset.wallClock = String(entry.at);
    row.title = new Date(entry.at).toLocaleTimeString();
    if (entry.reading) row.title += ` · ${entry.reading.at}`;
    const count = document.createElement('td');
    count.className = 'session-log-count';
    count.textContent = String(entry.number).padStart(2, '0');
    const time = document.createElement('td');
    time.className = 'session-log-time';
    time.textContent = `${formatElapsed(entry.elapsed)}`;
    row.append(count, time);
    const temperatures = entry.reading && entry.reading.temperatures;
    selected.forEach((index) => {
      const temp = document.createElement('td');
      temp.className = 'session-log-temp';
      const value = Array.isArray(temperatures) ? temperatures[index - 1] : null;
      temp.textContent = Number.isFinite(value) ? `${formatShotTemperature(value)}°C` : MISSING_TEMPERATURE;
      row.append(temp);
    });
    body.append(row);
  });
  table.append(head, body);
  list.replaceChildren(table);
}

function csvCell(value) {
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function sessionStartedLabel() {
  const when = new Date(sessionState.startedAt);
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  return `Session started ${stamp}`;
}

function buildSessionCsv() {
  if (!sessionState.entries.length || !sessionState.startedAt) return '';
  const columns = sessionState.exportColumns || selectedThermocoupleIndexes();
  const headers = ['Shot', 'Time', ...columns.map((index) => `TC${index}`), sessionStartedLabel()];
  const rows = [headers];
  sessionState.entries.forEach((entry) => {
    const temperatures = entry.reading && entry.reading.temperatures;
    rows.push([
      String(entry.number).padStart(2, '0'),
      formatElapsed(entry.elapsed),
      ...columns.map((index) => {
        const value = Array.isArray(temperatures) ? temperatures[index - 1] : null;
        return Number.isFinite(value) ? formatShotTemperature(value) : MISSING_TEMPERATURE;
      })
    ]);
  });
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

function sessionDataIdentity() {
  const when = new Date(sessionState.startedAt);
  const datePart = `${String(when.getMonth() + 1).padStart(2, '0')}${String(when.getDate()).padStart(2, '0')}${String(when.getFullYear()).slice(-2)}`;
  const cameraLabel = sessionState.names && sessionState.names.front
    ? sessionState.names.front
    : DEFAULT_CAMERA_NAMES.front;
  const sample = sessionImageBaseName(sessionState.name, cameraLabel, 1, when, 1, 1);
  const prefix = `${datePart}--`;
  let sessionToken = fileToken(sessionState.name, 'Session');
  if (sample.startsWith(prefix) && sample.endsWith('--01')) {
    const middle = sample.slice(prefix.length, sample.length - 4);
    const splitAt = middle.lastIndexOf('--');
    if (splitAt > 0) sessionToken = middle.slice(0, splitAt);
  }
  return {
    key: `${datePart}--${sessionToken}`,
    fileBase: `${datePart}--${sessionToken}--shot-data`
  };
}

function saveSessionDataFile() {
  if (!sessionState.entries.length) return;
  const csv = buildSessionCsv();
  if (!csv) return;
  sessionState.dataCsv = csv;
  const { fileBase } = sessionDataIdentity();
  if (!imageWs || imageWs.readyState !== WebSocket.OPEN) {
    showStatusMessage('Image service is not connected', 2000);
    return;
  }
  imageWs.send(JSON.stringify({
    action: 'save_session_data',
    fileName: fileBase,
    csv
  }));
}

function listedFileName(img) {
  if (img && img.name) return String(img.name);
  const imagePath = String(img && img.path || '');
  return decodeURIComponent(imagePath.split('/').pop() || imagePath);
}

function listedSessionKey(fileName) {
  const base = String(fileName).replace(/\.(jpe?g|png)$/i, '');
  const match = base.match(/^(\d{6})--(.+?)--(.+?)--(\d{2})(?:--(\d{2}))?$/);
  if (!match) return '';
  return `${match[1]}--${match[2]}`;
}

function listedSessionDataKey(fileName) {
  const match = String(fileName).match(/^(\d{6})--([A-Za-z0-9][A-Za-z0-9_-]{0,80})--shot-data\.(?:txt|csv)$/i);
  if (!match) return '';
  return `${match[1]}--${match[2]}`;
}

function compareListedImages(a, b) {
  const rank = (img) => {
    const base = listedFileName(img).replace(/\.(jpe?g|png)$/i, '');
    const match = base.match(/^(\d{6})--(.+?)--(.+?)--(\d{2})(?:--(\d{2}))?$/);
    return {
      count: match ? match[4] : '99',
      shot: match && match[5] ? match[5] : ''
    };
  };
  const left = rank(a);
  const right = rank(b);
  const count = left.count.localeCompare(right.count);
  if (count) return count;
  const shot = left.shot.localeCompare(right.shot);
  if (shot) return shot;
  if (a.door === b.door) return 0;
  return a.door === 'front' ? -1 : 1;
}

async function exportSessionData() {
  if (sessionState.active || !sessionState.entries.length) return;
  const button = document.getElementById('session-export');
  if (!imageWs || imageWs.readyState !== WebSocket.OPEN) {
    showStatusMessage('Image service is not connected', 2000);
    return;
  }
  if (button) button.disabled = true;
  try {
    const listed = await requestImageList();
    const { key, fileBase } = sessionDataIdentity();
    const dataName = `${fileBase}.txt`;
    const photos = listed.filter((img) => {
      const name = listedFileName(img);
      return /\.(jpe?g|png)$/i.test(name) && listedSessionKey(name) === key;
    }).sort(compareListedImages);
    const saved = listed.find((img) => listedFileName(img).toLowerCase() === dataName.toLowerCase());
    let csvBytes = null;
    if (saved && saved.path) {
      const response = await fetch(saved.path);
      if (response.ok) csvBytes = new Uint8Array(await response.arrayBuffer());
    }
    if (!csvBytes && sessionState.dataCsv) csvBytes = new TextEncoder().encode(sessionState.dataCsv);
    if (!csvBytes) throw new Error('missing data');
    const used = new Set([dataName]);
    const files = [{ name: dataName, data: csvBytes }];
    for (const img of photos) {
      const response = await fetch(img.path);
      if (!response.ok) throw new Error(listedFileName(img));
      let name = listedFileName(img);
      if (used.has(name)) name = `${img.door || 'image'}-${name}`;
      used.add(name);
      files.push({ name, data: new Uint8Array(await response.arrayBuffer()) });
    }
    const blob = new Blob([zipStored(files)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${key}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (error) {
    showStatusMessage('Could not export the session', 2000);
  } finally {
    updateSessionControls();
  }
}

function stopSessionTimer() {
  clearInterval(sessionState.timerId);
  sessionState.timerId = null;
}

function startSessionTimer() {
  stopSessionTimer();
  const timer = document.getElementById('session-timer');
  const tick = () => {
    timer.textContent = formatElapsed(Date.now() - sessionState.startedAt);
  };
  tick();
  sessionState.timerId = setInterval(tick, 100);
}

function cancelPendingShots() {
  sessionState.shotsCancelled = true;
  sessionState.shotTimers.forEach((timer) => clearTimeout(timer));
  sessionState.shotTimers.clear();
  sessionState.pendingShots = [];
}

function clearSessionResults() {
  sessionState.dismissed = true;
  sessionState.active = false;
  sessionState.queue.length = 0;
  sessionState.entries = [];
  sessionState.count = 0;
  sessionState.startedAt = 0;
  sessionState.frozenElapsed = 0;
  sessionState.exportColumns = null;
  sessionState.dataCsv = '';
  sessionState.pendingShots = [];
  stopSessionTimer();
  document.getElementById('session-timer').textContent = '0:00.0';
  renderSessionLog();
  updateSessionProgress();
  updateSessionControls();
  persistSession();
}

function archiveSessionResults() {
  if (sessionState.active || !(sessionState.startedAt > 0)) return;
  clearSessionResults();
  showStatusMessage('Session kept in the gallery', 2000);
}

async function deleteSessionResults() {
  if (sessionState.active || !(sessionState.startedAt > 0)) return;
  const name = String(sessionState.name || '').trim() || 'this session';
  if (!window.confirm(`Delete the images and shot data for ${name}?`)) return;
  if (!imageWs || imageWs.readyState !== WebSocket.OPEN) {
    showStatusMessage('Image service is not connected', 2000);
    return;
  }
  const deleteButton = document.getElementById('session-delete');
  if (deleteButton) deleteButton.disabled = true;
  const { key } = sessionDataIdentity();
  sessionState.exportColumns = null;
  cancelPendingShots();
  try {
    await sessionState.captureChain;
    const listed = await requestImageList();
    listed.filter((img) => {
      const fileName = listedFileName(img);
      return listedSessionKey(fileName) === key || listedSessionDataKey(fileName) === key;
    }).forEach((img) => {
      imageWs.send(JSON.stringify({
        action: 'delete_image',
        door: img.door,
        timestamp: img.timestamp,
        path: img.path
      }));
    });
    clearSessionResults();
    showStatusMessage('Session deleted', 2000);
  } catch (error) {
    showStatusMessage('Could not delete the session', 2000);
    updateSessionControls();
  }
}

function endSession(elapsedMs, cancelShots) {
  if (!sessionState.active) return;
  sessionState.active = false;
  sessionState.queue.length = 0;
  if (cancelShots) cancelPendingShots();
  stopSessionTimer();
  const elapsed = elapsedMs == null ? Date.now() - sessionState.startedAt : elapsedMs;
  sessionState.frozenElapsed = elapsed;
  document.getElementById('session-timer').textContent = formatElapsed(elapsed);
  setSessionLocked(false);
  updateSessionControls();
  persistSession();
  if (sessionState.entries.length) {
    sessionState.exportColumns = selectedThermocoupleIndexes().slice();
    saveSessionDataFile();
  }
}

function startSession() {
  const name = document.getElementById('session-name').value.trim();
  const expected = readExpectedInputs();
  const delayMs = readSecondsField('session-delay');
  const imageCount = readImageCount();
  const intervalMs = imageCount != null && imageCount >= 2 ? readSecondsField('session-interval') : 0;
  if (!fileToken(name, '') || expected == null || delayMs == null || intervalMs == null || imageCount == null || sessionState.active) return;
  sessionState.active = true;
  sessionState.dismissed = false;
  sessionState.shotsCancelled = false;
  sessionState.name = name;
  sessionState.expected = expected;
  sessionState.delayMs = delayMs;
  sessionState.intervalMs = intervalMs;
  sessionState.imageCount = imageCount;
  sessionState.count = 0;
  sessionState.startedAt = Date.now();
  sessionState.entries = [];
  sessionState.queue = [];
  sessionState.exportColumns = null;
  sessionState.dataCsv = '';
  sessionState.names = { front: cameraName('front'), back: cameraName('back') };
  sessionState.frozenElapsed = 0;
  renderSessionLog();
  updateSessionProgress();
  setSessionLocked(true);
  updateSessionControls();
  document.getElementById('session-timer').textContent = '0:00.0';
  startSessionTimer();
  persistSession();
  const names = sessionState.names;
  runCapture({
    inputNumber: 0,
    shotIndex: 1,
    total: 1,
    when: new Date(sessionState.startedAt),
    sessionName: name,
    names
  });
}

function recordSessionInput() {
  if (!sessionState.active) return;
  if (sessionState.count + sessionState.queue.length >= sessionState.expected) return;
  sessionState.queue.push(Date.now());
  drainSessionInputs();
}

async function captureSessionPair(job) {
  await Promise.all(['front', 'back'].map(async (door) => {
    const lastImage = lastCapturedImages[door];
    const videoStream = door === 'front' ? frontVideoStream : backVideoStream;
    const timestampCheckbox = door === 'front' ? frontTimestampCheckbox : backTimestampCheckbox;
    const baseName = sessionImageBaseName(job.sessionName, job.names[door], job.inputNumber, job.when, job.shotIndex, job.total);
    if (sessionState.shotsCancelled) return;
    if (!lastImage || !lastImage.image || lastImage.frames === 0 || !videoStream || !imageWs || imageWs.readyState !== WebSocket.OPEN) {
      showCaptureConfirm(door, '', false);
      return;
    }
    try {
      const imageData = await getTimestampedImage(videoStream, door, lastImage.timestamp, timestampCheckbox);
      sendSaveImage(door, imageData, '', baseName);
    } catch (error) {
      console.error('Session capture error:', error);
      showCaptureConfirm(door, '', false);
    }
  }));
}

function runCapture(job) {
  sessionState.captureChain = sessionState.captureChain.then(() => captureSessionPair(job)).catch((error) => {
    console.error('Session capture error:', error);
  });
}

function scheduleShot(job) {
  sessionState.pendingShots.push(job);
  persistSession();
  const wait = Math.max(0, job.dueAt - Date.now());
  const timer = setTimeout(() => {
    sessionState.shotTimers.delete(timer);
    const index = sessionState.pendingShots.indexOf(job);
    if (index >= 0) sessionState.pendingShots.splice(index, 1);
    persistSession();
    if (sessionState.shotsCancelled) return;
    runCapture(job);
  }, wait);
  sessionState.shotTimers.add(timer);
}

function scheduleBurst(inputNumber, detectedAt) {
  const names = { front: cameraName('front'), back: cameraName('back') };
  const total = sessionState.imageCount;
  for (let shot = 1; shot <= total; shot++) {
    scheduleShot({
      inputNumber,
      shotIndex: shot,
      total,
      dueAt: detectedAt + sessionState.delayMs + (shot - 1) * sessionState.intervalMs,
      when: new Date(detectedAt),
      sessionName: sessionState.name,
      names
    });
  }
}

function drainSessionInputs() {
  while (sessionState.active && sessionState.queue.length && sessionState.count < sessionState.expected) {
    const at = sessionState.queue.shift();
    const elapsed = at - sessionState.startedAt;
    sessionState.count += 1;
    const inputNumber = sessionState.count;
    sessionState.entries.push({ number: inputNumber, elapsed, at });
    renderSessionLog();
    updateSessionProgress();
    notifyShot(inputNumber);
    scheduleBurst(inputNumber, at);
    if (sessionState.count >= sessionState.expected) endSession(elapsed, false);
  }
  if (sessionState.active) persistSession();
}

function initSessionUi() {
  restoreCameraNames();
  restoreNotifyHost();
  renderThermocoupleChoices();
  const device = document.getElementById('session-device');
  device.addEventListener('input', saveNotifyHost);
  device.addEventListener('change', saveNotifyHost);
  ['front', 'back'].forEach((door) => {
    const input = document.getElementById(`${door}-camera-name`);
    input.addEventListener('input', saveCameraNames);
    input.addEventListener('change', () => {
      if (!input.value.trim()) input.value = DEFAULT_CAMERA_NAMES[door];
      saveCameraNames();
      if (currentModalCamera === door) {
        const title = document.getElementById('modal-camera-title');
        if (title) title.textContent = cameraName(door);
      }
    });
  });
  ['session-name', 'session-input-count', 'session-delay', 'session-image-count', 'session-interval'].forEach((id) => {
    document.getElementById(id).addEventListener('input', updateSessionControls);
  });
  document.getElementById('session-start').addEventListener('click', () => {
    if (sessionState.active) endSession(undefined, true);
    else startSession();
  });
  document.getElementById('session-input').addEventListener('click', recordSessionInput);
  document.getElementById('session-export').addEventListener('click', exportSessionData);
  document.getElementById('session-archive').addEventListener('click', archiveSessionResults);
  document.getElementById('session-delete').addEventListener('click', () => {
    deleteSessionResults();
  });
  restoreSession();
}

initSessionUi();
window.addEventListener('beforeunload', () => {
  navigator.sendBeacon?.('/api/camera/stop', '');
});