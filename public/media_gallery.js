let ws = null;
let currentImages = [];
let currentPage = 1;
let isRendering = false;
let modalTarget = null;

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
        showStatus(data.status === 'deleted'
          ? 'Deleted image'
          : `Deleted ${data.count} old images`);
        fetchImages();
      } else if (data.status === 'error') {
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

function fetchImages() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const dateEl = document.getElementById('date-filter');
  const date = dateEl ? dateEl.value : '';

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

function getDoorLabel(door) {
  if (door === 'front') return 'Cam1';
  if (door === 'back') return 'Cam2';
  return door;
}

function downloadFile(filePath) {
  const a = document.createElement('a');
  a.href = filePath;
  a.download = filePath.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function renderImages() {
  if (isRendering) return;
  isRendering = true;

  const grid = document.getElementById('image-grid');
  grid.innerHTML = '';

  if (!currentImages.length) {
    grid.innerHTML = '<p style="padding: 2rem; color: #666;">No images found.</p>';
    isRendering = false;
    return;
  }

  const imagesPerPage = 20;
  const start = (currentPage - 1) * imagesPerPage;
  const end = start + imagesPerPage;
  const pageItems = currentImages.slice(start, end);

  pageItems.forEach(img => {
    const card = document.createElement('div');
    card.className = 'image-card';

    const label = getDoorLabel(img.door);
    let badgeColor = '#555';
    if (img.door === 'front') badgeColor = '#0d6efd';
    if (img.door === 'back') badgeColor = '#198754';

    card.innerHTML = `
    <img src="${img.path}" alt="${img.door} media" loading="lazy">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; gap: 8px;">
        <p style="margin: 0; font-size: 0.85rem; color: #ccc; white-space: nowrap;">
        ${new Date(img.timestamp).toLocaleString()}
        </p>
        <span style="
        font-size: 0.7rem;
        background: ${badgeColor};
        color: white;
        padding: 2px 8px;
        border-radius: 4px;
        white-space: nowrap;
        ">
        ${label}
        </span>
    </div>
    <button class="view-btn">View</button>
    <button class="download">Download</button>
    `;
    card.querySelector('.download').onclick = () => {
      downloadFile(img.path);
    };
    card.querySelector('.view-btn').onclick = () => {
      showModal(img.path, img.door, img.timestamp);
    };

    grid.appendChild(card);
  });

  const totalPages = Math.ceil(currentImages.length / imagesPerPage);
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
connectWebSocket();
window.forceRefreshImages = fetchImages;
