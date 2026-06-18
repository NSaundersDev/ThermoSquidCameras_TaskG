const WebSocket = require('ws');
const { spawn } = require('child_process');
const frontCameraWs = new WebSocket.Server({ port: 8081 });
const backCameraWs = new WebSocket.Server({ port: 8082 });
const frontClients = new Set();
const backClients = new Set();
let frontProcess = null;
let backProcess = null;
let frontFfmpeg = null;
let backFfmpeg = null;
let frontConfig = {
  width: 1536, height: 864, framerate: 30,
  brightness: 0, contrast: 1, sharpness: 1, saturation: 1,
  ev: 0, shutter: 0, gain: 0,
  metering: 'centre', exposure: 'normal', awb: 'auto',
  awb_red: 0, awb_blue: 0, denoise: 'auto'
};
let backConfig = { ...frontConfig };
function startCamera(camera) {
  const clients = camera === 'front' ? frontClients : backClients;
  const config = camera === 'front' ? frontConfig : backConfig;
  const camIndex = camera === 'front' ? '0' : '1';
  // Kill old processes
  if (camera === 'front') {
    if (frontProcess) frontProcess.kill();
    if (frontFfmpeg) frontFfmpeg.kill();
  } else {
    if (backProcess) backProcess.kill();
    if (backFfmpeg) backFfmpeg.kill();
  }
  const vidArgs = [
    '--camera', camIndex,
    '-n',
    '--codec', 'yuv420',
    '--width', config.width.toString(),
    '--height', config.height.toString(),
    '--framerate', config.framerate.toString(),
    '--brightness', config.brightness.toString(),
    '--contrast', config.contrast.toString(),
    '--sharpness', config.sharpness.toString(),
    '--saturation', config.saturation.toString(),
    '--ev', config.ev.toString(),
    '--shutter', config.shutter.toString(),
    '--gain', config.gain.toString(),
    '--metering', config.metering,
    '--exposure', config.exposure,
    '--awb', config.awb,
    '--denoise', config.denoise,
    '--timeout', '0',
    '--output', '-'
  ];
  // Conditional: Only add gains if AWB is off (per docs)
  if (config.awb === 'off') {
    vidArgs.push('--awbgains', `${config.awb_red},${config.awb_blue}`);
  }
  console.log(`${camera} starting with args:`, vidArgs);  // Log for debugging
  const proc = spawn('rpicam-vid', vidArgs);
  const ffmpegArgs = [
    '-f', 'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size', `${config.width}x${config.height}`,
    '-framerate', config.framerate.toString(),
    '-i', 'pipe:0',
    '-f', 'mjpeg',
    '-q:v', '3',
    '-'
  ];
  const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
  proc.stdout.pipe(ffmpegProc.stdin);
  let buffer = Buffer.alloc(0);
  const MAX_BUFFER = 2 * 1024 * 1024; // 2MB buffer
  ffmpegProc.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER) {
      console.warn(`${camera} buffer overflow, dropping old data`);
      buffer = chunk;
    }
    while (true) {
      const start = buffer.indexOf(Buffer.from([0xFF, 0xD8]));
      if (start === -1) break;
      const end = buffer.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
      if (end === -1) break;
      const frame = buffer.subarray(start, end + 2);
      clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
      });
      buffer = buffer.subarray(end + 2);
    }
  });
  proc.stderr.on('data', data => console.error(`${camera} vid err:`, data.toString()));
  ffmpegProc.stderr.on('data', data => console.error(`${camera} ffmpeg err:`, data.toString()));
  proc.on('close', code => {
    console.log(`${camera} vid closed (${code})`);
    if (camera === 'front') frontProcess = null;
    else backProcess = null;
  });
  ffmpegProc.on('close', code => {
    console.log(`${camera} ffmpeg closed (${code})`);
    if (camera === 'front') frontFfmpeg = null;
    else backFfmpeg = null;
  });
  if (camera === 'front') {
    frontProcess = proc;
    frontFfmpeg = ffmpegProc;
  } else {
    backProcess = proc;
    backFfmpeg = ffmpegProc;
  }
}
function setup(wsServer, camera) {
  wsServer.on('connection', ws => {
    console.log(`${camera} connected`);
    const clients = camera === 'front' ? frontClients : backClients;
    clients.add(ws);
    startCamera(camera);
    ws.on('message', msg => {
      try {
        const data = JSON.parse(msg);
        if (data.action === 'set_config') {
          const config = camera === 'front' ? frontConfig : backConfig;
          Object.assign(config, {
            width: parseInt(data.width) || config.width,
            height: parseInt(data.height) || config.height,
            framerate: parseInt(data.framerate) || config.framerate,
            brightness: parseFloat(data.brightness) ?? config.brightness,
            contrast: parseFloat(data.contrast) ?? config.contrast,
            sharpness: parseFloat(data.sharpness) ?? config.sharpness,
            saturation: parseFloat(data.saturation) ?? config.saturation,
            ev: parseInt(data.ev) ?? config.ev,
            shutter: parseInt(data.shutter) ?? config.shutter,
            gain: parseFloat(data.gain) ?? config.gain,
            metering: data.metering || config.metering,
            exposure: data.exposure || config.exposure,
            awb: data.awb || config.awb,
            awb_red: parseFloat(data.awb_red) ?? config.awb_red,
            awb_blue: parseFloat(data.awb_blue) ?? config.awb_blue,
            denoise: data.denoise || config.denoise
          });
          console.log(`${camera} new config applied:`, config);
          startCamera(camera);
        }
      } catch (e) {
        console.error('Invalid config message:', e);
      }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (clients.size === 0) {
        if (camera === 'front') {
          if (frontProcess) frontProcess.kill();
          if (frontFfmpeg) frontFfmpeg.kill();
        } else {
          if (backProcess) backProcess.kill();
          if (backFfmpeg) backFfmpeg.kill();
        }
      }
    });
  });
}
setup(frontCameraWs, 'front');
setup(backCameraWs, 'back');
console.log('Servers ready (8081 front, 8082 back)');