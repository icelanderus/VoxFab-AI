const fabCircle = document.getElementById('fab-circle');
const micIcon = document.getElementById('mic-icon');
const stopIcon = document.getElementById('stop-icon');
const fabSpinner = document.getElementById('fab-spinner');
const expandBtn = document.getElementById('expand-btn');

let isRecording = false;
let isProcessing = false;
let isDragging = false;
let startPos = { x: 0, y: 0 };
let startTime = 0;
let lastShownTime = Date.now();

// Initial state fetch
window.electronAPI.getRecordingState().then(recording => {
  updateRecordingUI(recording);
});
if (typeof window.electronAPI.getProcessingState === 'function') {
  window.electronAPI.getProcessingState().then(processing => {
    updateProcessingUI(!!processing);
  });
}

// Update lastShownTime whenever we receive the sync event
window.electronAPI.onToggleRecording(() => {
  lastShownTime = Date.now();
});

// Dragging logic
fabCircle.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // Left click only
  
  // Prevent accidental clicks immediately after window appears (e.g. from the collapse button click)
  if (Date.now() - lastShownTime < 150) return;
  
  isDragging = false;
  startPos = { x: e.screenX, y: e.screenY };
  startTime = Date.now();
  
  window.electronAPI.startDrag({ x: e.clientX, y: e.clientY });
  
  const moveHandler = () => {
    isDragging = true;
    window.electronAPI.moveDrag();
  };
  
  const upHandler = () => {
    window.removeEventListener('mousemove', moveHandler);
    window.removeEventListener('mouseup', upHandler);
    window.electronAPI.endDrag();
    
    // If it was a quick click (no significant drag), trigger the action
    const duration = Date.now() - startTime;
    const dist = Math.sqrt(Math.pow(e.screenX - startPos.x, 2) + Math.pow(e.screenY - startPos.y, 2));
    
    if (dist < 5 && duration < 300) {
      handleFabClick();
    }
  };
  
  window.addEventListener('mousemove', moveHandler);
  window.addEventListener('mouseup', upHandler);
});

// Expand back to main window on button click
if (expandBtn) {
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // prevent triggering mic toggle
    window.electronAPI.exitMiniMode();
  });
}

// Toggle recording on click (if not dragging)
async function handleFabClick() {
  if (isProcessing) return;
  await window.electronAPI.toggleRecordingMain();
}

// Update UI based on recording state
const WAVE_MIN_PX = 5;
const WAVE_MAX_PX = 28;
// Bars ordered from the FAB outward (index 0 = closest to the button), mirrored on both sides.
const leftWaveBars = Array.from(document.querySelectorAll('#fab-wave-left .wave-bar')).reverse();
const rightWaveBars = Array.from(document.querySelectorAll('#fab-wave-right .wave-bar'));

function renderWaveLevels(levels) {
  for (let i = 0; i < rightWaveBars.length; i++) {
    const v = levels && typeof levels[i] === 'number' ? Math.max(0, Math.min(1, levels[i])) : 0;
    const h = levels ? `${WAVE_MIN_PX + v * (WAVE_MAX_PX - WAVE_MIN_PX)}px` : '';
    rightWaveBars[i].style.height = h;
    if (leftWaveBars[i]) leftWaveBars[i].style.height = h;
  }
}

if (typeof window.electronAPI.onAudioLevels === 'function') {
  window.electronAPI.onAudioLevels(renderWaveLevels);
}

function updateRecordingUI(recording) {
  isRecording = recording;
  document.body.classList.toggle('recording', !!recording && !isProcessing);
  if (!recording) renderWaveLevels(null);
  if (isProcessing) return;
  if (isRecording) {
    fabCircle.classList.add('recording');
    micIcon.classList.add('hidden');
    stopIcon.classList.remove('hidden');
    if (fabSpinner) fabSpinner.classList.add('hidden');
  } else {
    fabCircle.classList.remove('recording');
    micIcon.classList.remove('hidden');
    stopIcon.classList.add('hidden');
    if (fabSpinner) fabSpinner.classList.add('hidden');
  }
}

function updateProcessingUI(processing) {
  isProcessing = !!processing;
  if (isProcessing) {
    document.body.classList.remove('recording');
    fabCircle.classList.remove('recording');
    micIcon.classList.add('hidden');
    stopIcon.classList.add('hidden');
    if (fabSpinner) fabSpinner.classList.remove('hidden');
  } else {
    if (fabSpinner) fabSpinner.classList.add('hidden');
    updateRecordingUI(isRecording);
  }
}

function applyCollapsedAppearance(payload) {
  if (!payload) return;
  if (payload.bgOpacity !== undefined) {
    const op = Math.max(0.05, Math.min(1, parseFloat(payload.bgOpacity) || 1));
    document.documentElement.style.opacity = String(op);
  }
}

if (typeof window.electronAPI.getSettings === 'function') {
  window.electronAPI.getSettings().then((s) => {
    if (s) applyCollapsedAppearance({ bgOpacity: s.bgOpacity, fabScale: s.fabScale });
  }).catch(() => {});
}
if (typeof window.electronAPI.onCollapsedAppearance === 'function') {
  window.electronAPI.onCollapsedAppearance(applyCollapsedAppearance);
}

// Listen for recording state changes from main process
window.electronAPI.onToggleRecording((recording) => {
  updateRecordingUI(recording);
});
if (typeof window.electronAPI.onProcessingState === 'function') {
  window.electronAPI.onProcessingState((processing) => {
    updateProcessingUI(processing);
  });
}

