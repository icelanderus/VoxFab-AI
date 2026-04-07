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
function updateRecordingUI(recording) {
  isRecording = recording;
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
    fabCircle.classList.remove('recording');
    micIcon.classList.add('hidden');
    stopIcon.classList.add('hidden');
    if (fabSpinner) fabSpinner.classList.remove('hidden');
  } else {
    if (fabSpinner) fabSpinner.classList.add('hidden');
    updateRecordingUI(isRecording);
  }
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

