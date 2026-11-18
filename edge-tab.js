// Docked edge tab: third collapsed mode. Click toggles recording; drag slides it along screen edges
// (main.js always re-glues it to the nearest edge). Hover shows the "expand to window" button
// outside the tab.
const tab = document.getElementById('edge-tab');
const micIcon = document.getElementById('mic-icon');
const stopIcon = document.getElementById('stop-icon');
const spinner = document.getElementById('tab-spinner');
const expandBtn = document.getElementById('tab-expand-btn');

const EDGES = ['top', 'bottom', 'left', 'right'];
const WAVE_MIN_PX = 4;
const WAVE_MAX_PX = 20;

let edge = 'bottom';
let isRecording = false;
let isProcessing = false;
let hoverLeaveTimer = null;

// Bars ordered from the icon outward (index 0 = closest), mirrored on both sides.
const leftBars = Array.from(document.querySelectorAll('#tab-wave-left .wave-bar')).reverse();
const rightBars = Array.from(document.querySelectorAll('#tab-wave-right .wave-bar'));

function setEdge(next) {
  if (!EDGES.includes(next)) return;
  edge = next;
  for (const e of EDGES) document.body.classList.toggle(`edge-${e}`, e === edge);
}

function renderWaveLevels(levels) {
  const vertical = edge === 'left' || edge === 'right';
  const prop = vertical ? 'width' : 'height';
  const other = vertical ? 'height' : 'width';
  for (let i = 0; i < rightBars.length; i++) {
    const v = levels && typeof levels[i] === 'number' ? Math.max(0, Math.min(1, levels[i])) : 0;
    const size = levels ? `${WAVE_MIN_PX + v * (WAVE_MAX_PX - WAVE_MIN_PX)}px` : '';
    for (const bar of [rightBars[i], leftBars[i]]) {
      if (!bar) continue;
      bar.style[prop] = size;
      bar.style[other] = '';
    }
  }
}

function updateUI() {
  const recording = isRecording && !isProcessing;
  document.body.classList.toggle('recording', recording);
  micIcon.classList.toggle('hidden', recording || isProcessing);
  stopIcon.classList.toggle('hidden', !recording);
  spinner.classList.toggle('hidden', !isProcessing);
  if (!recording) renderWaveLevels(null);
}

// ---- Hover + click-through ----
// The window is bigger than the tab (fixed size, see main.js). It ignores the mouse (events are only
// forwarded) until the pointer is over the tab or its button; then it takes clicks.
let pointerOnTab = false;
let isDragging = false;

function setPointerOnTab(on, force = false) {
  if (on === pointerOnTab && !force) return;
  pointerOnTab = on;
  window.electronAPI.edgeTabInteractive(on);
  clearTimeout(hoverLeaveTimer);
  if (on) {
    document.body.classList.add('hover');
  } else {
    // Short grace period so moving from the tab to the button (6px gap) keeps the button shown.
    hoverLeaveTimer = setTimeout(() => {
      if (!pointerOnTab && !isDragging) document.body.classList.remove('hover');
    }, 350);
  }
}

document.addEventListener('mousemove', (e) => {
  if (isDragging) return;
  setPointerOnTab(!!(e.target && e.target.closest && e.target.closest('.edge-tab, .tab-btn')));
});
document.addEventListener('mouseleave', () => {
  if (!isDragging) setPointerOnTab(false);
});

// ---- Drag along edges / click to toggle recording ----
tab.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('.tab-btn')) return;
  const start = { x: e.screenX, y: e.screenY, t: Date.now() };
  let dragged = false;
  isDragging = true;
  window.electronAPI.edgeTabDrag('start');

  const onMove = (ev) => {
    if (!dragged && Math.hypot(ev.screenX - start.x, ev.screenY - start.y) < 5) return;
    dragged = true;
    document.body.classList.add('dragging');
    window.electronAPI.edgeTabDrag('move');
  };
  const onUp = (ev) => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.body.classList.remove('dragging');
    isDragging = false;
    if (dragged) {
      window.electronAPI.edgeTabDrag('end');
    } else {
      window.electronAPI.edgeTabDrag('cancel');
      if (Date.now() - start.t < 400 && !isProcessing) {
        window.electronAPI.toggleRecordingMain();
      }
    }
    // The tab may have moved under / away from the pointer while dragging.
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    setPointerOnTab(!!(el && el.closest('.edge-tab, .tab-btn')), true);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

expandBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.electronAPI.exitMiniMode();
});

// ---- State from main ----
window.electronAPI.onEdgeTabEdge(setEdge);
window.electronAPI.onToggleRecording((recording) => {
  isRecording = !!recording;
  updateUI();
});
window.electronAPI.onProcessingState((processing) => {
  isProcessing = !!processing;
  updateUI();
});
window.electronAPI.onAudioLevels((levels) => {
  if (isRecording && !isProcessing) renderWaveLevels(levels);
});
window.electronAPI.getRecordingState().then((recording) => {
  isRecording = !!recording;
  updateUI();
});
window.electronAPI.getProcessingState().then((processing) => {
  isProcessing = !!processing;
  updateUI();
});
