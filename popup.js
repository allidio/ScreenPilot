/**
 * Screen Pilot Popup - Voice-to-action UI with hold-to-talk recording
 * Manages microphone input, audio recording, and TTS feedback
 */

// ============================================================================
// Configuration & Constants
// ============================================================================

const CONFIG = {
  VAD_POLL_MS: 100,      // Voice activity detection polling interval (ms)
  VAD_THRESHOLD: 0.02,   // RMS amplitude threshold for speech detection
};

// ============================================================================
// State Management
// ============================================================================

const state = {
  spaceHeld: false,
  recorder: null,
  stream: null,
  isSpeaking: false,
  audioContext: null,
  analyser: null,
  sourceNode: null,
  vadInterval: null,
  voiceDetected: false,
};

// ============================================================================
// DOM Initialization & Event Setup
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  initializeUI();
  setupEventListeners();
});

/**
 * Initialize UI by restoring saved API key and setting initial state
 */
function initializeUI() {
  chrome.storage.local.get(['openai_key'], (res) => {
    if (res.openai_key) {
      document.getElementById('apiKeyInput').value = res.openai_key;
    }
  });
  setStatus('Idle');
}

/**
 * Setup all event listeners for buttons, keyboard, and service worker messages
 */
function setupEventListeners() {
  document.getElementById('saveKeyBtn').addEventListener('click', handleSaveKey);

  const stopSpeakBtn = document.getElementById('stopSpeak');
  if (stopSpeakBtn) {
    stopSpeakBtn.addEventListener('click', handleStopSpeaking);
  }

  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
  chrome.runtime.onMessage.addListener(handleServiceWorkerMessage);
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handle API key save button click
 */
function handleSaveKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    alert('Please enter a valid API key.');
    return;
  }
  chrome.storage.local.set({ openai_key: key }, () => {
    alert('API key saved successfully.');
  });
}

/**
 * Handle stop speaking button click
 */
function handleStopSpeaking() {
  try {
    chrome.tts.stop();
    setStatus('Stopped speaking');
  } catch (e) {
    console.error('Failed to stop TTS:', e);
  }
  document.getElementById('stopSpeak').style.display = 'none';
  state.isSpeaking = false;
}

/**
 * Handle keydown events for hold-to-talk (Space) and escape (Esc)
 */
function handleKeyDown(e) {
  const isInputElement = document.activeElement && 
    ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
  if (isInputElement) return;

  // Space key: start listening (hold-to-talk)
  if ((e.code === 'Space' || e.key === ' ') && !e.repeat && !state.spaceHeld) {
    e.preventDefault();
    state.spaceHeld = true;
    if (!state.recorder) startListening();
  }

  // Escape key: stop speaking
  if (e.key === 'Escape' || e.code === 'Escape') {
    if (state.isSpeaking) {
      handleStopSpeaking();
    }
  }
}

/**
 * Handle keyup events to stop recording when Space is released
 */
function handleKeyUp(e) {
  if ((e.code === 'Space' || e.key === ' ') && state.spaceHeld) {
    e.preventDefault();
    state.spaceHeld = false;
    if (state.recorder) stopListening('stopped (space released)');
  }
}

/**
 * Handle STATUS messages from service worker
 */
function handleServiceWorkerMessage(msg) {
  if (!msg || msg.type !== 'STATUS' || !msg.payload) return;

  const status = msg.payload.status;
  setStatus(status);

  // Show spinner for active statuses
  const activeStatuses = ['transcribing', 'interpreting', 'requesting_screen', 'interpreting_compact'];
  if (activeStatuses.includes(status)) {
    showSpinner(true, status.charAt(0).toUpperCase() + status.slice(1));
  } else if (status === 'speaking') {
    showSpinner(true, 'Speaking...');
    const stopSpeakBtn = document.getElementById('stopSpeak');
    if (stopSpeakBtn) stopSpeakBtn.style.display = 'inline-block';
    state.isSpeaking = true;
  } else if (['completed', 'error', 'no screen'].includes(status)) {
    showSpinner(false);
    const stopSpeakBtn = document.getElementById('stopSpeak');
    if (stopSpeakBtn) stopSpeakBtn.style.display = 'none';
    state.isSpeaking = false;
  }
}

// ============================================================================
// Microphone & Recording Control
// ============================================================================

/**
 * Start listening for audio input
 */
function startListening() {
  // Prevent duplicate starts
  if (state.recorder) return;

  (async () => {
    try {
      setStatus('Acquiring microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.stream = stream;
      const recorder = new MediaRecorder(stream);
      state.recorder = recorder;
      let chunks = [];

      recorder.ondataavailable = (e) => chunks.push(e.data);

      recorder.onstop = async () => {
        setStatus('Sending audio...');
        showSpinner(false);
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        state.recorder = null;
        cleanupAudio();
        sendAudioToServiceWorker(buf);
      };

      // UI: hold-to-talk mode (no start/stop buttons needed)
      setStatus('Listening...');
      clearResult();
      showSpinner(true, 'Listening...');
      recorder.start();
      setupVoiceActivityDetection();
    } catch (err) {
      setStatus('Error: ' + err.message);
      state.recorder = null;
      try {
        stopStream(state.stream);
      } catch (e) {
        console.error('Error stopping stream:', e);
      }
      state.stream = null;
    }
  })();
}

/**
 * Stop listening and cleanup resources
 */
function stopListening(reason) {
  if (!state.recorder) return;
  try {
    state.recorder.stop();
  } catch (e) {
    console.error('Error stopping recorder:', e);
  }
  cleanupAudio();
  try {
    showSpinner(false);
  } catch (e) {
    console.error('Error hiding spinner:', e);
  }
  setStatus(reason || 'stopped');
}

/**
 * Cleanup audio resources (VAD, audio context, stream)
 */
function cleanupAudio() {
  try {
    if (state.vadInterval) clearInterval(state.vadInterval);
  } catch (e) {
    console.error('Error clearing VAD interval:', e);
  }
  state.vadInterval = null;

  try {
    if (state.audioContext) {
      state.audioContext.close().catch(() => {});
    }
  } catch (e) {
    console.error('Error closing audio context:', e);
  }
  state.audioContext = null;
  state.analyser = null;
  state.sourceNode = null;

  try {
    stopStream(state.stream);
  } catch (e) {
    console.error('Error stopping stream:', e);
  }
  state.stream = null;
}

/**
 * Stop all audio tracks in the stream
 */
function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch (e) {
      console.error('Error stopping track:', e);
    }
  });
}

/**
 * Send audio buffer to service worker for transcription and interpretation
 */
function sendAudioToServiceWorker(buf) {
  chrome.runtime.sendMessage({
    type: 'AUDIO_DATA',
    payload: { audioBytes: [...new Uint8Array(buf)] }
  }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message);
      return;
    }
    if (!response) {
      setStatus('No response from background');
      return;
    }
    if (response.error) {
      const code = response.code ? ` (${response.code})` : '';
      setStatus(`Error: ${response.error}${code}`);
      showResult(response);
      return;
    }

    setStatus('Completed');
    showResult(response);
  });
}

// ============================================================================
// Voice Activity Detection (VAD)
// ============================================================================

/**
 * Setup voice activity detection to provide UI feedback during recording
 */
function setupVoiceActivityDetection() {
  try {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    state.sourceNode = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 2048;
    state.sourceNode.connect(state.analyser);

    const data = new Uint8Array(state.analyser.fftSize);
    let consecutiveFrames = 0;

    state.vadInterval = setInterval(() => {
      state.analyser.getByteTimeDomainData(data);
      const rms = calculateRMS(data);

      if (rms > CONFIG.VAD_THRESHOLD) {
        consecutiveFrames++;
        if (consecutiveFrames > 1 && !state.voiceDetected) {
          state.voiceDetected = true;
          setStatus('Recording...');
          showSpinner(true, 'Recording...');
        }
      } else {
        consecutiveFrames = 0;
        if (state.voiceDetected) {
          state.voiceDetected = false;
          setStatus('Listening...');
          showSpinner(true, 'Listening...');
        }
      }
    }, CONFIG.VAD_POLL_MS);
  } catch (e) {
    console.warn('VAD setup failed; continuing without speech detection UI', e);
  }
}

/**
 * Calculate RMS (Root Mean Square) amplitude from audio data
 */
function calculateRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = (data[i] - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}

// ============================================================================
// UI Utilities
// ============================================================================

/**
 * Update status text display
 */
function setStatus(txt) {
  const el = document.getElementById('statusText');
  if (el) el.textContent = txt;
}

/**
 * Show or hide the animated spinner
 */
function showSpinner(visible, text) {
  const spinner = document.getElementById('spinner');
  const spinnerText = document.getElementById('spinnerText');
  if (!spinner) return;

  if (visible) {
    spinner.classList.add('active');
    if (spinnerText && text) spinnerText.textContent = text;
  } else {
    spinner.classList.remove('active');
  }
}

/**
 * Display result from service worker (actions or error)
 */
function showResult(obj) {
  const container = document.getElementById('result');
  const summary = document.getElementById('summary');
  const raw = document.getElementById('raw');
  if (!container) return;

  if (!obj) {
    clearResult();
    return;
  }

  container.classList.remove('hidden');

  // If LLM returned a summary action, render it nicely with replay button
  if (obj.action && obj.action.action === 'summary') {
    const text = obj.action.value || '';
    summary.classList.remove('hidden');
    summary.textContent = text;

    removeExistingReplayButton();
    const btn = createReplayButton(text);
    summary.appendChild(btn);

    raw.textContent = JSON.stringify(obj, null, 2);
  } else {
    summary.classList.add('hidden');
    raw.textContent = JSON.stringify(obj, null, 2);
  }
}

/**
 * Clear result display
 */
function clearResult() {
  const container = document.getElementById('result');
  const summary = document.getElementById('summary');
  const raw = document.getElementById('raw');

  if (container) container.classList.add('hidden');
  if (summary) {
    summary.classList.add('hidden');
    summary.textContent = '';
    removeExistingReplayButton();
  }
  if (raw) raw.textContent = '';
}

/**
 * Remove any existing replay button from summary
 */
function removeExistingReplayButton() {
  const existing = document.getElementById('replaySpeak');
  if (existing) existing.remove();
}

/**
 * Create a replay button for TTS summary
 */
function createReplayButton(text) {
  const btn = document.createElement('button');
  btn.id = 'replaySpeak';
  btn.className = 'btn';
  btn.style.marginTop = '8px';
  btn.textContent = 'Replay';
  btn.addEventListener('click', () => {
    try {
      // Enable SSML parsing for richer speech output
      chrome.tts.speak(text, { enqueue: false, lang: 'en-US' });
    } catch (e) {
      console.error('Error replaying TTS:', e);
    }
  });
  return btn;
}
