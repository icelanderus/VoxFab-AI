/**
 * VibeType AI — Renderer
 * Handles UI interactions, audio capture, and speech engine routing
 */

// ============================================
// State
// ============================================
let state = {
  isRecording: false,
  isProcessing: false,
  engine: 'local-whisper',
  autoType: true,
  autoDetectLanguage: true,
  translateToEnglish: false,
  mediaRecorder: null,
  audioChunks: [],
  audioStream: null,
  audioContext: null,
  analyser: null,
  settings: {},
  previousText: null,
  capturedContext: null,
  /** Web Speech API — live interim/final text during record (Chromium). */
  speechRec: null,
  recordingBaseText: '',
  liveFinalTranscript: '',
  liveInterimTranscript: '',
  /** Same engine as final pass, polled while recording (Electron-friendly vs Web Speech). */
  liveEnginePreviewText: '',
  livePreviewTimerId: null,
  livePreviewInFlight: false,
  /** Raw mic PCM for live preview (partial WebM often cannot be decoded in Electron). */
  livePreviewPcmChunks: [],
  livePreviewSampleRate: 48000,
  livePreviewProcessor: null,
  livePreviewMuteGain: null
};

const ICONS = {
  capture: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  analyze: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><circle cx="10" cy="13" r="3"/><path d="m16 19-3.5-3.5"/></svg>'
};

// Speech engine instances (lazy loaded)
let localWhisperEngine = null;

// ============================================
// DOM Elements
// ============================================
const elements = {
  micButton: document.getElementById('mic-button'),
  micContainer: document.querySelector('.mic-container'),
  micRing: document.getElementById('mic-ring'),
  micIcon: document.getElementById('mic-icon'),
  stopIcon: document.getElementById('stop-icon'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  engineBadge: document.getElementById('settings-toggle'),
  engineName: document.getElementById('engine-name'),
  transcriptionText: document.getElementById('transcription-text'),
  waveformLeft: document.getElementById('waveform-left'),
  waveformRight: document.getElementById('waveform-right'),
  progressContainer: document.getElementById('progress-container'),
  progressText: document.getElementById('progress-text'),
  progressFill: document.getElementById('progress-fill'),

  // Actions
  copyBtn: document.getElementById('copy-btn'),
  typeBtn: document.getElementById('type-btn'),
  analyzeBtn: document.getElementById('analyze-btn'),
  writingAssistantBtn: document.getElementById('writing-assistant-btn'),
  clearBtn: document.getElementById('clear-btn'),
  minimizeBtn: document.getElementById('minimize-btn'),
  closeBtn: document.getElementById('close-btn'),

  // Settings
  settingsToggle: document.getElementById('settings-toggle'),
  settingsPanel: document.getElementById('settings-panel'),
  settingsBack: document.getElementById('settings-back'),
  mainContent: document.getElementById('main-content'),
  engineSelect: document.getElementById('engine-select'),
  openaiKeyGroup: document.getElementById('openai-key-group'),
  googleKeyGroup: document.getElementById('google-key-group'),
  openaiKey: document.getElementById('openai-key'),
  googleKey: document.getElementById('google-key'),
  autoTypeToggle: document.getElementById('auto-type-toggle'),
  autoDetectToggle: document.getElementById('auto-detect-toggle'),
  autoDetectToggleSettings: document.getElementById('auto-detect-toggle-settings'),
  translateToggle: document.getElementById('translate-toggle'),
  translateToggleSettings: document.getElementById('translate-toggle-settings'),
  languageGroup: document.getElementById('language-group'),
  languageSelect: document.getElementById('language-select'),
  saveSettingsBtn: document.getElementById('save-settings'),
  aboutBtn: document.getElementById('about-btn'),
  aboutPanel: document.getElementById('about-panel'),
  aboutBack: document.getElementById('about-back'),
  
  // AI Actions
  aiToolbar: document.getElementById('ai-actions-toolbar'),
  aiFixBtn: document.getElementById('ai-fix-btn'),
  aiFormalBtn: document.getElementById('ai-formal-btn'),
  aiSummaryBtn: document.getElementById('ai-summary-btn'),
  aiReplyBtn: document.getElementById('ai-reply-btn'),
  aiShortenBtn: document.getElementById('ai-shorten-btn'),
  aiExpandBtn: document.getElementById('ai-expand-btn'),
  aiUndoBtn: document.getElementById('ai-undo-btn'),
  aiCustomBtn: document.getElementById('ai-custom-btn'),
  customPromptContainer: document.getElementById('custom-prompt-container'),
  customPromptInput: document.getElementById('custom-prompt-input'),
  customPromptGo: document.getElementById('custom-prompt-go'),
  aiThinking: document.getElementById('ai-thinking'),
  transcriptionOverlay: document.getElementById('transcription-overlay'),

  // Appearance
  bgOpacitySlider: document.getElementById('bg-opacity-slider'),
  hotkeyHint: document.getElementById('hotkey-hint'),
  assistantEnabledToggle: document.getElementById('assistant-enabled-toggle'),
  assistantEnabledToggleSettings: document.getElementById('assistant-enabled-toggle-settings'),
  grammarFloatResizableToggle: document.getElementById('grammar-float-resizable-toggle'),
  livePreviewToggleSettings: document.getElementById('live-preview-toggle-settings'),
  collapseBtn: document.getElementById('collapse-btn')
};

function renderHotkeyHint() {
  if (!elements.hotkeyHint) return;
  const isMac = window.electronAPI.platform === 'darwin';
  if (isMac) {
    elements.hotkeyHint.innerHTML = `
      <span class="hotkey-hint-inner">
        <span class="hotkey-hint-group">
          <kbd>⌘</kbd><kbd>⇧</kbd><kbd>E</kbd>
          <span class="hotkey-hint-cap">Assistant</span>
        </span>
        <span class="hotkey-hint-gap">·</span>
        <span class="hotkey-hint-group">
          <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Space</kbd>
          <span class="hotkey-hint-cap">Record</span>
        </span>
      </span>`;
  } else {
    elements.hotkeyHint.innerHTML = `
      <span class="hotkey-hint-inner">
        <span class="hotkey-hint-group">
          <kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>E</kbd>
          <span class="hotkey-hint-cap">Assistant</span>
        </span>
        <span class="hotkey-hint-gap">·</span>
        <span class="hotkey-hint-group">
          <kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Space</kbd>
          <span class="hotkey-hint-cap">Record</span>
        </span>
      </span>`;
  }
}

// ============================================
// Initialization
// ============================================
async function init() {
  await loadSettings();
  setupEventListeners();
  setStatus('ready', 'Ready');
  updateAiToolbarVisibility();

  renderHotkeyHint();
  if (elements.micButton) {
    elements.micButton.title =
      window.electronAPI.platform === 'darwin'
        ? 'Click to start recording (⌘⇧Space or Ctrl⇧Space)'
        : 'Click to start recording (Ctrl+Shift+Space)';
  }

  // Listen for global hotkey from main process
  window.electronAPI.onToggleRecording((isRecording) => {
    if (isRecording && !state.isRecording && !state.isProcessing) {
      startRecording();
    } else if (!isRecording && state.isRecording) {
      stopRecording();
    } else if (state.isRecording) {
      stopRecording();
    } else if (!state.isRecording && !state.isProcessing) {
      startRecording();
    }
  });

  // Listen for whisper model progress from main process
  window.electronAPI.onWhisperProgress((message, percent) => {
    elements.progressContainer.classList.remove('hidden');
    elements.progressText.textContent = message;
    elements.progressFill.style.width = `${percent}%`;
    if (percent >= 100) {
      setTimeout(() => elements.progressContainer.classList.add('hidden'), 800);
    }
  });

  if (typeof window.electronAPI.onAppToast === 'function') {
    window.electronAPI.onAppToast(({ message, type }) => {
      const t = type === 'warning' || type === 'error' ? type : 'success';
      showToast(message, t, { duration: type === 'warning' ? 5500 : 4000 });
    });
  }
}

function syncAssistantEnabledToggles(enabled) {
  if (elements.assistantEnabledToggle) elements.assistantEnabledToggle.checked = enabled;
  if (elements.assistantEnabledToggleSettings) elements.assistantEnabledToggleSettings.checked = enabled;
  updateWritingAssistantButtonVisibility();
}

function updateWritingAssistantButtonVisibility() {
  if (!elements.writingAssistantBtn) return;
  const isEnabled = elements.assistantEnabledToggle 
    ? elements.assistantEnabledToggle.checked 
    : state.settings.assistantEnabled !== false;
  elements.writingAssistantBtn.classList.toggle('hidden', !isEnabled);
}




async function loadSettings() {
  state.settings = await window.electronAPI.getSettings();
  state.engine = state.settings.engine || 'local-whisper';
  state.autoType = state.settings.autoType !== undefined ? state.settings.autoType : true;
  state.autoDetectLanguage = state.settings.autoDetectLanguage !== undefined ? state.settings.autoDetectLanguage : true;
  state.translateToEnglish = state.settings.translateToEnglish !== undefined ? state.settings.translateToEnglish : false;

  // Update UI
  if (elements.engineSelect) elements.engineSelect.value = state.engine;
  if (elements.autoTypeToggle) elements.autoTypeToggle.checked = state.autoType;
  if (elements.autoDetectToggle) elements.autoDetectToggle.checked = state.autoDetectLanguage;
  if (elements.autoDetectToggleSettings) elements.autoDetectToggleSettings.checked = state.autoDetectLanguage;
  if (elements.translateToggle) elements.translateToggle.checked = state.translateToEnglish;
  if (elements.translateToggleSettings) elements.translateToggleSettings.checked = state.translateToEnglish;
  if (elements.languageSelect) elements.languageSelect.value = state.settings.language || 'en';
  if (elements.openaiKey) elements.openaiKey.value = state.settings.openaiApiKey || '';
  if (elements.googleKey) elements.googleKey.value = state.settings.googleApiKey || '';
  
  const assistantEnabled = state.settings.assistantEnabled !== false;
  syncAssistantEnabledToggles(assistantEnabled);
  
  if (elements.grammarFloatResizableToggle) {
    elements.grammarFloatResizableToggle.checked = state.settings.grammarFloatResizable !== false;
  }
  if (elements.livePreviewToggleSettings) {
    elements.livePreviewToggleSettings.checked = state.settings.livePreviewEnabled === true;
  }
  updateWritingAssistantButtonVisibility();

  // Appearance
  const opacity = state.settings.bgOpacity !== undefined ? state.settings.bgOpacity : 0.85;
  if (elements.bgOpacitySlider) elements.bgOpacitySlider.value = opacity;
  applyAppearance(opacity);

  updateEngineBadge();
  updateApiKeyVisibility();
  updateLanguageState();
}

// ============================================
// Event Listeners
// ============================================
function setupEventListeners() {
  // Mic button
  if (elements.micButton) {
    elements.micButton.addEventListener('click', () => {
      if (state.isProcessing) return;
      if (state.isRecording) {
        stopRecording();
      } else {
        startRecording();
      }
    });
  }

  // Action buttons
  if (elements.copyBtn) elements.copyBtn.addEventListener('click', copyTranscription);
  if (elements.typeBtn) elements.typeBtn.addEventListener('click', typeTranscription);
  if (elements.analyzeBtn) elements.analyzeBtn.addEventListener('click', handleAnalyzeClick);
  if (elements.writingAssistantBtn) {
    elements.writingAssistantBtn.addEventListener('click', async () => {
      try {
        await window.electronAPI.openWritingAssistant();
      } catch (e) {
        console.error('openWritingAssistant:', e);
      }
    });
  }
  if (elements.clearBtn) elements.clearBtn.addEventListener('click', clearTranscription);

  // Window controls
  if (elements.minimizeBtn) elements.minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
  if (elements.closeBtn) elements.closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());
  if (elements.collapseBtn) elements.collapseBtn.addEventListener('click', () => window.electronAPI.enterMiniMode());
  const aboutBtn = document.getElementById('about-btn');
  if (aboutBtn) {
    aboutBtn.addEventListener('click', () => {
      window.ipcRenderer.send('open-about');
    });
  }

  // Settings
  if (elements.settingsToggle) elements.settingsToggle.addEventListener('click', toggleSettings);
  if (elements.settingsBack) elements.settingsBack.addEventListener('click', toggleSettings);
  if (elements.aboutBtn) elements.aboutBtn.addEventListener('click', toggleAbout);
  if (elements.aboutBack) elements.aboutBack.addEventListener('click', toggleAbout);
  if (elements.saveSettingsBtn) elements.saveSettingsBtn.addEventListener('click', saveSettings);
  
  if (elements.assistantEnabledToggle) {
    elements.assistantEnabledToggle.addEventListener('change', () => {
      syncAssistantEnabledToggles(elements.assistantEnabledToggle.checked);
      saveQuickSettings();
    });
  }
  if (elements.assistantEnabledToggleSettings) {
    elements.assistantEnabledToggleSettings.addEventListener('change', () => {
      syncAssistantEnabledToggles(elements.assistantEnabledToggleSettings.checked);
    });
  }
  if (elements.grammarFloatResizableToggle) {
    elements.grammarFloatResizableToggle.addEventListener('change', saveQuickSettings);
  }
  if (elements.livePreviewToggleSettings) {
    elements.livePreviewToggleSettings.addEventListener('change', saveQuickSettings);
  }
  elements.engineSelect.addEventListener('change', updateApiKeyVisibility);
  elements.autoDetectToggle.addEventListener('change', () => {
    elements.autoDetectToggleSettings.checked = elements.autoDetectToggle.checked;
    updateLanguageState();
    saveQuickSettings();
  });
  elements.autoDetectToggleSettings.addEventListener('change', () => {
    elements.autoDetectToggle.checked = elements.autoDetectToggleSettings.checked;
    updateLanguageState();
    saveQuickSettings();
  });
  elements.autoTypeToggle.addEventListener('change', saveQuickSettings);
  elements.translateToggle.addEventListener('change', () => {
    elements.translateToggleSettings.checked = elements.translateToggle.checked;
    saveQuickSettings();
  });
  elements.translateToggleSettings.addEventListener('change', () => {
    elements.translateToggle.checked = elements.translateToggleSettings.checked;
    saveQuickSettings();
  });

  // AI Actions
  elements.aiFixBtn.addEventListener('click', () => performAIAction('fix'));
  elements.aiFormalBtn.addEventListener('click', () => performAIAction('professional'));
  elements.aiSummaryBtn.addEventListener('click', () => performAIAction('summary'));
  elements.aiReplyBtn.addEventListener('click', () => performAIAction('reply'));
  elements.aiShortenBtn.addEventListener('click', () => performAIAction('shorten'));
  elements.aiExpandBtn.addEventListener('click', () => performAIAction('expand'));
  elements.aiUndoBtn.addEventListener('click', undoAIAction);
  
  // Custom Prompt
  elements.aiCustomBtn.addEventListener('click', toggleCustomPrompt);
  elements.customPromptGo.addEventListener('click', () => performAIAction('custom'));
  elements.customPromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performAIAction('custom');
  });

  // Appearance Sliders
  if (elements.bgOpacitySlider) {
    elements.bgOpacitySlider.addEventListener('input', () => {
      applyAppearance(elements.bgOpacitySlider.value);
      saveQuickSettings();
    });
  }

  // Sync toolbar visibility with text presence
  if (elements.transcriptionText) {
    elements.transcriptionText.addEventListener('input', updateAiToolbarVisibility);
  }

  // Listen for global hotkey trigger
  window.electronAPI.onTriggerAnalyze(() => {
    handleAnalyzeClick();
  });
}

// ============================================
// Selection Analysis
// ============================================

async function handleAnalyzeClick() {
  const hasText = elements.transcriptionText.textContent.trim().length > 0;
  if (hasText) {
    await analyzeExistingText();
  } else {
    await captureSelectionFromApp();
  }
}

async function captureSelectionFromApp() {
  if (state.isProcessing) return;
  
  setStatus('processing', 'Capturing selection...');
  state.isProcessing = true;
  
  try {
    // Capture text from focused window
    const result = await window.electronAPI.captureSelection();
    
    if (!result || !result.text || !result.text.trim()) {
      setStatus('ready', 'No text selected');
      showToast('Please highlight some text in another app first', 'warning');
      return;
    }
    
    const { text, windowContext } = result;
    state.capturedContext = windowContext; // Store for later analysis
    
    elements.transcriptionText.textContent = text.trim();
    setStatus('ready', 'Text captured');
    updateAiToolbarVisibility();
    showToast(`Text captured from ${windowContext || 'other app'}`, 'success');
  } catch (error) {
    console.error('Capture error:', error);
    setStatus('error', 'Capture failed');
  } finally {
    state.isProcessing = false;
  }
}

async function analyzeExistingText() {
  if (state.isProcessing) return;
  
  const text = elements.transcriptionText.textContent.trim();
  if (!text) return;

  setStatus('processing', 'AI is analyzing...');
  state.isProcessing = true;
  
  try {
    const windowContext = state.capturedContext || null;
    showToast(`Analyzing text...`, 'success');
    
    // Generate AI response
    const aiResponse = await generateAiResponse(text, windowContext);
    
    if (aiResponse) {
      state.previousText = text;
      elements.transcriptionText.textContent = aiResponse;

      let autoPasteOk = true;
      if (state.autoType) {
        const pasteResult = await window.electronAPI.typeText(aiResponse);
        autoPasteOk = pasteResult.ok;
        if (!autoPasteOk) notifyPasteResult(pasteResult);
      }

      setStatus('ready', 'Analysis complete');
      updateAiToolbarVisibility();
      if (autoPasteOk || !state.autoType) {
        showToast('AI analysis complete!', 'success');
      }
    }
  } catch (error) {
    console.error('Analysis error:', error);
    setStatus('error', 'Analysis failed');
    showToast(error.message || 'Analysis failed', 'error');
  } finally {
    state.isProcessing = false;
  }
}

async function generateAiResponse(text, context) {
  const apiKey = state.settings.openaiApiKey;
  if (!apiKey) {
    throw new Error('OpenAI API key required for analysis. Please add it in Settings.');
  }

  // Determine context
  let contextPrompt = "You are a helpful productivity assistant.";
  if (context) {
    if (context.toLowerCase().includes('slack')) {
      contextPrompt = "You are a Slack assistant. Prepare a concise, helpful reply to the following message.";
    } else if (context.toLowerCase().includes('outlook') || context.toLowerCase().includes('mail')) {
      contextPrompt = "You are an Email assistant. Prepare a professional and polite draft response.";
    } else if (context.toLowerCase().includes('code') || context.toLowerCase().includes('visual studio')) {
      contextPrompt = "You are a Coding assistant. Analyze the code snippet and offer a quick fix or explanation.";
    }
  }

  const prompt = `${contextPrompt}
Analyze the following text captured from another application.
- If it's a question: Provide a direct, concise, and helpful answer.
- If it's a message: Draft a polite response.
- If it's a long segment: Provide a 1-sentence summary.
Keep your response concise as it will be typed back into the application.

TEXT TO ANALYZE:
"${text}"`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a concise AI assistant.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'AI API request failed');
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (err) {
    console.error('GPT analysis failed:', err);
    throw err;
  }
}

function applyAppearance(opacity) {
  document.documentElement.style.setProperty('--bg-opacity', opacity);
}

// ============================================
// Live preview (Web Speech API — word-by-word / phrase interim)
// ============================================
function speechRecognitionLangFromSettings() {
  if (state.autoDetectLanguage) return 'en-US';
  const map = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    ru: 'ru-RU',
    ja: 'ja-JP',
    ko: 'ko-KR',
    zh: 'zh-CN'
  };
  return map[state.settings.language] || 'en-US';
}

function updateLiveTranscriptionDisplay() {
  if (!elements.transcriptionText) return;
  const base = state.recordingBaseText || '';
  const finalP = (state.liveFinalTranscript || '').trim();
  const interP = (state.liveInterimTranscript || '').trim();
  const webLive = [finalP, interP].filter(Boolean).join(' ').trim();
  const engLive = (state.liveEnginePreviewText || '').trim();
  const livePart = engLive || webLive;
  const sep = base.trim() && livePart ? ' ' : '';
  elements.transcriptionText.textContent = base + (livePart ? sep + livePart : '');
}

function startLiveSpeechRecognitionIfAvailable() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return;

  state.liveFinalTranscript = '';
  state.liveInterimTranscript = '';

  try {
    state.speechRec = new Ctor();
    state.speechRec.continuous = true;
    state.speechRec.interimResults = true;
    state.speechRec.lang = speechRecognitionLangFromSettings();
    state.speechRec.maxAlternatives = 1;

    state.speechRec.onresult = (event) => {
      let interim = '';
      let finals = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const t = (r[0] && r[0].transcript) || '';
        if (r.isFinal) finals += t;
        else interim += t;
      }
      if (finals.trim()) {
        const chunk = finals.trim();
        state.liveFinalTranscript = state.liveFinalTranscript
          ? `${state.liveFinalTranscript} ${chunk}`
          : chunk;
      }
      state.liveInterimTranscript = interim.trim();
      updateLiveTranscriptionDisplay();
    };

    state.speechRec.onerror = (e) => {
      if (e && e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('SpeechRecognition:', e.error);
      }
    };

    state.speechRec.onend = () => {
      if (state.isRecording && state.speechRec) {
        try {
          state.speechRec.start();
        } catch (err) {
          console.warn('SpeechRecognition restart:', err);
        }
      }
    };

    state.speechRec.start();
  } catch (e) {
    console.warn('Live speech preview unavailable:', e);
    state.speechRec = null;
  }
}

function stopLiveSpeechRecognition() {
  if (!state.speechRec) return;
  const r = state.speechRec;
  state.speechRec = null;
  r.onend = null;
  try {
    r.stop();
  } catch (_) {}
  try {
    r.abort();
  } catch (_) {}
}

function getLivePreviewIntervalMs() {
  return state.engine === 'local-whisper' ? 2800 : 4500;
}

function getLivePreviewMinBlobBytes() {
  return state.engine === 'local-whisper' ? 7000 : 14000;
}

function mergeLivePreviewPcm() {
  const chunks = state.livePreviewPcmChunks;
  if (!chunks || chunks.length === 0) return null;
  let total = 0;
  for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
  const out = new Float32Array(total);
  let off = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], off);
    off += chunks[i].length;
  }
  return out;
}

/** Linear resample mono float32 (simple; good enough for live preview). */
function resampleFloat32Mono(input, fromRate, toRate) {
  if (fromRate === toRate || !input || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio;
    const j = Math.floor(srcPos);
    const f = srcPos - j;
    const a = input[j] || 0;
    const b = j + 1 < input.length ? input[j + 1] : a;
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

function ensurePcm16kMono(float32, sampleRate) {
  if (!float32 || float32.length === 0) return float32;
  return resampleFloat32Mono(float32, sampleRate, 16000);
}

function float32ToWavBlob(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buffer);

  function writeStr(offset, s) {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  }
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numChannels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function float32ToLinear16Bytes(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function uint8ToBase64Chunked(u8) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + chunk, u8.length)));
  }
  return btoa(binary);
}

function stopLiveEnginePreviewPolling() {
  if (state.livePreviewTimerId != null) {
    clearInterval(state.livePreviewTimerId);
    state.livePreviewTimerId = null;
  }
  state.livePreviewInFlight = false;
}

/**
 * Periodically transcribe accumulated audio so live text works in Electron (Web Speech often never fires onresult).
 * Uses parallel PCM capture — partial WebM from MediaRecorder usually fails decodeAudioData until stop.
 */
async function tickLiveEnginePreview() {
  if (!state.isRecording || state.livePreviewInFlight) return;

  const sr = state.livePreviewSampleRate || 48000;
  const minSamples = Math.floor(sr * 0.85);
  let pcm16k = null;

  const merged = mergeLivePreviewPcm();
  if (merged && merged.length >= minSamples) {
    pcm16k = ensurePcm16kMono(merged, sr);
  } else if (state.mediaRecorder && state.audioChunks.length) {
    const blob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType });
    if (blob.size < getLivePreviewMinBlobBytes()) return;
    try {
      pcm16k = await audioBlobToFloat32(blob);
    } catch {
      return;
    }
  } else {
    return;
  }

  if (!pcm16k || pcm16k.length < 800 || isLikelySilentPcm(pcm16k)) return;

  state.livePreviewInFlight = true;
  try {
    let text = '';
    switch (state.engine) {
      case 'local-whisper':
        text = await transcribeWithLocalWhisperFromPcm(pcm16k, { quiet: true });
        break;
      case 'openai': {
        const wav = float32ToWavBlob(pcm16k, 16000);
        try {
          text = await transcribeWithOpenAI(wav, 'live-preview.wav');
        } catch (e) {
          console.warn('Live preview (OpenAI):', e.message);
          return;
        }
        break;
      }
      case 'google-cloud':
        try {
          text = await transcribeWithGoogleCloudPcm16k(pcm16k);
        } catch (e) {
          console.warn('Live preview (Google):', e.message);
          return;
        }
        break;
      default:
        text = await transcribeWithLocalWhisperFromPcm(pcm16k, { quiet: true });
    }

    const t = text != null ? String(text).trim() : '';
    if (t && state.isRecording) {
      state.liveEnginePreviewText = t;
      updateLiveTranscriptionDisplay();
    }
  } finally {
    state.livePreviewInFlight = false;
  }
}

function startLiveEnginePreviewPolling() {
  stopLiveEnginePreviewPolling();
  state.liveEnginePreviewText = '';
  state.livePreviewTimerId = setInterval(() => {
    tickLiveEnginePreview().catch((e) => console.warn('Live preview tick:', e));
  }, getLivePreviewIntervalMs());
  setTimeout(() => {
    tickLiveEnginePreview().catch((e) => console.warn('Live preview kick:', e));
  }, 1600);
}

/**
 * After recording: merge Whisper (if any) with live Web Speech text; never double-append live + Whisper.
 * @param {string|null|undefined} whisperText - null/undefined/'' means no Whisper segment
 */
function applyPostRecordTranscription(whisperText) {
  const base = (state.recordingBaseText || '').trim();
  const liveWeb = [state.liveFinalTranscript, state.liveInterimTranscript]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const livePreview = (state.liveEnginePreviewText || '').trim();
  const live = liveWeb || livePreview;
  const w = whisperText == null ? '' : String(whisperText).trim();

  let segmentForPaste = '';
  let fullOut = '';

  if (w) {
    segmentForPaste = w;
    const sep = base ? ' ' : '';
    fullOut = base ? `${base}${sep}${w}` : w;
  } else if (live) {
    segmentForPaste = live;
    const sep = base ? ' ' : '';
    fullOut = base ? `${base}${sep}${live}` : live;
  } else {
    fullOut = base;
  }

  elements.transcriptionText.textContent = fullOut;

  state.recordingBaseText = '';
  state.liveFinalTranscript = '';
  state.liveInterimTranscript = '';
  state.liveEnginePreviewText = '';

  updateAiToolbarVisibility();
  return { segmentForPaste, fullOut };
}

// ============================================
// Recording
// ============================================
async function startRecording() {
  try {
    state.audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    state.livePreviewPcmChunks = [];
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(state.audioStream, {
      mimeType: getSupportedMimeType()
    });

    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.audioChunks.push(event.data);
      }
    };

    state.mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(state.audioChunks, { type: state.mediaRecorder.mimeType });
      await processAudio(audioBlob);
    };

    state.mediaRecorder.start(250); // Collect data every 250ms
    state.isRecording = true;
    window.electronAPI.setRecordingState(true);

    state.recordingBaseText = elements.transcriptionText
      ? elements.transcriptionText.textContent
      : '';
    state.liveFinalTranscript = '';
    state.liveInterimTranscript = '';
    state.liveEnginePreviewText = '';
    const livePreviewOn = state.settings.livePreviewEnabled === true;
    if (livePreviewOn) {
      startLiveSpeechRecognitionIfAvailable();
      startLiveEnginePreviewPolling();
    }

    // Update UI
    setStatus(
      'recording',
      livePreviewOn && (state.speechRec || state.livePreviewTimerId)
        ? 'Listening… (live preview)'
        : 'Listening...'
    );
    elements.micButton.classList.add('recording');
    elements.micRing.classList.add('active');
    elements.micContainer.classList.add('recording');
    elements.micIcon.classList.add('hidden');
    elements.stopIcon.classList.remove('hidden');
    elements.waveformLeft.classList.add('active');
    elements.waveformRight.classList.add('active');

    // Start audio visualization (+ PCM tap for live preview when enabled)
    setupAudioVisualization(state.audioStream, { captureLivePcm: livePreviewOn });

  } catch (error) {
    console.error('Failed to start recording:', error);
    setStatus('error', 'Microphone access denied');
    showToast('Could not access microphone. Please grant permission.', 'error');
  }
}

function stopRecording() {
  state.isRecording = false;
  stopLiveSpeechRecognition();
  stopLiveEnginePreviewPolling();

  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach(track => track.stop());
    state.audioStream = null;
  }

  if (state.livePreviewProcessor) {
    try {
      state.livePreviewProcessor.onaudioprocess = null;
      state.livePreviewProcessor.disconnect();
    } catch (_) {}
    state.livePreviewProcessor = null;
  }
  if (state.livePreviewMuteGain) {
    try {
      state.livePreviewMuteGain.disconnect();
    } catch (_) {}
    state.livePreviewMuteGain = null;
  }
  state.livePreviewPcmChunks = [];

  if (state.audioContext) {
    try {
      state.audioContext.close();
    } catch (_) {}
    state.audioContext = null;
    state.analyser = null;
  }

  window.electronAPI.setRecordingState(false);

  // Update UI
  elements.micButton.classList.remove('recording');
  elements.micRing.classList.remove('active');
  elements.micContainer.classList.remove('recording');
  elements.micIcon.classList.remove('hidden');
  elements.stopIcon.classList.add('hidden');
  elements.waveformLeft.classList.remove('active');
  elements.waveformRight.classList.remove('active');

  setStatus('processing', 'Processing...');
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'audio/webm';
}

// ============================================
// Audio Visualization
// ============================================
function setupAudioVisualization(stream, opts = {}) {
  const captureLivePcm = opts.captureLivePcm === true;

  state.audioContext = new AudioContext();
  state.analyser = state.audioContext.createAnalyser();
  const source = state.audioContext.createMediaStreamSource(stream);
  source.connect(state.analyser);
  state.analyser.fftSize = 64;

  state.livePreviewSampleRate = state.audioContext.sampleRate;
  if (captureLivePcm) {
    state.livePreviewPcmChunks = [];
    const bufferSize = 2048;
    const processor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);
    const mute = state.audioContext.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(state.audioContext.destination);
    processor.onaudioprocess = (e) => {
      if (!state.isRecording) return;
      const ch = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(ch.length);
      copy.set(ch);
      state.livePreviewPcmChunks.push(copy);
    };
    state.livePreviewProcessor = processor;
    state.livePreviewMuteGain = mute;
  }

  const bufferLength = state.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const bars = document.querySelectorAll('.wave-bar');

  function animate() {
    if (!state.isRecording) return;
    state.analyser.getByteFrequencyData(dataArray);

    bars.forEach((bar, i) => {
      const value = dataArray[i * 2] || 0;
      const height = Math.max(6, (value / 255) * 24);
      bar.style.height = `${height}px`;
    });

    requestAnimationFrame(animate);
  }
  animate();
}

// ============================================
// Audio Processing
// ============================================
async function processAudio(audioBlob) {
  state.isProcessing = true;
  setStatus('processing', 'Transcribing…');

  try {
    if (!audioBlob || audioBlob.size < 1200) {
      applyPostRecordTranscription(null);
      setStatus('ready', 'No speech detected');
      showToast('Recording too short or empty.', 'warning');
      return;
    }

    let pcm;
    try {
      pcm = await audioBlobToFloat32(audioBlob);
    } catch (_) {
      applyPostRecordTranscription(null);
      setStatus('ready', 'No speech detected');
      showToast('Could not read audio. Try recording a bit longer.', 'warning');
      return;
    }

    if (isLikelySilentPcm(pcm)) {
      applyPostRecordTranscription(null);
      setStatus('ready', 'No speech detected');
      showToast(
        'No clear speech detected (too quiet). Whisper invents text on silence — speak up or move closer to the mic.',
        'warning'
      );
      return;
    }

    let text = '';

    switch (state.engine) {
      case 'local-whisper':
        text = await transcribeWithLocalWhisperFromPcm(pcm);
        break;
      case 'openai':
        text = await transcribeWithOpenAI(audioBlob);
        break;
      case 'google-cloud':
        text = await transcribeWithGoogleCloud(audioBlob);
        break;
      default:
        text = await transcribeWithLocalWhisperFromPcm(pcm);
    }

    const { segmentForPaste } = applyPostRecordTranscription(text && text.trim() ? text.trim() : null);

    if (segmentForPaste) {
      let autoPasteOk = true;
      if (state.autoType) {
        const pasteResult = await window.electronAPI.typeText(segmentForPaste);
        autoPasteOk = pasteResult.ok;
        if (!autoPasteOk) notifyPasteResult(pasteResult);
      }

      setStatus('ready', 'Done! Ready for next input');
      if (autoPasteOk || !state.autoType) {
        showToast('Transcription complete!', 'success');
      }
    } else {
      setStatus('ready', 'No speech detected');
      showToast('No speech detected. Try again.', 'error');
    }
  } catch (error) {
    console.error('Transcription error:', error);
    applyPostRecordTranscription(null);
    setStatus('error', 'Transcription failed');
    showToast(error.message || 'Transcription failed', 'error');
  } finally {
    state.isProcessing = false;
  }
}

// ============================================
// Speech Engines
// ============================================

// --- Local Whisper (via browser-compatible transformers.js) ---
async function transcribeWithLocalWhisper(audioBlob) {
  const audioData = await audioBlobToFloat32(audioBlob);
  return transcribeWithLocalWhisperFromPcm(audioData);
}

async function transcribeWithLocalWhisperFromPcm(audioData, opts = {}) {
  const quiet = opts.quiet === true;

  if (!quiet) {
    elements.progressContainer.classList.remove('hidden');
    elements.progressText.textContent = 'Preparing audio...';
    elements.progressFill.style.width = '5%';
  }

  try {
    // Load model if needed
    if (!localWhisperEngine) {
      if (!quiet) {
        setStatus('processing', 'Loading Whisper model...');
        elements.progressText.textContent = 'Loading Whisper library...';
        elements.progressFill.style.width = '10%';
      }

      try {
        // Import the browser-compatible build from node_modules
        const transformers = await import('./node_modules/@huggingface/transformers/dist/transformers.js');

        if (!quiet) {
          elements.progressFill.style.width = '30%';
          elements.progressText.textContent = 'Downloading Whisper model (first time only)...';
        }

        localWhisperEngine = await transformers.pipeline(
          'automatic-speech-recognition',
          'onnx-community/whisper-tiny', // Multilingual model
          {
            dtype: 'q8',
            device: 'wasm'
          }
        );

        if (!quiet) {
          elements.progressFill.style.width = '90%';
          elements.progressText.textContent = 'Model ready!';
        }
      } catch (err) {
        console.error('Failed to load Whisper model:', err);
        throw new Error('Failed to load Whisper model: ' + err.message);
      }
    }

    if (!quiet) {
      elements.progressText.textContent = 'Transcribing...';
      elements.progressFill.style.width = '60%';
    }

    const options = {};
    if (!state.autoDetectLanguage) {
      options.language = state.settings.language || 'en';
    } else {
      options.language = null;
    }

    options.task = state.translateToEnglish ? 'translate' : 'transcribe';

    console.log('Local Whisper Transcription Options:', options);
    const result = await localWhisperEngine(audioData, options);

    if (!quiet) {
      elements.progressFill.style.width = '100%';
      elements.progressText.textContent = 'Done!';
      await new Promise(r => setTimeout(r, 300));
    }

    return result.text || '';
  } finally {
    if (!quiet) {
      elements.progressContainer.classList.add('hidden');
    }
  }
}

// --- OpenAI Whisper API ---
async function transcribeWithOpenAI(audioBlob, fileName = 'recording.webm') {
  const apiKey = state.settings.openaiApiKey;
  if (!apiKey) {
    throw new Error('OpenAI API key not set. Go to Settings to add your key.');
  }

  const formData = new FormData();
  formData.append('file', audioBlob, fileName);
  formData.append('model', 'whisper-1');
  formData.append('temperature', '0');

  if (!state.autoDetectLanguage) {
    formData.append('language', state.settings.language || 'en');
  }

  // Choose correct endpoint (transcriptions vs translations)
  const endpoint = state.translateToEnglish ? 'translations' : 'transcriptions';
  console.log(`OpenAI Call: ${endpoint}, autoDetect: ${state.autoDetectLanguage}`);
  
  const response = await fetch(`https://api.openai.com/v1/audio/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.text || '';
}

// --- Google Cloud Speech-to-Text ---
async function transcribeWithGoogleCloud(audioBlob) {
  const apiKey = state.settings.googleApiKey;
  if (!apiKey) {
    throw new Error('Google Cloud API key not set. Go to Settings to add your key.');
  }

  // Convert to base64
  const arrayBuffer = await audioBlob.arrayBuffer();
  const base64Audio = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  const response = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'WEBM_OPUS',
          sampleRateHertz: 48000,
          languageCode: state.autoDetectLanguage ? 'en-US' : (state.settings.language || 'en-US'),
          alternativeLanguageCodes: state.autoDetectLanguage ? ['es-ES', 'fr-FR', 'de-DE'] : [],
          enableAutomaticPunctuation: true,
          model: 'latest_long'
        },
        audio: { content: base64Audio }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Google Cloud API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.results && data.results.length > 0) {
    return data.results.map(r => r.alternatives[0].transcript).join(' ');
  }
  return '';
}

/** Google STT from raw 16 kHz mono PCM (live preview; avoids WEBM partial blobs). */
async function transcribeWithGoogleCloudPcm16k(pcm16k) {
  const apiKey = state.settings.googleApiKey;
  if (!apiKey) {
    throw new Error('Google Cloud API key not set. Go to Settings to add your key.');
  }

  const bytes = float32ToLinear16Bytes(pcm16k);
  const base64Audio = uint8ToBase64Chunked(bytes);

  const response = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: state.autoDetectLanguage ? 'en-US' : (state.settings.language || 'en-US'),
          alternativeLanguageCodes: state.autoDetectLanguage ? ['es-ES', 'fr-FR', 'de-DE'] : [],
          enableAutomaticPunctuation: true,
          model: 'latest_long'
        },
        audio: { content: base64Audio }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Google Cloud API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.results && data.results.length > 0) {
    return data.results.map((r) => r.alternatives[0].transcript).join(' ');
  }
  return '';
}

// ============================================
// Audio Utilities
// ============================================

/**
 * Whisper often hallucinates (pledges, prayers, "thank you for watching") on near-silence.
 * Reject very quiet clips before calling the API.
 */
function analyzePcmAmplitude(pcm) {
  if (!pcm || pcm.length < 80) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i];
    const a = Math.abs(x);
    if (a > peak) peak = a;
    sumSq += x * x;
  }
  return { rms: Math.sqrt(sumSq / pcm.length), peak };
}

function isLikelySilentPcm(pcm) {
  const { rms, peak } = analyzePcmAmplitude(pcm);
  if (rms < 0.0028) return true;
  if (peak < 0.011 && rms < 0.0045) return true;
  return false;
}

async function audioBlobToFloat32(blob) {
  const audioContext = new AudioContext({ sampleRate: 16000 });
  const arrayBuffer = await blob.arrayBuffer();

  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const float32Data = audioBuffer.getChannelData(0);
    audioContext.close();
    return float32Data;
  } catch (err) {
    audioContext.close();
    throw new Error('Failed to decode audio. Try speaking a bit longer.');
  }
}

// ============================================
// UI Helpers
// ============================================
function setStatus(type, message) {
  elements.statusDot.className = 'status-dot ' + type;
  elements.statusText.textContent = message;
  
  // Show/Hide transcription overlay during processing
  if (elements.transcriptionOverlay) {
    elements.transcriptionOverlay.classList.toggle('hidden', type !== 'processing');
    elements.transcriptionOverlay.classList.toggle('visible', type === 'processing');
  }
}

function updateEngineBadge() {
  const names = {
    'local-whisper': 'Local Whisper',
    'openai': 'OpenAI API',
    'google-cloud': 'Google Cloud'
  };
  if (elements.engineName) {
    elements.engineName.textContent = names[state.engine] || state.engine;
  }
}

function updateApiKeyVisibility() {
  const engine = elements.engineSelect.value;
  elements.openaiKeyGroup.classList.toggle('visible', engine === 'openai');
  elements.googleKeyGroup.classList.toggle('visible', engine === 'google-cloud');
}

function updateLanguageState() {
  const autoDetect = elements.autoDetectToggle.checked;
  elements.languageGroup.classList.toggle('dimmed', autoDetect);
  elements.languageSelect.disabled = autoDetect;
}

/**
 * Settings: hide main + drop shadow (scroll perf). About: keep main visible with shift-right (old UX).
 * Both: pause heavy main UI animations while overlay is open.
 */
function syncAuxPanelMotionClass() {
  const settingsOpen = elements.settingsPanel && elements.settingsPanel.classList.contains('visible');
  const aboutOpen = elements.aboutPanel && elements.aboutPanel.classList.contains('visible');
  document.documentElement.classList.toggle('settings-overlay-open', !!settingsOpen);
  document.documentElement.classList.toggle('about-overlay-open', !!aboutOpen);
}

function toggleSettings() {
  const isHidden = !elements.settingsPanel.classList.contains('visible');
  if (isHidden) {
    elements.settingsPanel.classList.remove('hidden');
    // Force reflow
    elements.settingsPanel.offsetHeight;
    elements.settingsPanel.classList.add('visible');
    elements.mainContent.classList.add('slide-out');
    syncAuxPanelMotionClass();
  } else {
    elements.settingsPanel.classList.remove('visible');
    elements.mainContent.classList.remove('slide-out');
    syncAuxPanelMotionClass();
    setTimeout(() => {
      elements.settingsPanel.classList.add('hidden');
      syncAuxPanelMotionClass();
    }, 400);
  }
}

async function saveSettings() {
  const settings = {
    engine: elements.engineSelect.value,
    openaiApiKey: elements.openaiKey.value,
    googleApiKey: elements.googleKey.value,
    autoType: elements.autoTypeToggle.checked,
    autoDetectLanguage: elements.autoDetectToggleSettings.checked,
    translateToEnglish: elements.translateToggleSettings.checked,
    language: elements.languageSelect.value,
    bgOpacity: parseFloat(elements.bgOpacitySlider.value),
    assistantEnabled: elements.assistantEnabledToggleSettings
      ? elements.assistantEnabledToggleSettings.checked
      : (elements.assistantEnabledToggle ? elements.assistantEnabledToggle.checked : state.settings.assistantEnabled !== false),
    grammarFloatResizable: elements.grammarFloatResizableToggle
      ? elements.grammarFloatResizableToggle.checked
      : state.settings.grammarFloatResizable !== false,
    livePreviewEnabled: elements.livePreviewToggleSettings
      ? elements.livePreviewToggleSettings.checked
      : state.settings.livePreviewEnabled === true
  };

  await window.electronAPI.saveSettings(settings);
  state.settings = settings;
  state.engine = settings.engine;
  state.autoType = settings.autoType;
  state.autoDetectLanguage = settings.autoDetectLanguage;
  state.translateToEnglish = settings.translateToEnglish;
  syncAssistantEnabledToggles(settings.assistantEnabled !== false);
  if (elements.grammarFloatResizableToggle) {
    elements.grammarFloatResizableToggle.checked = settings.grammarFloatResizable !== false;
  }

  // Keep main toggles in sync
  elements.autoDetectToggle.checked = state.autoDetectLanguage;
  elements.translateToggle.checked = state.translateToEnglish;

  updateEngineBadge();
  toggleSettings();
  showToast('Settings saved!', 'success');

  // Reset engine if changed or if auto-detect changed (to ensure multilingual model is loaded)
  if (settings.engine !== state.engine || settings.autoDetectLanguage !== state.autoDetectLanguage) {
    localWhisperEngine = null;
  }
}

async function saveQuickSettings() {
  const settings = {
    ...state.settings,
    autoType: elements.autoTypeToggle.checked,
    autoDetectLanguage: elements.autoDetectToggle.checked,
    translateToEnglish: elements.translateToggle.checked,
    bgOpacity: parseFloat(elements.bgOpacitySlider.value),
    assistantEnabled: elements.assistantEnabledToggle 
      ? elements.assistantEnabledToggle.checked 
      : state.settings.assistantEnabled !== false,
    grammarFloatResizable: elements.grammarFloatResizableToggle
      ? elements.grammarFloatResizableToggle.checked
      : state.settings.grammarFloatResizable !== false,
    livePreviewEnabled: elements.livePreviewToggleSettings
      ? elements.livePreviewToggleSettings.checked
      : state.settings.livePreviewEnabled === true
  };

  await window.electronAPI.saveSettings(settings);
  state.settings = settings;
  state.autoType = settings.autoType;

  // If auto-detect changed, we might need to reload the engine
  if (settings.autoDetectLanguage !== state.autoDetectLanguage) {
    state.autoDetectLanguage = settings.autoDetectLanguage;
    localWhisperEngine = null;
  }
  
  state.translateToEnglish = settings.translateToEnglish;
  syncAssistantEnabledToggles(settings.assistantEnabled !== false);

  // Keep settings toggles in sync
  if (elements.autoDetectToggleSettings) elements.autoDetectToggleSettings.checked = state.autoDetectLanguage;
  if (elements.translateToggleSettings) elements.translateToggleSettings.checked = state.translateToEnglish;

  console.log('Quick settings saved:', settings);
}

// ============================================
// AI Text Actions
// ============================================

function updateAiToolbarVisibility() {
  const hasText = elements.transcriptionText.textContent.trim().length > 0;
  
  // Update the primary Analyze/Capture button based on text presence
  if (hasText) {
    elements.analyzeBtn.innerHTML = ICONS.analyze;
    elements.analyzeBtn.title = 'AI Analyze (Smart Context)';
  } else {
    elements.analyzeBtn.innerHTML = ICONS.capture;
    elements.analyzeBtn.title = 'Capture text from any highlight (Slack/Mail/etc.)';
    state.capturedContext = null; // Reset context if cleared
  }

  // Always show the toolbar (because the Analyze button is always there)
  elements.aiToolbar.classList.remove('hidden');
  updateWritingAssistantButtonVisibility();

  // Toggle other AI buttons based on text presence
  elements.aiFixBtn.classList.toggle('hidden', !hasText);
  elements.aiFormalBtn.classList.toggle('hidden', !hasText);
  if (elements.aiSummaryBtn) elements.aiSummaryBtn.classList.toggle('hidden', !hasText);
  if (elements.aiReplyBtn) elements.aiReplyBtn.classList.toggle('hidden', !hasText);
  if (elements.aiShortenBtn) elements.aiShortenBtn.classList.toggle('hidden', !hasText);
  if (elements.aiExpandBtn) elements.aiExpandBtn.classList.toggle('hidden', !hasText);
  if (elements.aiCustomBtn) elements.aiCustomBtn.classList.toggle('hidden', !hasText);
  
  // Show undo button if we have previous text
  if (elements.aiUndoBtn) {
    elements.aiUndoBtn.classList.toggle('hidden', !state.previousText);
  }

  // Hide custom prompt if we hide buttons
  if (!hasText) {
    elements.customPromptContainer.classList.add('hidden');
  }
}

async function performAIAction(actionType) {
  const text = elements.transcriptionText.textContent.trim();
  if (!text) return;

  const apiKey = state.settings.openaiApiKey;
  if (!apiKey) {
    showToast('Please set your OpenAI API Key in settings to use AI actions.', 'error');
    toggleSettings();
    return;
  }

  // UI Loading State
  elements.aiThinking.classList.remove('hidden');
  elements.transcriptionText.classList.add('processing');
  
  const prompts = {
    fix: "Fix any spelling, grammar, and punctuation errors in the following text. Preserve the original meaning and style exactly. Return ONLY the corrected text.",
    professional: "Rewrite the following text in a formal, professional business tone suitable for an email or report. Return ONLY the rewritten text.",
    summary: "Create a very concise summary of the following text using bullet points if appropriate. Return ONLY the summary.",
    reply: "Draft a helpful, polite, and concise reply to the following message. Adapt to the tone of the message. Return ONLY the reply text.",
    shorten: "Shorten the following text significantly while keeping the core message and all important facts. Return ONLY the shortened text.",
    expand: "Expand the following text by adding more detail and professional polish while maintaining the original intent. Return ONLY the expanded text.",
    custom: elements.customPromptInput.value.trim()
  };

  if (actionType === 'custom' && !prompts.custom) {
    showToast('Please enter an instruction first', 'error');
    elements.customPromptInput.focus();
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful writing assistant. Return ONLY the requested transformed text with no preamble or explanation.' },
          { role: 'user', content: `${prompts[actionType]}\n\nText: "${text}"` }
        ],
        temperature: 0.3
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'AI request failed');
    }

    const data = await response.json();
    const result = data.choices[0].message.content.trim().replace(/^"|"$/g, '');
    
    // Save current text for UNDO before updating
    state.previousText = text;
    
    // Update transcription area
    elements.transcriptionText.textContent = result;
    
    // Clear and hide custom prompt if used
    if (actionType === 'custom') {
      elements.customPromptInput.value = '';
      elements.customPromptContainer.classList.add('hidden');
    }
    
    updateAiToolbarVisibility();
    showToast('AI Transformation Complete!', 'success');
  } catch (err) {
    console.error('AI Action Failed:', err);
    showToast('AI Action Failed: ' + err.message, 'error');
  } finally {
    elements.aiThinking.classList.add('hidden');
    elements.transcriptionText.classList.remove('processing');
  }
}

function undoAIAction() {
  if (!state.previousText) return;
  
  const currentText = elements.transcriptionText.textContent;
  elements.transcriptionText.textContent = state.previousText;
  state.previousText = currentText; // Swap for "Back and Forth"
  
  updateAiToolbarVisibility();
  showToast('Reverted to previous version', 'success');
}

function toggleCustomPrompt() {
  const isHidden = elements.customPromptContainer.classList.toggle('hidden');
  
  // Dynamically adjust window height to prevent overlay
  const currentHeight = window.innerHeight;
  const currentWidth = window.innerWidth;
  
  if (!isHidden) {
    // Expand window for the prompt input (approx 50px)
    window.electronAPI.resizeWindow(currentWidth, currentHeight + 50);
    elements.customPromptInput.focus();
  } else {
    // Shrink window back
    window.electronAPI.resizeWindow(currentWidth, Math.max(400, currentHeight - 50));
  }
}

function toggleAbout() {
  const isVisible = elements.aboutPanel.classList.toggle('visible');
  elements.aboutPanel.classList.toggle('hidden', !isVisible);
  if (elements.mainContent) {
    elements.mainContent.classList.toggle('shift-right', isVisible);
  }
  syncAuxPanelMotionClass();
}

/** Startup: one shine sweep on About (no auto-open panel). */
function initAboutDiscovery() {
  const SHINE_MS = 1350;
  setTimeout(() => {
    const btn = elements.aboutBtn;
    if (!btn) return;
    btn.classList.remove('shine-btn-once');
    void btn.offsetWidth;
    btn.classList.add('shine-btn-once');
    setTimeout(() => btn.classList.remove('shine-btn-once'), SHINE_MS);
  }, 1500);
}

// ============================================
// Action Buttons
// ============================================
function copyTranscription() {
  const text = elements.transcriptionText.textContent;
  if (!text) return;

  navigator.clipboard.writeText(text).then(() => {
    elements.copyBtn.classList.add('copied');
    showToast('Copied to clipboard!', 'success');
    setTimeout(() => elements.copyBtn.classList.remove('copied'), 2000);
  });
}

async function typeTranscription() {
  const text = elements.transcriptionText.textContent;
  if (!text) return;

  const result = await window.electronAPI.typeText(text);
  if (result.ok) {
    showToast('Text typed into focused app!', 'success');
  } else {
    notifyPasteResult(result);
  }
}

function clearTranscription() {
  elements.transcriptionText.textContent = '';
  updateAiToolbarVisibility();
}

// ============================================
// Toast Notifications
// ============================================
function notifyPasteResult(result) {
  const isMac = window.electronAPI.platform === 'darwin';
  const blocked = result && result.reason === 'accessibility';
  const noTarget = result && result.reason === 'no-target';
  const pasteFailed = result && result.reason === 'paste-failed';
  const pasteHint = isMac ? '⌘V' : 'Ctrl+V';
  let msg;
  let showAccBtn = false;
  if (blocked && isMac) {
    msg =
      'macOS blocked auto-paste: enable Accessibility for this app. If prompted, allow System Events (Automation).';
    showAccBtn = true;
  } else if (noTarget) {
    msg = `No target app remembered. Click the field where text should go (e.g. Composer), then try again — or press ${pasteHint} to paste manually.`;
  } else if (pasteFailed && isMac) {
    msg = `Auto-paste failed. Turn on Accessibility for the exact app you run (VibeType AI from Applications, or Electron if npm run dev). Click the target field, try again — or ${pasteHint} to paste.`;
    showAccBtn = true;
  } else {
    msg = `Could not paste into the other app. Text is on the clipboard — press ${pasteHint} in that window.`;
  }
  showToast(msg, 'error', {
    duration: blocked && isMac ? 14000 : noTarget ? 9000 : pasteFailed ? 12000 : 7000,
    actionLabel: showAccBtn ? 'Open Accessibility…' : undefined,
    onAction: showAccBtn ? () => window.electronAPI.openAccessibilitySettings() : undefined
  });
}

function showToast(message, type = 'success', options = {}) {
  const { duration = 2500, actionLabel, onAction } = options;
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const msgEl = document.createElement('div');
  msgEl.className = 'toast-message';
  msgEl.textContent = message;
  toast.appendChild(msgEl);

  if (actionLabel && typeof onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => onAction());
    toast.appendChild(btn);
  }

  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

// ============================================
// Start
// ============================================
if (window.electronAPI.platform === 'darwin') {
  document.documentElement.classList.add('platform-darwin');
}
init();
setupDraggableHeader();
initAboutDiscovery();

function setupDraggableHeader() {
  const header = document.getElementById('title-bar');
  if (!header) return;

  // macOS: IPC + setPosition every mousemove stutters; use OS-native window drag instead.
  if (window.electronAPI.platform === 'darwin') {
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
    window.electronAPI.startDrag(offset);
  });

  window.addEventListener('mousemove', () => {
    if (isDragging) {
      window.electronAPI.moveDrag();
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      window.electronAPI.endDrag();
    }
  });
}
