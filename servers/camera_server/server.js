const WebSocket = require('ws');
const { spawn } = require('child_process');

const RESOLUTIONS = new Set(['640x480', '1280x720', '1920x1080', '1536x864']);
const FRAME_RATES = new Set([10, 15, 30, 60]);
const METERING_MODES = new Set(['centre', 'spot', 'average', 'matrix', 'custom']);
const EXPOSURE_MODES = new Set(['normal', 'sport', 'short', 'long']);
// rpicam-vid rejects "off". Manual white balance is a valid mode plus non-zero gains.
const AWB_MODES = new Set(['auto', 'incandescent', 'tungsten', 'fluorescent', 'indoor', 'daylight', 'cloudy', 'custom']);
const DENOISE_MODES = new Set(['auto', 'off', 'cdn_off', 'cdn_fast', 'cdn_hq']);

const defaultConfig = {
  width: 1536, height: 864, framerate: 30,
  brightness: 0, contrast: 1, sharpness: 1, saturation: 1,
  ev: 0, shutter: 0, gain: 0,
  metering: 'centre', exposure: 'normal', awb: 'auto',
  awb_red: 1, awb_blue: 1, denoise: 'auto'
};

function finiteNumber(value, fallback) {
  const number = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pick(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function sanitizeConfig(input, previous) {
  const width = parseInt(input.width, 10);
  const height = parseInt(input.height, 10);
  const resolution = `${width}x${height}`;
  const framerate = parseInt(input.framerate, 10);
  let denoise = pick(input.denoise, DENOISE_MODES, previous.denoise);
  // High-quality colour denoise is not usable on the live video path.
  // At 1536x864 it stalls the ISP until rpicam-vid aborts.
  if (denoise === 'cdn_hq') denoise = 'cdn_fast';

  const awb = input.awb || previous.awb;
  let awbRed = finiteNumber(input.awb_red, previous.awb_red);
  let awbBlue = finiteNumber(input.awb_blue, previous.awb_blue);
  if (awb === 'off') {
    awbRed = clamp(awbRed > 0 ? awbRed : 1, 0.1, 8);
    awbBlue = clamp(awbBlue > 0 ? awbBlue : 1, 0.1, 8);
  }

  return {
    width: RESOLUTIONS.has(resolution) ? width : previous.width,
    height: RESOLUTIONS.has(resolution) ? height : previous.height,
    framerate: FRAME_RATES.has(framerate) ? framerate : previous.framerate,
    brightness: clamp(finiteNumber(input.brightness, previous.brightness), -1, 1),
    contrast: clamp(finiteNumber(input.contrast, previous.contrast), 0, 32),
    sharpness: clamp(finiteNumber(input.sharpness, previous.sharpness), 0, 16),
    saturation: clamp(finiteNumber(input.saturation, previous.saturation), 0, 32),
    ev: clamp(Math.round(finiteNumber(input.ev, previous.ev)), -8, 8),
    shutter: Math.max(0, Math.round(finiteNumber(input.shutter, previous.shutter))),
    gain: clamp(finiteNumber(input.gain, previous.gain), 0, 32),
    metering: pick(input.metering, METERING_MODES, previous.metering),
    exposure: pick(input.exposure, EXPOSURE_MODES, previous.exposure),
    awb: awb === 'off' || AWB_MODES.has(awb) ? awb : previous.awb,
    awb_red: awbRed,
    awb_blue: awbBlue,
    denoise
  };
}

function buildVidArgs(config, camIndex) {
  const awbMode = config.awb === 'off' ? 'auto' : config.awb;
  const vidArgs = [
    '--camera', camIndex,
    '-n',
    '--codec', 'yuv420',
    '--width', String(config.width),
    '--height', String(config.height),
    '--framerate', String(config.framerate),
    '--brightness', String(config.brightness),
    '--contrast', String(config.contrast),
    '--sharpness', String(config.sharpness),
    '--saturation', String(config.saturation),
    '--ev', String(config.ev),
    '--metering', config.metering,
    '--exposure', config.exposure,
    '--awb', awbMode,
    '--denoise', config.denoise,
    '--timeout', '0',
    '--no-raw',
    '--output', '-'
  ];

  if (config.shutter > 0) {
    // Exposure must stay inside this frame. A longer shutter is rejected and aborts rpicam-vid.
    const frameUs = Math.round(1000000 / config.framerate);
    const shutter = clamp(config.shutter, 100, Math.max(100, frameUs - 1000));
    vidArgs.push('--shutter', String(shutter));
  }
  // Analogue gain below 1 is outside the sensor range and aborts rpicam-vid.
  if (config.gain >= 1) {
    vidArgs.push('--gain', String(config.gain));
  }
  if (config.awb === 'off') {
    vidArgs.push('--awbgains', `${config.awb_red},${config.awb_blue}`);
  }
  return vidArgs;
}

function safeKill(proc) {
  if (!proc || proc.killed || proc.exitCode !== null || proc.signalCode !== null) return;
  if (proc.listenerCount('error') === 0) {
    proc.on('error', () => {});
  }
  try {
    proc.kill('SIGKILL');
  } catch (err) {
    console.error('Failed to stop camera process:', err.message);
  }
}

function createPipeline(name, camIndex, port) {
  const pipeline = {
    name,
    camIndex,
    clients: new Set(),
    config: { ...defaultConfig },
    proc: null,
    ffmpeg: null,
    generation: 0,
    startTimer: null
  };

  function stopPipeline() {
    pipeline.generation += 1;
    if (pipeline.startTimer) {
      clearTimeout(pipeline.startTimer);
      pipeline.startTimer = null;
    }
    const proc = pipeline.proc;
    const ffmpeg = pipeline.ffmpeg;
    pipeline.proc = null;
    pipeline.ffmpeg = null;
    safeKill(proc);
    safeKill(ffmpeg);
  }

  function spawnPipeline(generation) {
    if (generation !== pipeline.generation || pipeline.clients.size === 0) return;

    const config = pipeline.config;
    const proc = spawn('rpicam-vid', buildVidArgs(config, camIndex));
    const ffmpeg = spawn('ffmpeg', [
      '-f', 'rawvideo',
      '-pixel_format', 'yuv420p',
      '-video_size', `${config.width}x${config.height}`,
      '-framerate', String(config.framerate),
      '-use_wallclock_as_timestamps', '1',
      '-fflags', '+nobuffer+genpts+discardcorrupt',
      '-i', 'pipe:0',
      '-f', 'mjpeg',
      '-q:v', '3',
      '-vsync', 'cfr',
      '-r', String(config.framerate),
      '-'
    ]);

    pipeline.proc = proc;
    pipeline.ffmpeg = ffmpeg;

    proc.on('error', (err) => console.error(`${name} rpicam-vid error:`, err.message));
    ffmpeg.on('error', (err) => console.error(`${name} ffmpeg error:`, err.message));
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    ffmpeg.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') console.error(`${name} pipe error:`, err.message);
    });
    ffmpeg.stdout.on('error', () => {});
    ffmpeg.stderr.on('error', () => {});
    ffmpeg.stderr.on('data', () => {});

    proc.stdout.pipe(ffmpeg.stdin);

    let buffer = Buffer.alloc(0);
    const maxBuffer = 2 * 1024 * 1024;
    ffmpeg.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBuffer) buffer = chunk;

      while (true) {
        const start = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
        if (start === -1) break;
        const end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
        if (end === -1) break;

        const frame = buffer.subarray(start, end + 2);
        pipeline.clients.forEach((ws) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            ws.send(frame, { binary: true });
          } catch (err) {
            console.error(`${name} send error:`, err.message);
          }
        });
        buffer = buffer.subarray(end + 2);
      }
    });

    proc.stderr.on('data', (data) => console.error(`${name} vid stderr:`, data.toString().trim()));

    proc.on('close', (code, signal) => {
      console.log(`${name} rpicam-vid exited with code ${code} signal ${signal}`);
      if (pipeline.proc === proc) pipeline.proc = null;
    });
    ffmpeg.on('close', (code, signal) => {
      console.log(`${name} ffmpeg exited with code ${code} signal ${signal}`);
      if (pipeline.ffmpeg === ffmpeg) pipeline.ffmpeg = null;
    });

    console.log(`[startCamera] ${name} started (${config.width}x${config.height} @ ${config.framerate}, denoise=${config.denoise}, awb=${config.awb})`);
  }

  function startCamera() {
    console.log(`[startCamera] Restarting ${name} (brightness=${pipeline.config.brightness})...`);
    stopPipeline();
    const generation = pipeline.generation;
    pipeline.startTimer = setTimeout(() => {
      pipeline.startTimer = null;
      spawnPipeline(generation);
    }, 1000);
  }

  const wsServer = new WebSocket.Server({ port });
  wsServer.on('connection', (ws) => {
    console.log(`${name} client connected`);
    pipeline.clients.add(ws);
    startCamera();

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.action !== 'set_config') return;
        console.log(`[SETTINGS] Received from ${name}:`, data);
        pipeline.config = sanitizeConfig(data, pipeline.config);
        startCamera();
      } catch (err) {
        console.error('Message error:', err);
      }
    });

    ws.on('close', () => {
      pipeline.clients.delete(ws);
      if (pipeline.clients.size === 0) stopPipeline();
    });
  });

  return pipeline;
}

if (require.main === module) {
  createPipeline('camera1', '0', 8081);
  createPipeline('camera2', '1', 8082);
  console.log('Camera servers ready');
}

module.exports = { sanitizeConfig, buildVidArgs };
