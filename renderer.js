/**
 * Voice To Text — Renderer
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
  previousText: null
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
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  
  // AI Actions
  aiToolbar: document.getElementById('ai-actions-toolbar'),
  aiFixBtn: document.getElementById('ai-fix-btn'),
  aiRefineBtn: document.getElementById('ai-refine-btn'),
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

  // Appearance
  bgOpacitySlider: document.getElementById('bg-opacity-slider')
};

// ============================================
// Initialization
// ============================================
async function init() {
  await loadSettings();
  setupEventListeners();
  setStatus('ready', 'Ready');
  updateAiToolbarVisibility();

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
}

async function loadSettings() {
  state.settings = await window.electronAPI.getSettings();
  state.engine = state.settings.engine || 'local-whisper';
  state.autoType = state.settings.autoType !== undefined ? state.settings.autoType : true;
  state.autoDetectLanguage = state.settings.autoDetectLanguage !== undefined ? state.settings.autoDetectLanguage : true;
  state.translateToEnglish = state.settings.translateToEnglish !== undefined ? state.settings.translateToEnglish : false;

  // Update UI
  elements.engineSelect.value = state.engine;
  elements.autoTypeToggle.checked = state.autoType;
  elements.autoDetectToggle.checked = state.autoDetectLanguage;
  elements.autoDetectToggleSettings.checked = state.autoDetectLanguage;
  elements.translateToggle.checked = state.translateToEnglish;
  elements.translateToggleSettings.checked = state.translateToEnglish;
  elements.languageSelect.value = state.settings.language || 'en';
  elements.openaiKey.value = state.settings.openaiApiKey || '';
  elements.googleKey.value = state.settings.googleApiKey || '';
  
  // Appearance
  const opacity = state.settings.bgOpacity !== undefined ? state.settings.bgOpacity : 0.85;
  elements.bgOpacitySlider.value = opacity;
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
  elements.micButton.addEventListener('click', () => {
    if (state.isProcessing) return;
    if (state.isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // Action buttons
  elements.copyBtn.addEventListener('click', copyTranscription);
  elements.typeBtn.addEventListener('click', typeTranscription);
  elements.analyzeBtn.addEventListener('click', analyzeSelection);
  elements.clearBtn.addEventListener('click', clearTranscription);

  // Window controls
  elements.minimizeBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());
  elements.closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

  // Settings
  elements.settingsToggle.addEventListener('click', toggleSettings);
  elements.settingsBack.addEventListener('click', toggleSettings);
  elements.saveSettingsBtn.addEventListener('click', saveSettings);
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
  elements.aiRefineBtn.addEventListener('click', () => performAIAction('refining'));
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
  elements.bgOpacitySlider.addEventListener('input', () => {
    applyAppearance(elements.bgOpacitySlider.value);
    saveQuickSettings();
  });

  // Sync toolbar visibility with text presence
  elements.transcriptionText.addEventListener('input', updateAiToolbarVisibility);

  // Listen for global hotkey trigger
  window.electronAPI.onTriggerAnalyze(() => {
    analyzeSelection();
  });
}

// ============================================
// Selection Analysis
// ============================================

async function analyzeSelection() {
  if (state.isProcessing) return;
  
  setStatus('processing', 'Capturing selection...');
  state.isProcessing = true;
  
  try {
    // 1. Capture text from focused window
    const result = await window.electronAPI.captureSelection();
    
    if (!result || !result.text || !result.text.trim()) {
      setStatus('ready', 'No text selected');
      showToast('Please highlight some text in another app first', 'warning');
      return;
    }
    
    const { text, windowContext } = result;
    console.log('Captured Text:', text, 'Context:', windowContext);
    setStatus('processing', 'AI is analyzing...');
    showToast(`Analyzing selection from ${windowContext || 'other app'}...`, 'success');
    
    // 2. Generate AI response
    const aiResponse = await generateAiResponse(text.trim(), windowContext);
    
    if (aiResponse) {
      // Clear and show new content
      elements.transcriptionText.textContent = aiResponse;
      
      // Auto-type if enabled
      if (state.autoType) {
        await window.electronAPI.typeText(aiResponse);
      }
      
      setStatus('ready', 'Analysis complete');
      updateAiToolbarVisibility();
      showToast('AI analysis complete!', 'success');
    } else {
      setStatus('ready', 'AI returned no response');
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

    // Update UI
    setStatus('recording', 'Listening...');
    elements.micButton.classList.add('recording');
    elements.micRing.classList.add('active');
    elements.micContainer.classList.add('recording');
    elements.micIcon.classList.add('hidden');
    elements.stopIcon.classList.remove('hidden');
    elements.waveformLeft.classList.add('active');
    elements.waveformRight.classList.add('active');

    // Start audio visualization
    setupAudioVisualization(state.audioStream);

  } catch (error) {
    console.error('Failed to start recording:', error);
    setStatus('error', 'Microphone access denied');
    showToast('Could not access microphone. Please grant permission.', 'error');
  }
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }

  if (state.audioStream) {
    state.audioStream.getTracks().forEach(track => track.stop());
    state.audioStream = null;
  }

  state.isRecording = false;
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
function setupAudioVisualization(stream) {
  state.audioContext = new AudioContext();
  state.analyser = state.audioContext.createAnalyser();
  const source = state.audioContext.createMediaStreamSource(stream);
  source.connect(state.analyser);
  state.analyser.fftSize = 64;

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
  setStatus('processing', 'Transcribing...');

  try {
    let text = '';

    switch (state.engine) {
      case 'local-whisper':
        text = await transcribeWithLocalWhisper(audioBlob);
        break;
      case 'openai':
        text = await transcribeWithOpenAI(audioBlob);
        break;
      case 'google-cloud':
        text = await transcribeWithGoogleCloud(audioBlob);
        break;
      default:
        text = await transcribeWithLocalWhisper(audioBlob);
    }

    if (text && text.trim()) {
      // Display transcription
      const currentText = elements.transcriptionText.textContent;
      const separator = currentText && currentText.trim() ? ' ' : '';
      elements.transcriptionText.textContent = (currentText || '') + separator + text.trim();

      // Auto-type if enabled
      if (state.autoType) {
        await window.electronAPI.typeText(text.trim());
      }

      setStatus('ready', 'Done! Ready for next input');
      updateAiToolbarVisibility();
      showToast('Transcription complete!', 'success');
    } else {
      setStatus('ready', 'No speech detected');
      showToast('No speech detected. Try again.', 'error');
    }
  } catch (error) {
    console.error('Transcription error:', error);
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
  // Show progress UI
  elements.progressContainer.classList.remove('hidden');
  elements.progressText.textContent = 'Preparing audio...';
  elements.progressFill.style.width = '5%';

  try {
    // Load model if needed
    if (!localWhisperEngine) {
      setStatus('processing', 'Loading Whisper model...');
      elements.progressText.textContent = 'Loading Whisper library...';
      elements.progressFill.style.width = '10%';

      try {
        // Import the browser-compatible build from node_modules
        const transformers = await import('./node_modules/@huggingface/transformers/dist/transformers.js');

        elements.progressFill.style.width = '30%';
        elements.progressText.textContent = 'Downloading Whisper model (first time only)...';

        localWhisperEngine = await transformers.pipeline(
          'automatic-speech-recognition',
          'onnx-community/whisper-tiny', // Multilingual model
          {
            dtype: 'q8',
            device: 'wasm'
          }
        );

        elements.progressFill.style.width = '90%';
        elements.progressText.textContent = 'Model ready!';
      } catch (err) {
        console.error('Failed to load Whisper model:', err);
        throw new Error('Failed to load Whisper model: ' + err.message);
      }
    }

    // Convert audio blob to float32 array
    elements.progressText.textContent = 'Transcribing...';
    elements.progressFill.style.width = '60%';
    const audioData = await audioBlobToFloat32(audioBlob);

    // Multilingual whisper supports auto-detection if language is omitted or null
    const options = {};
    if (!state.autoDetectLanguage) {
      options.language = state.settings.language || 'en';
    } else {
      options.language = null; // Explicitly use auto-detect
    }
    
    // Set task based on translation toggle
    options.task = state.translateToEnglish ? 'translate' : 'transcribe';
    
    console.log('Local Whisper Transcription Options:', options);
    const result = await localWhisperEngine(audioData, options);

    elements.progressFill.style.width = '100%';
    elements.progressText.textContent = 'Done!';
    await new Promise(r => setTimeout(r, 300));

    return result.text || '';
  } finally {
    elements.progressContainer.classList.add('hidden');
  }
}

// --- OpenAI Whisper API ---
async function transcribeWithOpenAI(audioBlob) {
  const apiKey = state.settings.openaiApiKey;
  if (!apiKey) {
    throw new Error('OpenAI API key not set. Go to Settings to add your key.');
  }

  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  formData.append('model', 'whisper-1');
  
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

// ============================================
// Audio Utilities
// ============================================
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

function toggleSettings() {
  const isHidden = !elements.settingsPanel.classList.contains('visible');
  if (isHidden) {
    elements.settingsPanel.classList.remove('hidden');
    // Force reflow
    elements.settingsPanel.offsetHeight;
    elements.settingsPanel.classList.add('visible');
    elements.mainContent.classList.add('slide-out');
  } else {
    elements.settingsPanel.classList.remove('visible');
    elements.mainContent.classList.remove('slide-out');
    setTimeout(() => {
      elements.settingsPanel.classList.add('hidden');
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
    bgOpacity: parseFloat(elements.bgOpacitySlider.value)
  };

  await window.electronAPI.saveSettings(settings);
  state.settings = settings;
  state.engine = settings.engine;
  state.autoType = settings.autoType;
  state.autoDetectLanguage = settings.autoDetectLanguage;
  state.translateToEnglish = settings.translateToEnglish;

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
    bgOpacity: parseFloat(elements.bgOpacitySlider.value)
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
  
  // Keep settings toggles in sync
  elements.autoDetectToggleSettings.checked = state.autoDetectLanguage;
  elements.translateToggleSettings.checked = state.translateToEnglish;
  
  console.log('Quick settings saved:', settings);
}

// ============================================
// AI Text Actions
// ============================================

function updateAiToolbarVisibility() {
  const hasText = elements.transcriptionText.textContent.trim().length > 0;
  
  // Always show the toolbar (because the Analyze button is always there)
  elements.aiToolbar.classList.remove('hidden');
  
  // Toggle other AI buttons based on text presence
  elements.aiFixBtn.classList.toggle('hidden', !hasText);
  elements.aiRefineBtn.classList.toggle('hidden', !hasText);
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
    refining: "Rephrase the following text to be clearer, more concise, and have a better flow. Preserve the original intent. Return ONLY the refined text.",
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

  const success = await window.electronAPI.typeText(text);
  if (success) {
    showToast('Text typed into focused app!', 'success');
  } else {
    showToast('Failed to type text', 'error');
  }
}

function clearTranscription() {
  elements.transcriptionText.textContent = '';
  updateAiToolbarVisibility();
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'success') {
  // Remove existing toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  // Remove after 2.5s
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 2500);
}

// ============================================
// Start
// ============================================
init();
