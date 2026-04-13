/* global grammarAPI */

let selectedText = '';
let lastResult = '';
/** Flip-flop partner for undo (same idea as main window `state.previousText`). */
let resultUndoPartner = '';
let autoType = true;

const UNDO_BTN_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 2v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>';

/** Same actions and SVG icons as main window `index.html` AI toolbar (no emoji labels). */
const ACTION_DEFS = [
  {
    type: 'undo',
    id: 'grammar-undo-btn',
    title: 'Undo last AI result',
    svg: UNDO_BTN_SVG
  },
  {
    type: 'fix',
    id: 'ai-fix-btn',
    title: 'Fix & Polish',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/><path d="m5 3 1 2"/><path d="m19 3-1 2"/><path d="m5 21 1-2"/><path d="m19 21-1-2"/></svg>'
  },
  {
    type: 'rephrase',
    id: 'ai-rephrase-btn',
    title: 'Rephrase',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h12"/><path d="M4 12h9"/><path d="M4 17h8"/><polyline points="15 17 18 20 22 14"/></svg>'
  },
  {
    type: 'professional',
    id: 'ai-formal-btn',
    title: 'Professional',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 12 10 12 10 16 6 16z"/><path d="M6 4 10 4 10 8 6 8z"/><path d="M14 12 18 12 18 16 14 16z"/><path d="M14 4 18 4 18 8 14 8z"/><path d="M2 18h20"/></svg>'
  },
  {
    type: 'summary',
    id: 'ai-summary-btn',
    title: 'Summarize',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>'
  },
  {
    type: 'reply',
    id: 'ai-reply-btn',
    title: 'Draft Reply',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 17l2 2 4-4"/><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-11.4 8.24 8.24 0 0 1 3.8.9"/></svg>'
  },
  {
    type: 'shorten',
    id: 'ai-shorten-btn',
    title: 'Shorten',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6m0 0l-3-3m3 3l-3 3"/><path d="M20 10h-6m0 0l3-3m-3 3l3 3"/></svg>'
  },
  {
    type: 'expand',
    id: 'ai-expand-btn',
    title: 'Expand',
    svg: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 4L7 7l3 3"/><path d="M14 20l3-3-3-3"/><path d="M2 12h20"/></svg>'
  }
];

const root = document.getElementById('root');
const fab = document.getElementById('fab');
const panel = document.getElementById('panel');
const hint = document.getElementById('hint');
const thinking = document.getElementById('grammar-thinking');

function setHintLine(text) {
  const s = text == null ? '' : String(text);
  hint.textContent = s;
  hint.removeAttribute('title');
  const mid = hint.closest('.float-header-mid');
  if (mid) {
    mid.title = s.length > 42 ? s : '';
  }
}
const actionsEl = document.getElementById('actions');
const rephrasePicksEl = document.getElementById('rephrase-picks');
const resultEl = document.getElementById('result');
const applyRow = document.getElementById('apply-row');
const applyPaste = document.getElementById('apply-paste');
const dismissResult = document.getElementById('dismiss-result');
const customIn = document.getElementById('custom-prompt-input');
const customGo = document.getElementById('custom-prompt-go');
const customContainer = document.getElementById('grammar-custom-prompt');
const floatClose = document.getElementById('float-close');

const CUSTOM_BTN_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function toggleGrammarCustomPrompt() {
  const nowHidden = customContainer.classList.toggle('hidden');
  if (!nowHidden) {
    customIn.focus();
  }
  fitFloatToContent(350);
}

const FAB_DRAG_HINT = ' · Tap: panel · drag top bar to move';

function applyFloatBgOpacity(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return;
  document.documentElement.style.setProperty('--bg-opacity', String(n));
}

if (typeof grammarAPI.onAppearance === 'function') {
  grammarAPI.onAppearance((p) => {
    if (p && p.bgOpacity !== undefined) applyFloatBgOpacity(p.bgOpacity);
  });
}

let lastFitW = 0;
let lastFitH = 0;

function setFabVisual(payload) {
  fab.classList.remove('state-ok', 'state-warn', 'state-neutral', 'state-idle');
  if (payload.noApiKey) {
    fab.classList.add('state-neutral');
    fab.title = `Add API key in main app${FAB_DRAG_HINT}`;
    return;
  }
  if (payload.hasIssues === true) {
    fab.classList.add('state-warn');
    fab.title = `${payload.summary || 'Possible issues — review below'}${FAB_DRAG_HINT}`;
  } else if (payload.hasIssues === false) {
    fab.classList.add('state-ok');
    fab.title = `${payload.summary || 'No obvious issues'}${FAB_DRAG_HINT}`;
  } else {
    fab.classList.add('state-idle');
    fab.title = `Writing assistant${FAB_DRAG_HINT}`;
  }
}

let isResizableSetting = false;

function fitFloatToContent(widthLimit = 350) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const open = panel.classList.contains('open');
      const r = root.getBoundingClientRect();
      
      // Calculate needed window size, but cap the AUTO-WIDTH at widthLimit
      let w = Math.max(open ? 300 : 80, Math.ceil(r.width) + 14);
      if (widthLimit) {
        w = Math.min(widthLimit, w);
      }
      const h = Math.min(950, Math.max(open ? 88 : 64, Math.ceil(r.height) + 20));
      
      if (Math.abs(w - lastFitW) <= 1 && Math.abs(h - lastFitH) <= 1) return;
      
      lastFitW = w;
      lastFitH = h;
      grammarAPI.resize(w, h);
    });
  });
}

// Remove ResizeObserver for window size to avoid fighting manual resize
// We only auto-fit on specific triggers now.

/* No global ResizeObserver for the window to avoid fighting manual resize. */

function grammarUndoAvailable() {
  return !!(lastResult || resultUndoPartner);
}

function updateGrammarUndoButton() {
  const u = document.getElementById('grammar-undo-btn');
  if (u) u.classList.toggle('hidden', !grammarUndoAvailable());
}

function hideRephrasePicks() {
  if (!rephrasePicksEl) return;
  rephrasePicksEl.innerHTML = '';
  rephrasePicksEl.style.display = 'none';
}

function selectRephraseOption(chosen) {
  const text = String(chosen || '').trim();
  if (!text) return;
  hideRephrasePicks();
  resultUndoPartner = lastResult;
  lastResult = text;
  resultEl.textContent = lastResult;
  resultEl.classList.add('visible');
  applyRow.style.display = 'flex';
  updateGrammarUndoButton();
  setHintLine('');
  fitFloatToContent(350);
}

function showThreeOptionPicks(suggestions, labelText) {
  if (!rephrasePicksEl) return;
  rephrasePicksEl.innerHTML = '';

  const label = document.createElement('p');
  label.className = 'rephrase-picks-label';
  label.textContent = labelText || 'Tap one of 3 options';
  rephrasePicksEl.appendChild(label);

  suggestions.forEach((s, i) => {
    const text = String(s).trim();
    if (!text) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rephrase-option-btn';
    btn.setAttribute('aria-label', `Option ${i + 1}`);
    btn.textContent = text;
    btn.title = text.length > 160 ? text : '';
    btn.addEventListener('click', () => selectRephraseOption(text));
    rephrasePicksEl.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'rephrase-picks-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    hideRephrasePicks();
    setHintLine('');
    fitFloatToContent(400);
  });
  rephrasePicksEl.appendChild(cancel);

  rephrasePicksEl.style.display = 'flex';
  resultEl.textContent = '';
  resultEl.classList.remove('visible');
  applyRow.style.display = 'none';
  fitFloatToContent(400);
}

function buildActionButtons() {
  actionsEl.innerHTML = '';
  for (const a of ACTION_DEFS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-btn ai-btn';
    b.id = a.id;
    b.title = a.title;
    b.innerHTML = a.svg;
    b.addEventListener('click', () => runAction(a.type));
    actionsEl.appendChild(b);
  }
  const customBtn = document.createElement('button');
  customBtn.type = 'button';
  customBtn.className = 'action-btn ai-btn';
  customBtn.id = 'ai-custom-btn';
  customBtn.title = 'Custom Instruction';
  customBtn.innerHTML = CUSTOM_BTN_SVG;
  customBtn.addEventListener('click', toggleGrammarCustomPrompt);
  actionsEl.appendChild(customBtn);
  updateGrammarUndoButton();
}

function undoFloatAiResult() {
  if (!grammarUndoAvailable()) return;
  hideRephrasePicks();
  const a = lastResult;
  const b = resultUndoPartner;
  lastResult = b;
  resultUndoPartner = a;
  if (lastResult) {
    resultEl.textContent = lastResult;
    resultEl.classList.add('visible');
    applyRow.style.display = 'flex';
  } else {
    resultEl.textContent = '';
    resultEl.classList.remove('visible');
    applyRow.style.display = 'none';
  }
  updateGrammarUndoButton();
  fitFloatToContent(350);
}

async function runAction(type) {
  if (type === 'undo') {
    undoFloatAiResult();
    return;
  }
  if (!selectedText.trim()) return;
  hideRephrasePicks();
  const settings = await grammarAPI.getSettings();
  if (!settings.openaiApiKey) {
    setHintLine('Set OpenAI API key in VoxFab AI → Settings.');
    fitFloatToContent(350);
    return;
  }
  thinking.classList.remove('hidden');
  actionsEl.querySelectorAll('button').forEach((btn) => {
    btn.disabled = true;
  });
  try {
    if (type === 'fix') {
      const res = await grammarAPI.threeFixPolish(selectedText);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showThreeOptionPicks(res.suggestions || [], 'Tap one of 3 polished versions');
      updateGrammarUndoButton();
      return;
    }

    if (type === 'rephrase') {
      const res = await grammarAPI.threeRephrases(selectedText);
      if (!res.ok) throw new Error(res.error || 'Failed');
      showThreeOptionPicks(res.suggestions || [], 'Tap one of 3 rephrasings');
      updateGrammarUndoButton();
      return;
    }

    const res = await grammarAPI.runAiAction(type, selectedText);
    if (!res.ok) throw new Error(res.error || 'Failed');
    resultUndoPartner = lastResult;
    lastResult = res.result || '';
    resultEl.textContent = lastResult;
    resultEl.classList.add('visible');
    applyRow.style.display = 'flex';
    updateGrammarUndoButton();
  } catch (e) {
    setHintLine(e.message || 'AI failed');
    hideRephrasePicks();
    resultEl.classList.remove('visible');
    applyRow.style.display = 'none';
  } finally {
    thinking.classList.add('hidden');
    actionsEl.querySelectorAll('button').forEach((btn) => {
      btn.disabled = false;
    });
    // Force snap because result is back, with 350 limit
    fitFloatToContent(350);
  }
}

fab.addEventListener('click', () => {
  panel.classList.toggle('open');
  lastFitW = 0;
  lastFitH = 0;
  fitFloatToContent(350);
});

floatClose.addEventListener('click', () => grammarAPI.close());

applyPaste.addEventListener('click', async () => {
  if (!lastResult) return;
  const res = await grammarAPI.applyPaste(lastResult);
  if (res && res.ok) {
    grammarAPI.close();
  } else {
    setHintLine('Paste failed — copy manually or check Accessibility.');
    fitFloatToContent(350);
  }
});

dismissResult.addEventListener('click', () => {
  lastResult = '';
  resultUndoPartner = '';
  hideRephrasePicks();
  resultEl.classList.remove('visible');
  applyRow.style.display = 'none';
  updateGrammarUndoButton();
  fitFloatToContent(350);
});

customIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    customGo.click();
  }
});

customGo.addEventListener('click', async () => {
  const instr = customIn.value.trim();
  if (!instr || !selectedText.trim()) return;
  hideRephrasePicks();
  thinking.classList.remove('hidden');
  try {
    const res = await grammarAPI.runAiAction('custom', selectedText, instr);
    if (!res.ok) throw new Error(res.error || 'Failed');
    resultUndoPartner = lastResult;
    lastResult = res.result || '';
    resultEl.textContent = lastResult;
    resultEl.classList.add('visible');
    applyRow.style.display = 'flex';
    updateGrammarUndoButton();
    customIn.value = '';
    customContainer.classList.add('hidden');
  } catch (e) {
    setHintLine(e.message || 'AI failed');
  } finally {
    thinking.classList.add('hidden');
    fitFloatToContent(350);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') grammarAPI.close();
});

grammarAPI.onInit(async (payload) => {
  applyFloatBgOpacity(payload.bgOpacity !== undefined ? payload.bgOpacity : 0.85);
  selectedText = payload.text || '';
  lastResult = '';
  resultUndoPartner = '';
  hideRephrasePicks();
  resultEl.textContent = '';
  resultEl.classList.remove('visible');
  applyRow.style.display = 'none';
  panel.classList.add('open');
  customIn.value = '';
  customContainer.classList.add('hidden');
  lastFitW = 0;
  lastFitH = 0;

  const settings = await grammarAPI.getSettings();
  autoType = settings.autoType !== false;
  isResizableSetting = settings.grammarFloatResizable !== false;
  root.classList.toggle('resizable', isResizableSetting);
  document.body.classList.toggle('resizable-active', isResizableSetting);

  if (typeof grammarAPI.setFloatResizable === 'function') {
    grammarAPI.setFloatResizable(isResizableSetting);
  }

  setFabVisual(payload);
  if (payload.scanError) {
    setHintLine(payload.scanError);
  } else if (payload.noApiKey) {
    setHintLine('Add OpenAI API key in VoxFab AI settings to scan text and run AI actions.');
  } else if (payload.hasIssues === true) {
    setHintLine(payload.summary || 'Possible writing issues — pick an action below.');
  } else if (payload.hasIssues === false) {
    setHintLine(payload.summary || 'No obvious issues — optional polish below.');
  } else {
    setHintLine('Text from your clipboard — choose an action below.');
  }

  buildActionButtons();
  thinking.classList.add('hidden');
  
  // Snap to content initially
  fitFloatToContent();
});

if (window.grammarAPI && window.grammarAPI.platform === 'darwin') {
  document.documentElement.classList.add('platform-darwin');
}

setupDraggableHeader();

function setupDraggableHeader() {
  const header = document.querySelector('.float-chrome-header');
  if (!header) return;

  if (window.grammarAPI.platform === 'darwin') {
    return;
  }

  let isDragging = false;

  header.addEventListener('mousedown', (e) => {
    // Don't drag if clicking buttons
    if (e.target.closest('button')) return;
    
    isDragging = true;
    const offset = {
      x: e.screenX - window.screenX,
      y: e.screenY - window.screenY
    };
    window.grammarAPI.startDrag(offset);
  });

  window.addEventListener('mousemove', () => {
    if (isDragging) {
      window.grammarAPI.moveDrag();
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      window.grammarAPI.endDrag();
    }
  });
}
