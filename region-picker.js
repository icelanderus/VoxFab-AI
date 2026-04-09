/* global regionPickAPI */

const canvas = document.getElementById('cv');
const ctx = canvas.getContext('2d');
const hint = document.getElementById('hint');

let img = new Image();
let dragging = false;
let submitting = false;
let sx = 0;
let sy = 0;
let cx = 0;
let cy = 0;

function evToCanvas(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function redraw() {
  const w = canvas.width;
  const h = canvas.height;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.58)';
  ctx.fillRect(0, 0, w, h);
  const x0 = Math.min(sx, cx);
  const y0 = Math.min(sy, cy);
  const rw = Math.abs(cx - sx);
  const rh = Math.abs(cy - sy);
  if (rw > 1 && rh > 1) {
    ctx.clearRect(x0, y0, rw, rh);
    ctx.drawImage(img, x0, y0, rw, rh, x0, y0, rw, rh);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, rw - 1, rh - 1);
  }
}

function onDown(ev) {
  dragging = true;
  const p = evToCanvas(ev);
  sx = p.x;
  sy = p.y;
  cx = p.x;
  cy = p.y;
  redraw();
}

function onMove(ev) {
  if (!dragging) return;
  const p = evToCanvas(ev);
  cx = p.x;
  cy = p.y;
  redraw();
}

async function onUp() {
  if (!dragging || submitting) return;
  dragging = false;
  const x0 = Math.min(sx, cx);
  const y0 = Math.min(sy, cy);
  const rw = Math.abs(cx - sx);
  const rh = Math.abs(cy - sy);
  if (rw < 12 || rh < 12) {
    hint.textContent = 'Selection too small — drag a larger box';
    redraw();
    return;
  }
  submitting = true;
  hint.textContent = 'Reading text…';
  const rect = { x: x0, y: y0, width: rw, height: rh };
  try {
    const res = await regionPickAPI.commit(rect);
    if (res && res.ok === false && res.errorKey === 'selection-too-small') {
      hint.textContent = 'Selection too small — try again';
      redraw();
    }
  } finally {
    submitting = false;
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    regionPickAPI.abort();
  }
});

canvas.addEventListener('mousedown', onDown);
window.addEventListener('mousemove', onMove);
window.addEventListener('mouseup', onUp);

regionPickAPI.onBootstrap((payload) => {
  const { imageUrl, imgWidth, imgHeight } = payload;
  canvas.width = imgWidth;
  canvas.height = imgHeight;
  img.onload = () => redraw();
  img.onerror = () => {
    hint.textContent = 'Could not load screen capture';
  };
  img.src = imageUrl;
});
