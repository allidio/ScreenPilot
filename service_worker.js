async function getKey(){
  return new Promise(res =>
    chrome.storage.local.get(["openai_key"], x => res(x.openai_key || ""))
  );
}

async function transcribe(bytes){
  const blob=new Blob([new Uint8Array(bytes)],{type:"audio/webm"});
  const file=new File([blob],"audio.webm");
  const fd=new FormData();
  fd.append("file",file);
  fd.append("model","gpt-4o-transcribe");

  const key=await getKey();
  if(!key){ console.error("No API key set."); return ""; }

  const r=await fetch("https://api.openai.com/v1/audio/transcriptions",{
    method:"POST",
    headers:{Authorization:"Bearer "+key},
    body:fd
  });
  const j=await r.json();
  return j.text;
}

// Convert a data URL (like the one from chrome.tabs.captureVisibleTab) into a Blob
async function dataUrlToBlob(dataUrl){
  // fetch handles decoding the data URL for us
  const resp = await fetch(dataUrl);
  const b = await resp.blob();
  return b;
}

// Resize an image Blob using OffscreenCanvas/createImageBitmap (runs in the service worker)
async function resizeImageBlob(blob, maxDim = 1200){
  try{
    const bitmap = await createImageBitmap(blob);
    const sw = bitmap.width, sh = bitmap.height;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const out = await off.convertToBlob({type:'image/jpeg', quality:0.8});
    return out;
  }catch(e){
    console.warn('resizeImageBlob failed, returning original blob', e);
    return blob;
  }
}

// Upload a blob to the Files API and return the File object
async function uploadFileBlob(blob, filename = 'screenshot.jpg', purpose = 'user_data', key){
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('purpose', purpose);
  try{
    const r = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: fd
    });
    if(!r.ok){
      const txt = await r.text().catch(()=>'<unreadable body>');
      console.error('File upload failed', r.status, r.statusText, txt);
      throw new Error('File upload failed: '+r.status+' '+r.statusText+' - '+(txt.slice?txt.slice(0,200):txt));
    }
    return await r.json();
  }catch(e){
    console.error('uploadFileBlob error', e);
    throw e;
  }
}

// Delete a file by id
async function deleteFileId(fileId, key){
  try{
    const r = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + key }
    });
    if(!r.ok){
      const txt = await r.text().catch(()=>'<unreadable body>');
      console.warn('deleteFileId failed', fileId, r.status, r.statusText, txt);
    }
    return await r.json().catch(()=>null);
  }catch(e){
    console.warn('deleteFileId error', e);
  }
}

async function sendMessageToTab(tabId, msg, timeout = 2500){
  return new Promise((resolve, reject) => {
    let finished = false;
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (finished) return;
      finished = true;
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(resp);
    });
    setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error('timeout waiting for tab response'));
    }, timeout);
  });
}

async function sendMessageToTabWithInject(tabId, msg, timeout = 2500, maxRetries = 2){
  let attempt = 0;
  let lastErr = null;
  while(attempt <= maxRetries){
    try{
      return await sendMessageToTab(tabId, msg, timeout);
    } catch(err){
      lastErr = err;
      const m = err && err.message ? err.message : '';
      // If there's no receiver, try to inject the content script and retry
      if(/Receiving end does not exist|Could not establish connection/i.test(m)){
        console.warn('No content script in tab, trying to inject...', tabId, m);
        try{
          await chrome.scripting.executeScript({target:{tabId}, files:["content_script.js"]});
          // after injection, retry immediately
          attempt++;
          continue;
        } catch(injectErr){
          throw new Error('Injection failed: ' + (injectErr && injectErr.message ? injectErr.message : String(injectErr)));
        }
      }

      // Handle flaky "message port closed" errors by retrying briefly
      if(/message port closed before a response|The message port closed before a response/i.test(m)){
        if(attempt < maxRetries){
          await new Promise(r => setTimeout(r, 200));
          attempt++;
          continue;
        }
      }

      // Retry on timeout once
      if(/timeout waiting for tab response/i.test(m) && attempt < maxRetries){
        await new Promise(r => setTimeout(r, 200));
        attempt++;
        continue;
      }

      // otherwise give up
      throw err;
    }
  }
  throw lastErr || new Error('sendMessageToTabWithInject failed');
}

async function requestScreen(tabId){
  try{
    const screen = await sendMessageToTabWithInject(tabId, {type: "REQUEST_SCREEN"});
    if(!screen) return null;
    // Attach basic platform metadata
    screen.platform = 'chrome';
    // Try to capture a visible screenshot (jpeg quality 50 to keep size reasonable)
    try{
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(tab.windowId, {format:'jpeg', quality:50}, d => {
          if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(d);
        });
      });
      screen.screenshot = dataUrl;
    } catch(scrErr){
      console.warn('Screenshot capture failed:', scrErr);
      screen.screenshot = null;
    }
    return screen;
  } catch(e){
    console.error('requestScreen failed for tab', tabId, e);
    return null;
  }
}

async function interpretCommand(transcript,screen,key){
  if(!key) throw new Error('No API key available for interpretCommand');

  // Build a FormData request to /v1/responses and attach screenshot as a file (no base64 in JSON)
  const fd = new FormData();
  fd.append('model', 'gpt-4.1');

  // Prepare a clean screen object for the prompt: replace screenshot data URL with a filename marker
  const screenForPrompt = Object.assign({}, screen);
  if(screenForPrompt.screenshot) screenForPrompt.screenshot = 'screenshot.jpg (attached)';

  const systemPrompt = "Return ONLY JSON: an object with an 'actions' array: {\\\"actions\\\":[{action,selector,value,amount}]}. action must be one of: click, type, scroll, summary. For a single action return an array with one element. You may use the attached screenshot file named 'screenshot.jpg' to better locate elements or confirm UI state. Use 'type' for entering text (do not return 'input').";

  // The Responses API accepts 'input' — we'll construct a JSON request and reference an uploaded file by file_id
  const inputMessages = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'SCREEN:' + JSON.stringify(screenForPrompt) },
        // file input will be appended below if we uploaded one
        { type: 'input_text', text: 'USER:' + transcript }
      ]
    }
  ];

  let uploadedFileId = null;
  if(screen && screen.screenshot){
    try{
      const originalBlob = await dataUrlToBlob(screen.screenshot);
      const resized = await resizeImageBlob(originalBlob, 1200);
      // Upload as a vision file so images are accepted as image inputs
      const uploaded = await uploadFileBlob(resized, 'screenshot.jpg', 'vision', key);
      uploadedFileId = uploaded && uploaded.id;
      if(uploadedFileId){
        // Insert image input reference right after the SCREEN text
        inputMessages[0].content.splice(1, 0, { type: 'input_image', file_id: uploadedFileId, detail: 'high' });
      }
    }catch(e){
      console.warn('Failed to upload/rescale screenshot, continuing without it', e);
    }
  }

  let r;
  try{
    r = await fetch('https://api.openai.com/v1/responses',{
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key
      },
      body: JSON.stringify({ model: 'gpt-4.1', input: inputMessages, instructions: systemPrompt })
    });
  }catch(netErr){
    // Try to clean up uploaded file if present
    if(uploadedFileId) try{ await deleteFileId(uploadedFileId, key); }catch(e){}
    console.error('Network error calling Responses API:', netErr);
    throw new Error('Network error calling Responses API: '+ (netErr && netErr.message ? netErr.message : String(netErr)));
  }

  if(!r.ok){
    // Clean up uploaded file if present
    if(uploadedFileId) try{ await deleteFileId(uploadedFileId, key); }catch(e){}

    let parsedErrBody = null;
    const bodyText = await r.text().catch(()=>'<unreadable body>');
    try{ parsedErrBody = JSON.parse(bodyText); } catch(e){}
    console.error('Responses API responded with non-OK status', r.status, r.statusText, parsedErrBody || (bodyText.slice ? bodyText.slice(0,200) : bodyText));

    const err = new Error('Responses API call failed: '+r.status+' '+r.statusText+' - '+(bodyText.slice?bodyText.slice(0,200):String(bodyText)));
    if(parsedErrBody && parsedErrBody.error){
      err.code = parsedErrBody.error.code || parsedErrBody.error.type || null;
      err.details = parsedErrBody.error;
    }
    throw err;
  }

  if(!r.ok){
    let parsedErrBody = null;
    const bodyText = await r.text().catch(()=>'<unreadable body>');
    try{ parsedErrBody = JSON.parse(bodyText); } catch(e){}
    console.error('Responses API responded with non-OK status', r.status, r.statusText, parsedErrBody || (bodyText.slice ? bodyText.slice(0,200) : bodyText));

    const err = new Error('Responses API call failed: '+r.status+' '+r.statusText+' - '+(bodyText.slice?bodyText.slice(0,200):String(bodyText)));
    if(parsedErrBody && parsedErrBody.error){
      err.code = parsedErrBody.error.code || parsedErrBody.error.type || null;
      err.details = parsedErrBody.error;
    }
    throw err;
  }

  let j;
  try{ j = await r.json(); } catch(parseErr){
    const txt = await r.text().catch(()=>'<unreadable body>');
    console.error('Failed to parse Responses API JSON response:', parseErr, txt.slice ? txt.slice(0,200) : txt);
    throw new Error('Failed to parse Responses API JSON response: '+ (parseErr && parseErr.message ? parseErr.message : String(parseErr)));
  }

  // Extract textual content from Responses API output (flexible parser)
  let contentText = null;
  if(Array.isArray(j.output) && j.output.length > 0 && Array.isArray(j.output[0].content)){
    for(const c of j.output[0].content){
      if(typeof c === 'string') { contentText = c; break; }
      if(c && c.text) { contentText = c.text; break; }
      if(c && c.type === 'output_text' && c.text) { contentText = c.text; break; }
    }
  }
  if(!contentText && j.output_text) contentText = j.output_text;
  if(!contentText && j.output && typeof j.output === 'string') contentText = j.output;
  if(!contentText && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) contentText = j.choices[0].message.content;

  if(!contentText) {
    console.error('Responses API returned no textual content:', j);
    throw new Error('Responses API returned no textual content');
  }

  // Parse JSON text returned by model
  let parsed;
  try{ parsed = JSON.parse(contentText); } catch(e){
    console.error('Responses API returned non-JSON content:', contentText);
    throw new Error('Responses API returned non-JSON content: '+ (contentText && contentText.length > 200 ? contentText.slice(0,200)+'...' : contentText));
  }

  // Normalize to an actions array
  let actions = [];
  if(Array.isArray(parsed)) actions = parsed;
  else if(parsed && Array.isArray(parsed.actions)) actions = parsed.actions;
  else if(parsed && parsed.action) actions = [parsed];
  else throw new Error('Responses API returned JSON but no actions found');

  // Cleanup: delete the uploaded screenshot file (best-effort)
  if(uploadedFileId){
    try{ await deleteFileId(uploadedFileId, key); }catch(e){ console.warn('Failed to delete uploaded file', uploadedFileId, e); }
  }

  return {actions};
}

chrome.runtime.onMessage.addListener(async(msg,s,sendResponse)=>{
  if(msg.type==="AUDIO_DATA"){
    try {
      const key = await getKey();
      const transcript = await transcribe(msg.payload.audioBytes);
      // notify UI (if open) about progress
      try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'transcribing'}}); }catch(e){}

      const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
      if(!tabs || tabs.length === 0){
        console.error("No active tab found to request screen from.");
        sendResponse({error: "no active tab"});
        return true;
      }

      const tab = tabs[0];
      if(!tab || !tab.id){
        console.error("Active tab returned is invalid:", tab);
        sendResponse({error: "invalid tab"});
        return true;
      }

      const screen = await requestScreen(tab.id);
      try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'requesting_screen'}}); }catch(e){}
      if(!screen){
        console.error("No screen data returned from content script for tab", tab.id);
        try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'no screen'}}); }catch(e){}
        sendResponse({error: "no screen"});
        return true;
      }

      try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'interpreting'}}); }catch(e){}
      // First try with the full screen payload
      let result;
      try{
        result = await interpretCommand(transcript,screen,key);
      } catch(err){
        console.warn('interpretCommand failed; checking for rate-limit or token errors', err && err.code ? err.code : err.message);
        // If the model rejected the request for being too large or rate-limited, try a compacted screen and retry once
        const shouldRetryCompact = err && (err.code === 'rate_limit_exceeded' || (err.message && /tokens|request too large|rate_limit/i.test(err.message)));
        if(shouldRetryCompact){
          try{
            try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'interpreting_compact'}}); }catch(e){}
            const compactScreen = {
              title: screen.title,
              url: screen.url,
              body: '', // drop body entirely for compact attempt
              interactables: (screen.interactables||[]).slice(0,10).map(i=>({tag:i.tag, text: (i.text||'').slice(0,100), selector:i.selector, visible:i.visible}))
            };
            result = await interpretCommand(transcript,compactScreen,key);
          } catch(err2){
            // still failing, surface original error details where possible
            console.error('Compact retry failed for interpretCommand:', err2);
            throw err2;
          }
        } else {
          throw err;
        }
      }

      const actions = (result && Array.isArray(result.actions)) ? result.actions : (Array.isArray(result) ? result : []);
      if(!Array.isArray(actions) || actions.length === 0){
        console.warn('No actions returned by LLM:', result);
        sendResponse({error:'no actions', raw: result});
        return true;
      }

      // Separate out 'summary' actions (spoken) and executable actions
      const spoken = [];
      const execActions = [];
      for(const a of actions){
        if(!a) continue;
        if(a.action === 'summary' || a.action === 'speak'){
          const text = (a.value && a.value.toString()) || '';
          if(text){
            try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'speaking'}}); }catch(e){}
            try{ chrome.tts.speak(text); spoken.push({status:'spoken', value:text}); }catch(e){ console.error('TTS failed for summary action:', e); spoken.push({status:'error', error:String(e)}); }
          } else {
            spoken.push({status:'skipped', reason:'no text'});
          }
        } else {
          // normalize aliases like 'input' -> 'type'
          if(a.action === 'input') a.action = 'type';
          execActions.push(a);
        }
      }

      // Execute non-summary actions (if any) in one batched message
      let execRes = null;
      if(execActions.length > 0){
        try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'executing'}}); }catch(e){}
        console.debug('Dispatching EXECUTE_ACTION to tab', tab.id, execActions);
        execRes = await sendMessageToTabWithInject(tab.id, {type: "EXECUTE_ACTION", payload: execActions}, 5000, 3);
        chrome.tts.speak("Action completed");
        try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'completed'}}); }catch(e){}
      } else {
        try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'completed_no_exec'}}); }catch(e){}
      }

      sendResponse({transcript, actions, spoken, execRes});
    } catch(err){
      console.error("Error handling AUDIO_DATA:", err);
      try{ chrome.runtime.sendMessage({type:'STATUS', payload:{status:'error', message: err && err.message ? err.message : String(err)}}); }catch(e){}
      // Include structured error details when available (e.g., rate limit code)
      const resp = { error: err && err.message ? err.message : String(err) };
      if(err && err.code) resp.code = err.code;
      if(err && err.details) resp.details = err.details;
      sendResponse(resp);
    }
  }
  return true;
});