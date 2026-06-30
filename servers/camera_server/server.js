const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;

const camera1Ws = new WebSocket.Server({ port: 8081 });
const camera2Ws = new WebSocket.Server({ port: 8082 });

const camera1Clients = new Set();
const camera2Clients = new Set();

let camera1Process = null;
let camera2Process = null;
let camera1Ffmpeg = null;
let camera2Ffmpeg = null;
let camera1Recorder = null;
let camera2Recorder = null;
let camera1RecVid = null;
let camera2RecVid = null;

const CLIPS_DIR = '/home/pi/git-repos/ThermoSquidCameras_TaskG/public/clips';

fs.mkdir(CLIPS_DIR, { recursive: true }).catch(err => console.error('Clips dir error:', err));

let camera1Config = {
  width: 1536, height: 864, framerate: 30,
  brightness: 0, contrast: 1, sharpness: 1, saturation: 1,
  ev: 0, shutter: 0, gain: 0,
  metering: 'centre', exposure: 'normal', awb: 'auto',
  awb_red: 0, awb_blue: 0, denoise: 'auto'
};

let camera2Config = { ...camera1Config };

function startCamera(camera) {
  const clients = camera === 'camera1' ? camera1Clients : camera2Clients;
  const config = camera === 'camera1' ? camera1Config : camera2Config;
  const camIndex = camera === 'camera1' ? '0' : '1';

  if (camera === 'camera1') {
    if (camera1Process) camera1Process.kill();
    if (camera1Ffmpeg) camera1Ffmpeg.kill();
  } else {
    if (camera2Process) camera2Process.kill();
    if (camera2Ffmpeg) camera2Ffmpeg.kill();
  }

  const vidArgs = [
    '--camera', camIndex,
    '-n',
    '--codec', 'yuv420',
    '--inline',
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

  if (config.awb === 'off') {
    vidArgs.push('--awbgains', `${config.awb_red},${config.awb_blue}`);
  }

  console.log(`${camera} starting live stream`);

  const proc = spawn('rpicam-vid', vidArgs);

  const ffmpegArgs = [
    '-f', 'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size', `${config.width}x${config.height}`,
    '-framerate', config.framerate.toString(),
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-i', 'pipe:0',
    '-f', 'mjpeg',
    '-q:v', '3',
    '-vsync', 'cfr',
    '-r', config.framerate.toString(),
    '-'
  ];

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs);
  proc.stdout.pipe(ffmpegProc.stdin);

  let buffer = Buffer.alloc(0);
  const MAX_BUFFER = 2 * 1024 * 1024;

  ffmpegProc.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_BUFFER) buffer = chunk;
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

  proc.stderr.on('data', d => console.error(`${camera} vid:`, d.toString()));
  // ffmpegProc.stderr.on('data', d => console.error(`${camera} ffmpeg:`, d.toString()));

  proc.on('close', () => { if (camera === 'camera1') camera1Process = null; else camera2Process = null; });
  ffmpegProc.on('close', () => { if (camera === 'camera1') camera1Ffmpeg = null; else camera2Ffmpeg = null; });

  if (camera === 'camera1') {
    camera1Process = proc;
    camera1Ffmpeg = ffmpegProc;
  } else {
    camera2Process = proc;
    camera2Ffmpeg = ffmpegProc;
  }
}

function startRecording(camera, filename = null) {
  const config = camera === 'camera1' ? camera1Config : camera2Config;
  const camIndex = camera === 'camera1' ? '0' : '1';

  const existing = camera === 'camera1' ? camera1Recorder : camera2Recorder;
  if (existing) {
    console.log(`${camera} already recording`);
    return;
  }

  // Stop live feed
  if (camera === 'camera1') {
    if (camera1Process) camera1Process.kill();
    if (camera1Ffmpeg) camera1Ffmpeg.kill();
    camera1Process = null;
    camera1Ffmpeg = null;
  } else {
    if (camera2Process) camera2Process.kill();
    if (camera2Ffmpeg) camera2Ffmpeg.kill();
    camera2Process = null;
    camera2Ffmpeg = null;
  }

  const vidArgs = [
    '--camera', camIndex,
    '-n',
    '--codec', 'yuv420',
    '--inline',
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

  if (config.awb === 'off') {
    vidArgs.push('--awbgains', `${config.awb_red},${config.awb_blue}`);
  }

  const proc = spawn('rpicam-vid', vidArgs);

  const safeName = filename || `${camera}_clip_${Date.now()}.mp4`;
  const outputPath = path.join(CLIPS_DIR, safeName);

  const recordArgs = [
    '-f', 'rawvideo',
    '-pixel_format', 'yuv420p',
    '-video_size', `${config.width}x${config.height}`,
    '-framerate', config.framerate.toString(),
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-r', config.framerate.toString(),
    '-movflags', '+faststart',
    outputPath
  ];

  const recorder = spawn('ffmpeg', recordArgs);
  proc.stdout.pipe(recorder.stdin);

  recorder.stderr.on('data', d => console.error(`${camera} recorder:`, d.toString()));
  proc.stderr.on('data', d => console.error(`${camera} rec-vid:`, d.toString()));

  recorder.on('close', (code) => {
    console.log(`${camera} recording finished (code ${code}): ${outputPath}`);
    if (camera === 'camera1') {
      camera1Recorder = null;
      camera1RecVid = null;
    } else {
      camera2Recorder = null;
      camera2RecVid = null;
    }
  });

  if (camera === 'camera1') {
    camera1Recorder = recorder;
    camera1RecVid = proc;
  } else {
    camera2Recorder = recorder;
    camera2RecVid = proc;
  }

  console.log(`${camera} recording started → ${outputPath}`);
}

function stopRecording(camera) {
  const rec = camera === 'camera1' ? camera1Recorder : camera2Recorder;
  const vid = camera === 'camera1' ? camera1RecVid : camera2RecVid;

  if (rec) rec.kill();
  if (vid) vid.kill();

  setTimeout(() => {
    startCamera(camera);
  }, 600);

  console.log(`${camera} recording stopped - live feed restarting`);
}

function setup(wsServer, camera) {
  wsServer.on('connection', ws => {
    console.log(`${camera} client connected`);
    const clients = camera === 'camera1' ? camera1Clients : camera2Clients;
    clients.add(ws);
    startCamera(camera);

    ws.on('message', msg => {
      try {
        const data = JSON.parse(msg);
        if (data.action === 'set_config') {
          const config = camera === 'camera1' ? camera1Config : camera2Config;
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
          startCamera(camera);
        } else if (data.action === 'start_record') {
          startRecording(camera, data.filename);
        } else if (data.action === 'stop_record') {
          stopRecording(camera);
        }
      } catch (e) {
        console.error('Message error:', e);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (clients.size === 0) {
        if (camera === 'camera1') {
          if (camera1Process) camera1Process.kill();
          if (camera1Ffmpeg) camera1Ffmpeg.kill();
          if (camera1Recorder) camera1Recorder.kill();
          if (camera1RecVid) camera1RecVid.kill();
        } else {
          if (camera2Process) camera2Process.kill();
          if (camera2Ffmpeg) camera2Ffmpeg.kill();
          if (camera2Recorder) camera2Recorder.kill();
          if (camera2RecVid) camera2RecVid.kill();
        }
      }
    });
  });
}

setup(camera1Ws, 'camera1');
setup(camera2Ws, 'camera2');

console.log('Camera servers ready');