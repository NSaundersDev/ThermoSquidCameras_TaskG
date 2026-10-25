import { zipStored } from './session_pack.js';

let ws = null;
let currentImages = [];
let currentPage = 1;
let isRendering = false;
let modalTarget = null;
let sessionDeleteLeft = 0;

function connectWebSocket() {
  const host = window.location.hostname;
  ws = new WebSocket(`ws://${host}:3000/ws`);

  ws.onopen = () => {
    console.log('Image WebSocket connected');
    fetchImages();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('WebSocket received:', data);

      if (data.status === 'image_list') {
        const uniqueMap = new Map();
        (data.images || []).forEach(img => {
          const key = `${img.path}|${img.timestamp}`;
          uniqueMap.set(key, img);
        });
        currentImages = Array.from(uniqueMap.values());
        currentPage = 1;
        renderImages();
      } else if (data.status === 'deleted' || data.status === 'deleted_old') {
        if (sessionDeleteLeft > 0) {
          sessionDeleteLeft -= 1;
          if (sessionDeleteLeft === 0) showStatus('Deleted session images');
        } else {
          showStatus(data.status === 'deleted'
            ? 'Deleted image'
            : `Deleted ${data.count} old images`);
        }
        fetchImages();
      } else if (data.status === 'error') {
        if (sessionDeleteLeft > 0) sessionDeleteLeft -= 1;
        showStatus(data.message, 4000, true);
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  };

  ws.onclose = () => {
    showStatus('Image service disconnected', 4000, true);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    showStatus('Image WebSocket error', 4000, true);
  };
}

function selectedSessionKey() {
  return new URLSearchParams(window.location.search).get('session');
}

function fetchImages() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const dateEl = document.getElementById('date-filter');
  const date = selectedSessionKey() || !dateEl ? '' : dateEl.value;

  ws.send(JSON.stringify({
    action: 'list_images',
    door: null,
    date: date || null
  }));
}

function showStatus(message, duration = 3000, isError = false) {
  const status = document.getElementById('status-message');
  if (!status) return;

  status.textContent = message;
  status.className = isError ? 'error' : 'fade-in';
  status.style.display = 'block';

  setTimeout(() => {
    status.classList.remove('fade-in');
    status.classList.add('fade-out');
    setTimeout(() => {
      status.textContent = '';
      status.style.display = 'none';
      status.classList.remove('fade-out', 'error');
    }, 300);
  }, duration);
}

function downloadFile(filePath) {
  const a = document.createElement('a');
  a.href = filePath;
  a.download = filePath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function fileNameHtml(fileName) {
  return escapeHtml(fileName).replace(/--/g, '--\u0000').replace(/-/g, '-<wbr>').replace(/\u0000/g, '<wbr>');
}

function imageFileName(img) {
  if (img.name) return img.name;
  const path = String(img.path || '');
  return decodeURIComponent(path.split('/').pop() || path);
}

function imageBaseName(fileName) {
  return String(fileName).replace(/\.(jpe?g|png)$/i, '');
}

function dataFileBadge(fileName) {
  return /\.txt$/i.test(String(fileName || '')) ? 'TXT' : 'CSV';
}

function parseSessionDataFile(fileName) {
  const match = String(fileName || '').match(/^(\d{6})--([A-Za-z0-9][A-Za-z0-9_-]{0,80})--shot-data\.(?:txt|csv)$/i);
  if (!match) return null;
  return {
    date: match[1],
    session: match[2],
    key: `${match[1]}--${match[2]}`
  };
}

function parseModernSession(fileName) {
  const match = imageBaseName(fileName).match(/^(\d{6})--(.+?)--(.+?)--(\d{2})(?:--(\d{2}))?$/);
  if (!match) return null;
  return {
    date: match[1],
    session: match[2],
    camera: match[3],
    count: match[4],
    shot: match[5] || '',
    key: `${match[1]}--${match[2]}`
  };
}

function parseLegacySession(fileName) {
  const base = imageBaseName(fileName);
  if (/^\d{13}-/.test(base)) return null;
  const match = base.match(/^(\d{6})-(.+)-(\d{2})(?:-(\d{2}))?$/);
  if (!match) return null;
  return {
    date: match[1],
    body: match[2],
    count: match[3],
    shot: match[4] || ''
  };
}

function commonSessionPrefix(left, right) {
  const a = left.split('-');
  const b = right.split('-');
  const shared = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) break;
    shared.push(a[i]);
  }
  if (!shared.length || shared.length === a.length || shared.length === b.length) return '';
  return shared.join('-');
}

function groupLegacySessions(items) {
  const byDate = new Map();
  items.forEach((item) => {
    const list = byDate.get(item.parsed.date) || [];
    list.push(item);
    byDate.set(item.parsed.date, list);
  });

  const groups = [];
  byDate.forEach((dateItems, date) => {
    const bodies = [...new Set(dateItems.map((item) => item.parsed.body))];
    const sessionOf = new Map();
    const used = new Set();
    const pairs = [];
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const prefix = commonSessionPrefix(bodies[i], bodies[j]);
        if (!prefix) continue;
        const sharesCount = dateItems.some((left) => left.parsed.body === bodies[i]
          && dateItems.some((right) => right.parsed.body === bodies[j] && left.parsed.count === right.parsed.count));
        if (sharesCount) pairs.push({ a: bodies[i], b: bodies[j], prefix, length: prefix.split('-').length });
      }
    }
    pairs.sort((a, b) => b.length - a.length);
    pairs.forEach((pair) => {
      if (used.has(pair.a) || used.has(pair.b)) return;
      used.add(pair.a);
      used.add(pair.b);
      sessionOf.set(pair.a, pair.prefix);
      sessionOf.set(pair.b, pair.prefix);
    });
    bodies.forEach((body) => {
      if (!sessionOf.has(body)) sessionOf.set(body, body);
    });

    const grouped = new Map();
    dateItems.forEach((item) => {
      const session = sessionOf.get(item.parsed.body);
      const key = `${date}--${session}`;
      const group = grouped.get(key) || { key, date, session, images: [] };
      item.parsed = { ...item.parsed, session, key };
      group.images.push(item);
      grouped.set(key, group);
    });
    grouped.forEach((group) => groups.push(group));
  });
  return groups;
}

function classifyImages(images) {
  const loose = [];
  const modern = new Map();
  const legacy = [];
  images.forEach((img) => {
    const name = imageFileName(img);
    const dataFile = parseSessionDataFile(name);
    if (dataFile) {
      const group = modern.get(dataFile.key) || { key: dataFile.key, date: dataFile.date, session: dataFile.session, images: [] };
      group.dataFile = { ...img, parsed: dataFile };
      modern.set(dataFile.key, group);
      return;
    }
    const parsed = parseModernSession(name);
    if (parsed) {
      const copy = { ...img, parsed };
      const group = modern.get(parsed.key) || { key: parsed.key, date: parsed.date, session: parsed.session, images: [] };
      group.images.push(copy);
      modern.set(parsed.key, group);
      return;
    }
    const old = parseLegacySession(name);
    if (old) {
      legacy.push({ ...img, parsed: old });
      return;
    }
    loose.push(img);
  });
  return { groups: [...modern.values(), ...groupLegacySessions(legacy)], loose };
}

function formatSessionDate(date) {
  const match = String(date).match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!match) return date;
  return `${match[1]}/${match[2]}/${match[3]}`;
}

function sessionHeading(key) {
  const parts = String(key || '').split('--');
  const date = parts.shift() || '';
  const session = parts.join('--');
  const formatted = formatSessionDate(date);
  if (session && formatted) return `${session} · ${formatted}`;
  return session || formatted || String(key || '');
}

function applyGalleryMode() {
  const key = selectedSessionKey();
  const back = document.getElementById('gallery-back');
  const heading = document.getElementById('gallery-heading');
  const dateFilter = document.getElementById('date-filter');
  const onSession = Boolean(key);
  if (back) back.hidden = !onSession;
  if (heading) {
    heading.hidden = !onSession;
    heading.textContent = onSession ? sessionHeading(key) : '';
  }
  if (dateFilter) dateFilter.hidden = onSession;
  const download = document.getElementById('session-download');
  const remove = document.getElementById('session-delete');
  if (download) download.hidden = !onSession;
  if (remove) remove.hidden = !onSession;
}

function sessionImages() {
  if (!selectedSessionKey()) return [];
  return galleryEntries(currentImages).map((entry) => entry.img).filter(Boolean);
}

function sessionZipName() {
  return (selectedSessionKey() || 'session').replace(/[^\w.-]+/g, '-');
}

async function downloadSessionImages() {
  const images = sessionImages();
  const button = document.getElementById('session-download');
  if (!images.length) {
    showStatus('No images in this session', 3000, true);
    return;
  }
  if (button) button.disabled = true;
  showStatus('Preparing download…', 8000);
  try {
    const used = new Set();
    const files = [];
    for (const img of images) {
      const response = await fetch(img.path);
      if (!response.ok) throw new Error(imageFileName(img));
      let name = imageFileName(img);
      if (used.has(name)) name = `${img.door}-${name}`;
      used.add(name);
      files.push({ name, data: new Uint8Array(await response.arrayBuffer()) });
    }
    const blob = new Blob([zipStored(files)], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sessionZipName()}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showStatus('Download started');
  } catch (error) {
    showStatus(`Could not download ${error.message || 'session images'}`, 4000, true);
  } finally {
    if (button) button.disabled = false;
  }
}

function deleteSessionImages() {
  const images = sessionImages();
  if (!images.length) {
    showStatus('No images in this session', 3000, true);
    return;
  }
  const dataCount = images.filter((img) => parseSessionDataFile(imageFileName(img))).length;
  const imageCount = images.length - dataCount;
  const name = sessionHeading(selectedSessionKey()).split(' · ')[0] || 'this session';
  let prompt = `Delete all ${imageCount} images in ${name}?`;
  if (imageCount && dataCount) prompt = `Delete all ${imageCount} images and the data file in ${name}?`;
  else if (dataCount) prompt = `Delete the data file in ${name}?`;
  if (!window.confirm(prompt)) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showStatus('Image service is not connected', 4000, true);
    return;
  }
  sessionDeleteLeft = images.length;
  images.forEach((img) => {
    ws.send(JSON.stringify({
      action: 'delete_image',
      door: img.door,
      timestamp: img.timestamp,
      path: img.path
    }));
  });
}

function compareSessionImages(a, b) {
  const count = String(a.parsed?.count || '').localeCompare(String(b.parsed?.count || ''));
  if (count) return count;
  const shot = String(a.parsed?.shot || '').localeCompare(String(b.parsed?.shot || ''));
  if (shot) return shot;
  if (a.door === b.door) return 0;
  return a.door === 'front' ? -1 : 1;
}

function entryTime(entry) {
  const images = entry.type === 'session'
    ? entry.group.images.concat(entry.group.dataFile ? [entry.group.dataFile] : [])
    : [entry.img];
  return Math.max(...images.map((img) => Number(img.timestamp) || 0));
}

function galleryEntries(images) {
  const key = selectedSessionKey();
  const classified = classifyImages(images);
  if (key) {
    const group = classified.groups.find((item) => item.key === key);
    if (!group) return [];
    const entries = group.images.slice().sort(compareSessionImages).map((img) => ({ type: 'image', img }));
    if (group.dataFile) entries.unshift({ type: 'data', img: group.dataFile });
    return entries;
  }
  const entries = [
    ...classified.groups.map((group) => ({ type: 'session', group })),
    ...classified.loose.map((img) => ({ type: 'image', img }))
  ];
  entries.sort((a, b) => entryTime(b) - entryTime(a));
  return entries;
}

function renderImageCard(img) {
  const card = document.createElement('div');
  card.className = 'image-card';
  const fileName = imageFileName(img);
  card.innerHTML = `
    <img src="${escapeHtml(img.path)}" alt="${escapeHtml(fileName)}" loading="lazy">
    <p class="file-name">${fileNameHtml(fileName)}</p>
    <p class="image-time">${new Date(img.timestamp).toLocaleString()}</p>
    <button class="view-btn" type="button">View</button>
    <button class="download" type="button">Download</button>
  `;
  const open = () => showModal(img.path, img.door, img.timestamp);
  card.querySelector('img').onclick = open;
  card.querySelector('.view-btn').onclick = open;
  card.querySelector('.download').onclick = () => downloadFile(img.path);
  return card;
}

function renderDataCard(file) {
  const card = document.createElement('div');
  card.className = 'image-card data-card';
  const fileName = imageFileName(file);
  card.innerHTML = `
    <div class="data-file">${escapeHtml(dataFileBadge(fileName))}</div>
    <p class="file-name">${fileNameHtml(fileName)}</p>
    <p class="image-time">${new Date(file.timestamp).toLocaleString()}</p>
    <button class="download" type="button">Download</button>
  `;
  card.querySelector('.download').onclick = () => downloadFile(file.path);
  return card;
}

function renderSessionCard(group) {
  const preview = group.images.length ? [...group.images].sort(compareSessionImages)[0] : null;
  const link = document.createElement('a');
  link.className = 'image-card session-card';
  link.href = `media_gallery.html?session=${encodeURIComponent(group.key)}`;
  const visual = preview
    ? `<img src="${escapeHtml(preview.path)}" alt="${escapeHtml(group.session)}" loading="lazy">`
    : `<div class="data-file" aria-hidden="true">${escapeHtml(dataFileBadge(group.dataFile && imageFileName(group.dataFile)))}</div>`;
  const meta = group.images.length
    ? `${formatSessionDate(group.date)} · ${group.images.length} images`
    : `${formatSessionDate(group.date)} · Data file`;
  link.innerHTML = `
    ${visual}
    <p class="session-title">${escapeHtml(group.session)}</p>
    <p class="session-meta">${escapeHtml(meta)}</p>
  `;
  return link;
}

function renderImages() {
  if (isRendering) return;
  isRendering = true;

  const grid = document.getElementById('image-grid');
  grid.innerHTML = '';
  const entries = galleryEntries(currentImages);

  if (!entries.length) {
    grid.innerHTML = '<p style="padding: 2rem; color: #666;">No images found.</p>';
    isRendering = false;
    return;
  }

  const imagesPerPage = 20;
  const start = (currentPage - 1) * imagesPerPage;
  const end = start + imagesPerPage;
  const pageItems = entries.slice(start, end);

  pageItems.forEach((entry) => {
    if (entry.type === 'session') grid.appendChild(renderSessionCard(entry.group));
    else if (entry.type === 'data') grid.appendChild(renderDataCard(entry.img));
    else grid.appendChild(renderImageCard(entry.img));
  });

  const totalPages = Math.ceil(entries.length / imagesPerPage);
  if (totalPages > 1) {
    const pagination = document.createElement('div');
    pagination.className = 'pagination';
    pagination.innerHTML = `
    <button ${currentPage === 1 ? 'disabled' : ''}>Previous</button>
    <span>Page ${currentPage} / ${totalPages}</span>
    <button ${currentPage === totalPages ? 'disabled' : ''}>Next</button>
    `;

    pagination.children[0].onclick = () => changePage(currentPage - 1);
    pagination.children[2].onclick = () => changePage(currentPage + 1);

    grid.appendChild(pagination);
  }
  isRendering = false;
}

function changePage(page) {
  currentPage = page;
  renderImages();
}

function showModal(filePath, door, timestamp) {
  const modal = document.getElementById('modal');
  const modalImg = document.getElementById('modal-image');
  modalTarget = { path: filePath, door, timestamp };
  modalImg.src = filePath;
  modal.style.display = 'block';
}

document.getElementById('modal-download').onclick = () => {
  if (modalTarget) downloadFile(modalTarget.path);
};

document.getElementById('modal-delete').onclick = () => {
  if (!modalTarget || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    action: 'delete_image',
    door: modalTarget.door,
    timestamp: modalTarget.timestamp,
    path: modalTarget.path
  }));
  document.getElementById('modal').style.display = 'none';
};

document.getElementById('modal-close').onclick = () => {
  document.getElementById('modal').style.display = 'none';
};

document.getElementById('refresh-images').onclick = fetchImages;
document.getElementById('date-filter').onchange = fetchImages;
document.getElementById('session-download').onclick = () => { downloadSessionImages(); };
document.getElementById('session-delete').onclick = deleteSessionImages;
applyGalleryMode();
connectWebSocket();
window.forceRefreshImages = fetchImages;
