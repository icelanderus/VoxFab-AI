/**
 * Local Whisper Engine - runs in Main Process
 * Uses @huggingface/transformers to run Whisper model locally
 */

let pipeline = null;
let transcriber = null;
let isLoading = false;

async function loadModel(onProgress) {
  if (transcriber) return transcriber;
  if (isLoading) {
    // Wait for existing load
    while (isLoading) {
      await new Promise(r => setTimeout(r, 200));
    }
    return transcriber;
  }

  isLoading = true;

  try {
    if (onProgress) onProgress('Loading Whisper library...', 10);

    // Dynamic import for ESM module
    const transformers = await import('@huggingface/transformers');
    pipeline = transformers.pipeline;

    if (onProgress) onProgress('Downloading Whisper model (first time only)...', 30);

    transcriber = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      {
        dtype: 'q8',
        device: 'wasm'
      }
    );

    if (onProgress) onProgress('Model ready!', 100);
    return transcriber;
  } catch (err) {
    console.error('Failed to load Whisper model:', err);
    throw err;
  } finally {
    isLoading = false;
  }
}

async function transcribe(audioFloat32Array, language = 'en') {
  const model = await loadModel();

  const result = await model(audioFloat32Array, {
    language: language,
    task: 'transcribe'
  });

  return result.text || '';
}

module.exports = { loadModel, transcribe };
