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

function toText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) return Buffer.concat(data).toString('utf8');
  return String(data);
}

function snippet(text) {
  return String(text || '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function badReading(text) {
  const extra = snippet(text);
  console.error('Device reading was not recognized:', extra || '(empty)');
  return coded(extra ? `Temperature reading was not valid: ${extra}` : 'Temperature reading was not valid', 'BAD_READING');
}

function parseLoose(text) {
  let trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) trimmed = `[${trimmed.slice(1, -1)}]`;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const loosened = trimmed
      .replace(/\bNaN\b/gi, 'null')
      .replace(/\b-?Infinity\b/g, 'null')
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/,\s*([\]}])/g, '$1')
      .replace(/'/g, '"');
    return JSON.parse(loosened);
  }
}

function readTemperature(item) {
  if (item == null) return null;
  if (typeof item === 'number') return Number.isFinite(item) ? Number(item.toFixed(1)) : null;
  if (typeof item !== 'string') return null;
  let text = item.trim().replace(/°/g, '');
  if (!text || /^(nan|none|null|open|error|n\/a|na|---|inf|-inf|infinity|-infinity)$/i.test(text)) return null;
  text = text.replace(',', '.').replace(/\s*[cCfF]$/, '').trim();
  const value = Number(text);
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function isTempLike(item) {
  if (item == null || typeof item === 'number') return true;
  if (typeof item !== 'string') return false;
  const text = item.trim();
  if (!text || /^(nan|none|null|open|error|n\/a|na|---|inf|-inf|infinity|-infinity)$/i.test(text)) return true;
  return /^-?\d+(?:[.,]\d+)?\s*°?\s*[cCfF]?$/.test(text);
}

function formatStamp(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || null;
  }
  if (Array.isArray(value) && value.every((part) => typeof part === 'string' || typeof part === 'number')) {
    const text = value.map((part) => String(part).trim()).filter(Boolean).join(' ');
    return text || null;
  }
  if (value && typeof value === 'object') {
    const date = value.date || value.day || '';
    const time = value.time || value.clock || '';
    const text = `${date} ${time}`.trim();
    return text || null;
  }
  return null;
}

function daqTemperatures(value) {
  // Temperature DAQ shot replies:
  // 9 fields: timestamp, TC1..TC8
  // 12 fields: timestamp, TC1..TC8, relay, control, shot
  // 13 fields: timestamp, elapsed seconds, TC1..TC8, relay, control, shot
  if (value.length === 13) return value.slice(2, 10);
  if (value.length === 12 || value.length === 9) return value.slice(1, 9);
  return null;
}

function readingFromArray(value) {
  let at = null;
  let plain = null;
  let list = null;
  const daq = daqTemperatures(value);
  if (daq && daq.every(isTempLike)) list = daq;
  for (const item of value) {
    if (!list && Array.isArray(item) && item.every(isTempLike)) {
      list = item;
      continue;
    }
    const stamp = formatStamp(item);
    if (!stamp) continue;
    if (typeof item === 'number' && Math.abs(item) <= 1e8) continue;
    if ((typeof item === 'number' && Math.abs(item) > 1e8) || (/[-:/T]/.test(stamp) && /\d/.test(stamp))) {
      at = at || stamp;
    } else if (typeof item === 'string') {
      plain = plain || stamp;
    }
  }
  if (!at) at = plain;
  if (!list) {
    const temps = value.filter((item, index) => index > 0 && isTempLike(item));
    if (temps.length && temps.length === value.length - 1) list = value.slice(1);
  }
  if (!at || !list) return null;
  return { at, temperatures: list.map(readTemperature) };
}

function readingFromObject(value) {
  const lists = ['temperatures', 'temps', 'temperature', 'values', 'channels', 'data'];
  for (const key of lists) {
    if (!Array.isArray(value[key]) || !value[key].every(isTempLike)) continue;
    const at = formatStamp(value.datetime || value.time || value.timestamp || value.date || value.at);
    if (!at) continue;
    return { at, temperatures: value[key].map(readTemperature) };
  }
  if (Array.isArray(value.data)) return readingFromArray(value.data);
  return null;
}

function parseCsv(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('{')) return null;
  const parts = trimmed.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length < 2 || !parts.slice(1).every(isTempLike)) return null;
  const at = formatStamp(parts[0]);
  if (!at || !/[-:/T]/.test(at)) return null;
  return { at, temperatures: parts.slice(1).map(readTemperature) };
}

function interpret(text) {
  const raw = String(text || '').trim();
  if (/^(ok|ack|ping|pong|ready|connected)$/i.test(raw)) return { ignore: true };
  let value;
  try {
    value = parseLoose(raw);
    if (typeof value === 'string') value = parseLoose(value);
  } catch (error) {
    const csv = parseCsv(raw);
    if (csv) return { reading: csv };
    return { invalid: true };
  }
  if (Array.isArray(value)) {
    const reading = readingFromArray(value);
    if (reading) return { reading };
    return { invalid: true };
  }
  if (value && typeof value === 'object') {
    const reading = readingFromObject(value);
    if (reading) return { reading };
    return { ignore: true };
  }
  return { invalid: true };
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
    function cancel(error) {
      finish(error);
    }
    function onMessage(data) {
      const text = toText(data);
      try {
        const outcome = interpret(text);
        if (outcome.ignore) return;
        if (outcome.reading) finish(null, outcome.reading);
        else finish(badReading(text));
      } catch (error) {
        finish(badReading(text));
      }
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
    if (!entry.wait) return;
    entry.wait(data);
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
