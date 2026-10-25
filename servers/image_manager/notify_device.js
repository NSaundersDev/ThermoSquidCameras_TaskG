const WebSocket = require('ws');

const NOTIFY_PORT = 8080;
const HANDSHAKE_MS = 4000;
const sockets = new Map();

function isNotifyHost(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

function unreachable() {
  const error = new Error('Could not reach the device');
  error.code = 'UNREACHABLE';
  return error;
}

function settle(item, error) {
  if (item.done) return;
  item.done = true;
  if (error) item.reject(error);
  else item.resolve();
}

function retire(host) {
  const entry = sockets.get(host);
  if (!entry) return;
  sockets.delete(host);
  const pending = entry.queue.splice(0);
  for (const item of pending) settle(item, unreachable());
  try {
    entry.socket.close();
  } catch (error) {
    // The device socket is already closed.
  }
}

function openEntry(host, url) {
  const socket = new WebSocket(url, {
    // Device firmware often rejects the permessage-deflate offer browsers send.
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_MS
  });
  const entry = { socket, url, queue: [] };
  sockets.set(host, entry);
  const fail = () => {
    if (sockets.get(host) === entry) sockets.delete(host);
    const pending = entry.queue.splice(0);
    for (const item of pending) settle(item, unreachable());
  };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.on('open', () => {
    const pending = entry.queue.splice(0);
    for (const item of pending) {
      try {
        socket.send(item.payload);
        settle(item);
      } catch (error) {
        settle(item, unreachable());
      }
    }
  });
  return entry;
}

function notifyDevice(host, shot, port = NOTIFY_PORT) {
  const target = String(host || '').trim();
  if (!isNotifyHost(target)) {
    const error = new Error('Device IP is not valid');
    error.code = 'INVALID_HOST';
    return Promise.reject(error);
  }
  if (!Number.isInteger(shot) || shot < 0 || shot > 99) {
    const error = new Error('Shot count is not valid');
    error.code = 'INVALID_SHOT';
    return Promise.reject(error);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(unreachable());
  }

  for (const key of [...sockets.keys()]) {
    if (key !== target) retire(key);
  }

  const url = `ws://${target}:${port}`;
  const payload = JSON.stringify({ shot });
  return new Promise((resolve, reject) => {
    let entry = sockets.get(target);
    const usable = entry && (entry.socket.readyState === WebSocket.CONNECTING || entry.socket.readyState === WebSocket.OPEN);
    if (!usable) {
      if (entry) retire(target);
      try {
        entry = openEntry(target, url);
      } catch (error) {
        reject(unreachable());
        return;
      }
    }
    const item = { payload, resolve, reject, done: false };
    if (entry.socket.readyState === WebSocket.OPEN) {
      try {
        entry.socket.send(payload);
        settle(item);
      } catch (error) {
        settle(item, unreachable());
      }
      return;
    }
    entry.queue.push(item);
  });
}

function closeNotifySockets() {
  for (const host of [...sockets.keys()]) retire(host);
}

module.exports = { notifyDevice, isNotifyHost, closeNotifySockets, NOTIFY_PORT };
