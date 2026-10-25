const WebSocket = require('ws');

const NOTIFY_PORT = 8080;
const HANDSHAKE_MS = 4000;
const READ_MS = 4000;
const sockets = new Map();

function isNotifyHost(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(value || '').trim());
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

function coded(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unreachable() {
  return coded('Could not reach the device', 'UNREACHABLE');
}

function settle(item, error, value) {
  if (item.done) return;
  item.done = true;
  if (error) item.reject(error);
  else item.resolve(value);
}

function parseReading(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw coded('Temperature reading was not valid', 'BAD_READING');
  }
  if (!Array.isArray(value) || value.length < 2) {
    throw coded('Temperature reading was not valid', 'BAD_READING');
  }
  const at = value[0];
  if ((typeof at !== 'string' && typeof at !== 'number') || !String(at).trim()) {
    throw coded('Temperature reading was not valid', 'BAD_READING');
  }
  const list = Array.isArray(value[1]) ? value[1] : value.slice(1);
  if (!list.length && !Array.isArray(value[1])) {
    throw coded('Temperature reading was not valid', 'BAD_READING');
  }
  const temperatures = list.map((item) => Number(item));
  if (temperatures.some((item) => !Number.isFinite(item))) {
    throw coded('Temperature reading was not valid', 'BAD_READING');
  }
  return { at: String(at).trim(), temperatures };
}

function retire(host) {
  const entry = sockets.get(host);
  if (!entry) return;
  sockets.delete(host);
  const pending = entry.queue.splice(0);
  for (const item of pending) settle(item, unreachable());
  if (entry.cancel) entry.cancel(unreachable());
  try {
    entry.socket.close();
  } catch (error) {
    // The device socket is already closed.
  }
}

function readOne(entry, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(coded('No temperature reading', 'NO_READING')), timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (entry.cancel === cancel) entry.cancel = null;
      if (entry.wait === onMessage) entry.wait = null;
      if (error) reject(error);
      else resolve(value);
    }
    function onMessage(data) {
      try {
        finish(null, parseReading(data));
      } catch (error) {
        finish(error);
      }
    }
    function cancel(error) {
      finish(error);
    }
    entry.wait = onMessage;
    entry.cancel = cancel;
    try {
      entry.socket.send(payload);
    } catch (error) {
      finish(unreachable());
    }
  });
}

function pump(entry) {
  if (entry.pumping) return;
  entry.pumping = true;
  const step = () => {
    if (entry.socket.readyState !== WebSocket.OPEN) {
      entry.pumping = false;
      return;
    }
    const item = entry.queue.shift();
    if (!item) {
      entry.pumping = false;
      return;
    }
    readOne(entry, item.payload, item.readTimeout).then(
      (reading) => {
        settle(item, null, reading);
        step();
      },
      (error) => {
        settle(item, error);
        if (error && error.code === 'NO_READING' && sockets.get(entry.host) === entry) {
          // A late frame on this socket would be mistaken for the next shot.
          const rest = entry.queue.splice(0);
          sockets.delete(entry.host);
          entry.wait = null;
          entry.cancel = null;
          try { entry.socket.close(); } catch (closeError) { /* already closed */ }
          entry.pumping = false;
          if (!rest.length) return;
          try {
            const next = openEntry(entry.host, entry.url);
            next.queue.push(...rest);
            if (next.socket.readyState === WebSocket.OPEN) pump(next);
          } catch (openError) {
            for (const pending of rest) settle(pending, unreachable());
          }
          return;
        }
        if (sockets.get(entry.host) !== entry || entry.socket.readyState !== WebSocket.OPEN) {
          entry.pumping = false;
          return;
        }
        step();
      }
    );
  };
  step();
}

function openEntry(host, url) {
  const socket = new WebSocket(url, {
    // Device firmware often rejects the permessage-deflate offer browsers send.
    perMessageDeflate: false,
    handshakeTimeout: HANDSHAKE_MS
  });
  const entry = { host, socket, url, queue: [], pumping: false, wait: null, cancel: null };
  sockets.set(host, entry);
  const fail = () => {
    if (sockets.get(host) !== entry) return;
    sockets.delete(host);
    const pending = entry.queue.splice(0);
    for (const item of pending) settle(item, unreachable());
    if (entry.cancel) entry.cancel(unreachable());
  };
  socket.on('error', fail);
  socket.on('close', fail);
  socket.on('message', (data) => {
    const wait = entry.wait;
    if (!wait) return;
    entry.wait = null;
    wait(data);
  });
  socket.on('open', () => pump(entry));
  return entry;
}

function notifyDevice(host, shot, port = NOTIFY_PORT, options = {}) {
  const target = String(host || '').trim();
  if (!isNotifyHost(target)) return Promise.reject(coded('Device IP is not valid', 'INVALID_HOST'));
  if (!Number.isInteger(shot) || shot < 0 || shot > 99) return Promise.reject(coded('Shot count is not valid', 'INVALID_SHOT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(unreachable());
  const readTimeout = Number.isInteger(options.readTimeout) && options.readTimeout > 0 ? options.readTimeout : READ_MS;

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
    entry.queue.push({ payload, readTimeout, resolve, reject, done: false });
    if (entry.socket.readyState === WebSocket.OPEN) pump(entry);
  });
}

function closeNotifySockets() {
  for (const host of [...sockets.keys()]) retire(host);
}

module.exports = { notifyDevice, isNotifyHost, closeNotifySockets, NOTIFY_PORT };
