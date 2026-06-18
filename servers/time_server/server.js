const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3002;
const SET_TIME_PASSWORD = 'Lasers4Life';   // ← Change this to something secure

// Serve static files if needed (optional)
app.use(express.static('public'));
app.set('trust proxy', true);  

// Broadcast current server time every second
setInterval(() => {
  const now = new Date().toISOString();
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'time', time: now }));
    }
  });
}, 1000);

wss.on('connection', (ws, req) => {
  const clientIP = req.ip;
  console.log(`[TimeServer] Client connected from: ${clientIP}`);

  // Send current time immediately
  ws.send(JSON.stringify({ type: 'time', time: new Date().toISOString() }));

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    // Handle time sync request from client
    if (data.type === 'sync-time') {
      if (data.password !== SET_TIME_PASSWORD) {
        console.log(`[TimeServer] Wrong password from ${clientIP}`);
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
        return;
      }

      const timeStr = data.time; // Format: "2025-06-06 14:30:00"

      if (!timeStr) {
        ws.send(JSON.stringify({ type: 'error', message: 'No time provided' }));
        return;
      }

      console.log(`[TimeServer] Setting time to: ${timeStr} (requested by ${clientIP})`);

      // Disable NTP and set the time
      exec('sudo timedatectl set-ntp false', () => {
        exec(`sudo timedatectl set-time "${timeStr}"`, (err, stdout, stderr) => {
          if (err) {
            console.error(`[TimeServer] Failed to set time:`, stderr || err.message);
            ws.send(JSON.stringify({ type: 'error', message: stderr || err.message }));
          } else {
            console.log(`[TimeServer] Time successfully set to ${timeStr}`);
            ws.send(JSON.stringify({ type: 'success', message: `Server time set to ${timeStr}` }));

            // Broadcast new time to all connected clients
            const now = new Date().toISOString();
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'time', time: now }));
              }
            });
          }
        });
      });
    }
  });

  ws.on('close', () => {
    console.log(`[TimeServer] Client disconnected: ${clientIP}`);
  });

  ws.on('error', (err) => {
    console.error(`[TimeServer] WebSocket error from ${clientIP}:`, err.message);
  });
});

// Start server on all interfaces
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Time server running on ws://0.0.0.0:${PORT}`);
  console.log(`Accessible from other devices at: ws://192.168.1.26:${PORT}`);
});