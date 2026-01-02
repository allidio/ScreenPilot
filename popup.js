document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["openai_key"], (res) => {
    if (res.openai_key) {
      document.getElementById("apiKeyInput").value = res.openai_key;
    }
  });
  setStatus('Idle');
  // stop speaking button
  const stopSpeakBtn = document.getElementById('stopSpeak');
  if(stopSpeakBtn){
    stopSpeakBtn.addEventListener('click', () => {
      try{ chrome.tts.stop(); setStatus('Stopped speaking'); }catch(e){ console.error(e); }
      stopSpeakBtn.style.display = 'none';
      _isSpeaking = false;
    });
  }
});

document.getElementById("saveKeyBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) {
    alert("Please enter a valid API key.");
    return;
  }
  chrome.storage.local.set({ openai_key: key }, () => {
    alert("API key saved successfully.");
  });
});

// Start/Stop buttons removed — hold Space to talk (handled by key events below)

// keyboard shortcuts: Space to start, Escape to stop
// New: Hold-to-talk flow: press+hold Space to record; release Space to stop.
let _spaceHeld = false;
document.addEventListener('keydown', (e) => {
  const active = document.activeElement && ['INPUT','TEXTAREA'].includes(document.activeElement.tagName);
  if(active) return; // don't interfere when typing in inputs

  // Space hold -> start listening on first keydown (ignore repeats)
  if ((e.code === 'Space' || e.key === ' ') && !e.repeat && !_spaceHeld) {
    e.preventDefault();
    _spaceHeld = true;
    // If not already recording, start
    if(!_recorder) startListening();
  }

  // Escape now only stops speaking (if playing)
  if (e.key === 'Escape' || e.code === 'Escape'){
    if(_isSpeaking){
      try{ chrome.tts.stop(); setStatus('Stopped speaking'); }catch(err){ console.error(err); }
      const sb = document.getElementById('stopSpeak'); if(sb) sb.style.display = 'none';
      _isSpeaking = false;
    }
  }
});

// Stop listening when Space is released
document.addEventListener('keyup', (e) => {
  if ((e.code === 'Space' || e.key === ' ') && _spaceHeld) {
    e.preventDefault();
    _spaceHeld = false;
    if(_recorder) stopListening('stopped (space released)');
  }
});

let _recorder = null;
let _stream = null;
let _isSpeaking = false;
let _audioContext = null;
let _analyser = null;
let _sourceNode = null;
let _vadInterval = null;
let _lastSoundTime = 0;
let _isVoiceDetected = false;
const VAD_POLL_MS = 100;
const VAD_THRESHOLD = 0.02; // amplitude threshold

function startListening(){
  // avoid duplicate starts
  if(_recorder) return;
  (async ()=>{
    try {
      setStatus('Acquiring microphone...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _stream = stream;
      const recorder = new MediaRecorder(stream);
      _recorder = recorder;
      let chunks = [];

      recorder.ondataavailable = e => chunks.push(e.data);

      recorder.onstop = async () => {
        setStatus('Sending audio...');
        showSpinner(false);
        const blob = new Blob(chunks, { type: "audio/webm" });
        const buf = await blob.arrayBuffer();
        _recorder = null;
        // cleanup VAD and audio context
        try{ if(_vadInterval) clearInterval(_vadInterval); }catch(e){}
        _vadInterval = null;
        try{ if(_audioContext) { _audioContext.close().catch(()=>{}); } }catch(e){}
        _audioContext = null; _analyser = null; _sourceNode = null;
        try{ stopStream(_stream); }catch(e){}
        _stream = null;
        // no fixed timeouts—hold-to-talk controls stopping

        // send audio and wait for service worker response
        chrome.runtime.sendMessage({
          type: "AUDIO_DATA",
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
            setStatus('Error: ' + response.error + (response.code?(' ('+response.code+')') : ''));
            showResult(response);
            return;
          }

          setStatus('Completed');
          showResult(response);
          // ready for next hold-to-talk
        });
      };

      // UI: we don't show start/stop buttons; use hold-to-talk instead
      setStatus('Listening...');
      showResult(null);
      showSpinner(true, 'Listening...');

      // start recording
      recorder.start();

      // Setup simple VAD (voice activity detection) to update UI only
      try{
        _audioContext = new (window.AudioContext || window.webkitAudioContext)();
        _sourceNode = _audioContext.createMediaStreamSource(stream);
        _analyser = _audioContext.createAnalyser();
        _analyser.fftSize = 2048;
        _sourceNode.connect(_analyser);
        const data = new Uint8Array(_analyser.fftSize);
        _lastSoundTime = Date.now();
        let consecutiveFrames = 0;
        _vadInterval = setInterval(()=>{
          _analyser.getByteTimeDomainData(data);
          // compute normalized RMS
          let sum = 0;
          for(let i=0;i<data.length;i++){
            const v = (data[i] - 128) / 128;
            sum += v*v;
          }
          const rms = Math.sqrt(sum / data.length);
          if(rms > VAD_THRESHOLD){
            consecutiveFrames++;
            _lastSoundTime = Date.now();
            if(consecutiveFrames > 1){
              // user is speaking
              // update UI to indicate speech activity but DO NOT stop on silence
              _isVoiceDetected = true;
              setStatus('Recording...');
              showSpinner(true, 'Recording...');
            }
          } else {
            consecutiveFrames = 0;
            if(_isVoiceDetected){
              // user became silent; keep listening (hold-to-talk still controls stop)
              _isVoiceDetected = false;
              setStatus('Listening...');
              showSpinner(true, 'Listening...');
            }
          }
          // NOTE: We intentionally do NOT stop listening on silence; user must release Space or press Stop.
        }, VAD_POLL_MS);
      } catch(e){
        // VAD not available; we'll still follow hold-to-talk behavior
        console.warn('VAD setup failed; continuing without speech-activity UI', e);
      }
    } catch (err) {
      setStatus('Error: ' + err.message);
      _recorder = null;
      try{ stopStream(_stream); }catch(e){}
      _stream = null;
    }
  })();
}

function stopListening(reason){
  if(!_recorder) return;
  try{ _recorder.stop(); }catch(e){}
  // clear vad and timeouts immediately
  try{ if(_vadInterval) clearInterval(_vadInterval); }catch(e){}
  _vadInterval = null;
  try{ showSpinner(false); }catch(e){}
  setStatus(reason || 'stopped');
  try{ if(_audioContext){ _audioContext.close().catch(()=>{}); } }catch(e){}
  _audioContext = null; _analyser = null; _sourceNode = null;
}

function stopStream(stream){
  if(!stream) return;
  stream.getTracks().forEach(t=>{ try{ t.stop(); }catch(e){} });
}

// listen for STATUS messages from background/service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'STATUS' && msg.payload && msg.payload.status) {
    const s = msg.payload.status;
    setStatus(s);
    // show spinner for active statuses
    if(s === 'transcribing' || s === 'interpreting' || s === 'requesting_screen' || s === 'interpreting_compact'){
      showSpinner(true, s.charAt(0).toUpperCase() + s.slice(1));
    } else if(s === 'speaking'){
      showSpinner(true, 'Speaking...');
      const sb = document.getElementById('stopSpeak'); if(sb) sb.style.display = 'inline-block';
      _isSpeaking = true;
    } else if(s === 'completed' || s === 'error' || s === 'no screen'){
      showSpinner(false);
      const sb = document.getElementById('stopSpeak'); if(sb) sb.style.display = 'none';
      _isSpeaking = false;
    }
  }
});

function setStatus(txt){
  const el = document.getElementById('status');
  if(el) el.textContent = 'Status: ' + txt;
}

function showSpinner(visible, text){
  const spinner = document.getElementById('spinner');
  const spinnerText = document.getElementById('spinnerText');
  if(!spinner) return;
  spinner.style.display = visible ? 'block' : 'none';
  if(visible && spinnerText && text) spinnerText.textContent = text;
}

function showResult(obj){
  const container = document.getElementById('result');
  const summary = document.getElementById('summary');
  const raw = document.getElementById('raw');
  if(!container) return;
  if(!obj){ container.style.display = 'none'; summary.style.display='none'; raw.textContent = ''; return; }
  container.style.display = 'block';
  // if LLM returned a summary action, render nicely
  if(obj.action && obj.action.action === 'summary'){
    const text = obj.action.value || '';
    summary.style.display = 'block';
    summary.textContent = text;
    // replay button
    let existing = document.getElementById('replaySpeak');
    if(existing) existing.remove();
    const btn = document.createElement('button');
    btn.id = 'replaySpeak';
    btn.className = 'btn';
    btn.style.marginTop = '8px';
    btn.textContent = 'Replay';
    btn.addEventListener('click', ()=>{
      try{ chrome.tts.speak(text); }catch(e){ console.error(e); }
    });
    summary.appendChild(document.createElement('div'));
    summary.appendChild(btn);
    // show raw JSON below as well
    raw.textContent = JSON.stringify(obj, null, 2);
  } else {
    summary.style.display='none';
    raw.textContent = JSON.stringify(obj, null, 2);
  }
}

function disableStart(){
  // removed - hold-to-talk only
}

function enableStart(){
  // removed - hold-to-talk only
}