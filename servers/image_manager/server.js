const WebSocket = require('ws');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const baseDir = path.join(repoRoot, 'public', 'images');
const cameraServerPath = path.join(repoRoot, 'servers', 'camera_server', 'server.js');
const app = express();

// One process serves both cameras. systemd normally starts it; these routes
// are the on-demand fallback used by the camera page.
let cameraProc = null;

app.post('/api/camera/start', (req, res) => {
  if (cameraProc && cameraProc.exitCode === null) {
    return res.json({ status: 'already_running' });
  }

  console.log('Starting camera server...');
  cameraProc = spawn(process.execPath, [cameraServerPath], {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(cameraServerPath)
  });
  setTimeout(() => {
    res.json({ status: 'started' });
  }, 1000);
});

app.post('/api/camera/stop', (req, res) => {
  let stopped = 0;
  if (cameraProc && cameraProc.exitCode === null) {
    cameraProc.kill('SIGTERM');
    stopped = 1;
  }
  cameraProc = null;
  res.json({ status: 'stopped', count: stopped });
});

const port = 3000;
app.use((req, res, next) => {
  console.log('Incoming request:', req.method, req.originalUrl);
  next();
});
async function ensureDir(door, date) {
  const dir = path.join(baseDir, door, date);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}


async function listImages(doorFilter = null, dateFilter = null) {
  const results = [];

  // === IMAGES from baseDir (front/back) - using actual file mtime ===
  const doorsToScan = (doorFilter && ['front', 'back'].includes(doorFilter))
    ? [doorFilter]
    : ['front', 'back'];

  for (const door of doorsToScan) {
    const doorPath = path.join(baseDir, door);

    let dateDirs = [];
    try {
      dateDirs = await fs.readdir(doorPath);
    } catch {
      continue;
    }

    for (const dateDir of dateDirs) {
      if (dateFilter && dateDir !== dateFilter) continue;

      const fullDatePath = path.join(doorPath, dateDir);
      let files = [];
      try {
        files = await fs.readdir(fullDatePath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.match(/\.(jpg|jpeg|png)$/i)) continue;

        const fullPath = path.join(fullDatePath, file);

        // Use actual file modification time
        let timestamp;
        try {
          const stats = await fs.stat(fullPath);
          timestamp = stats.mtimeMs;
        } catch {
          // Fallback to filename if stat fails
          const match = file.match(/^(\d+)-/);
          timestamp = match ? parseInt(match[1], 10) : Date.now();
        }

        if (isNaN(timestamp)) continue;

        results.push({
          door: door,
          timestamp,
          path: `/images/${door}/${dateDir}/${file}`,
          name: file,
          type: 'image'
        });
      }
    }
  }

  return results.sort((a, b) => b.timestamp - a.timestamp);
}
const wss = new WebSocket.Server({ server: app.listen(port, '0.0.0.0'), path: '/ws' });
wss.on('connection', (ws) => {
  console.log('Image Manager client connected');

  ws.on('message', async (message) => {
    try {
      const messageStr = Buffer.isBuffer(message) ? message.toString('utf8') : message;
      console.log('WebSocket raw message:', messageStr);
      let data;
      try {
        data = JSON.parse(messageStr);
      } catch (parseErr) {
        console.error('Invalid JSON message:', messageStr, parseErr);
        ws.send(JSON.stringify({ status: 'error', message: 'Invalid JSON format' }));
        return;
      }
      console.log('WebSocket parsed message:', data);
      if (data.action === 'save_image') {
        const { door, image, timestamp = Date.now(), customName } = data;
        if (!['front', 'back'].includes(door) || !image) {
          ws.send(JSON.stringify({ status: 'error', action: 'save_image', door, message: 'Invalid door or image' }));
          return;
        }
        const date = new Date(timestamp).toISOString().split('T')[0];
        const dir = await ensureDir(door, date);
        const safeCustomName = customName && customName.replace(/[^a-zA-Z0-9-_]/g, '') ? customName.replace(/[^a-zA-Z0-9-_]/g, '') : door;
        const fileName = `${timestamp}-${safeCustomName}.jpg`;
        const filename = path.join(dir, fileName);
        console.log('Saving image:', { filename, customName, safeCustomName });
        try {
          if (typeof image === 'string' && image.startsWith('data:image/jpeg;base64,')) {
            const base64Data = image.replace(/^data:image\/jpeg;base64,/, '');
            await fs.writeFile(filename, base64Data, 'base64');
          } else {
            await fs.writeFile(filename, Buffer.from(image));
          }
        } catch (err) {
          console.error('Error writing image:', err);
          ws.send(JSON.stringify({ status: 'error', action: 'save_image', door, message: `Failed to save image: ${err.message}` }));
          return;
        }
        console.log(`Saved image: ${filename}`);
        const imagePath = `/images/${door}/${date}/${fileName}`;
        ws.send(JSON.stringify({ status: 'saved', action: 'save_image', door, timestamp, path: imagePath, filename: fileName }));
        // Trigger gallery refresh
        const images = await listImages(door, date);
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ status: 'image_list', door, date, images }));
          }
        });
      } else if (data.action === 'delete_image') {
  const { door, timestamp, path: itemPath } = data;

  // === If we have a full path, use it directly (best method) ===
  if (itemPath) {
    let fullPath;

    if (itemPath.startsWith('/images/')) {
      fullPath = path.join(baseDir, itemPath.replace(/^\/images\//, ''));
    } else {
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid path' }));
      return;
    }

    try {
      await fs.unlink(fullPath);
      console.log(`Deleted: ${fullPath}`);

      ws.send(JSON.stringify({ status: 'deleted', door, timestamp }));

      // Refresh gallery
      const allMedia = await listImages(door || 'all');
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ status: 'image_list', images: allMedia }));
        }
      });
    } catch (err) {
      console.error('Delete failed:', err);
      ws.send(JSON.stringify({ status: 'error', message: 'Failed to delete file' }));
    }
    return;
  }

  // === Fallback: old method using door + timestamp (for very old data) ===
  if (!['front', 'back'].includes(door) || !timestamp) {
    ws.send(JSON.stringify({ status: 'error', message: 'Invalid door or timestamp' }));
    return;
  }

  const date = new Date(timestamp).toISOString().split('T')[0];
  const dir = path.join(baseDir, door, date);
  const files = await fs.readdir(dir).catch(() => []);
  const targetFile = files.find(f => f.startsWith(`${timestamp}-`));

  if (!targetFile) {
    ws.send(JSON.stringify({ status: 'error', message: 'Image not found' }));
    return;
  }

  const filePath = path.join(dir, targetFile);
  await fs.unlink(filePath);
  console.log(`Deleted image: ${filePath}`);

  ws.send(JSON.stringify({ status: 'deleted', door, timestamp }));

  const images = await listImages(door, date);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ status: 'image_list', door, date, images }));
    }
  });
} else if (data.action === 'delete_old_images') {
        const { door, maxAgeDays = 7 } = data;
        const dir = path.join(baseDir, door);
        const now = Date.now();
        let deletedCount = 0;
        const subdirs = await fs.readdir(dir);
        for (const subdir of subdirs) {
          const subdirPath = path.join(dir, subdir);
          const files = await fs.readdir(subdirPath);
          for (const file of files) {
            const filePath = path.join(subdirPath, file);
            const stats = await fs.stat(filePath);
            if ((now - stats.mtimeMs) > maxAgeDays * 24 * 60 * 60 * 1000) {
              await fs.unlink(filePath);
              deletedCount++;
            }
          }
        }
        
        console.log(`Deleted ${deletedCount} old images for ${door}`);
        ws.send(JSON.stringify({ status: 'deleted_old', door, count: deletedCount }));
      } else if (data.action === 'list_images') {
        const { door, date } = data;
        const images = await listImages(door || 'all', date);
        ws.send(JSON.stringify({ status: 'image_list', door: door || 'all', date, images }));
      } else {
        ws.send(JSON.stringify({ status: 'error', message: 'Invalid action' }));
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
      ws.send(JSON.stringify({ status: 'error', message: err.message }));
    }
  });
  ws.on('close', () => console.log('Image Manager client disconnected'));
});
app.use('/images', express.static(baseDir));
app.get('/download/:door/:date/:timestamp', async (req, res) => {
  const { door, date, timestamp } = req.params;
  const dir = path.join(baseDir, door, date);
  const files = await fs.readdir(dir);
  const targetFile = files.find(f => f.startsWith(`${timestamp}-`));
  if (!targetFile) {
    res.status(404).send('Image not found');
    return;
  }
  const filePath = path.join(dir, targetFile);
  res.download(filePath, targetFile);
});
app.get('/download_zip/:door', async (req, res) => {
  const { door } = req.params;
  if (!['front', 'back', 'all'].includes(door)) {
    res.status(400).send('Invalid door parameter');
    return;
  }
  const images = await listImages(door);
  if (images.length === 0) {
    res.status(404).send('No images found');
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename=${door}-all.zip`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  for (const image of images) {
    const relativePath = image.path.replace(/^\/images\//, '');
    const filePath = path.join(baseDir, relativePath);
    archive.file(filePath, { name: path.basename(filePath) });
  }
  archive.finalize();
});
console.log(`Image Manager server running on http://0.0.0.0:${port} and ws://0.0.0.0:${port}/ws`);
console.log(`Images stored in: ${baseDir}`);