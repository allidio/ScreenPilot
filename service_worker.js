/**
 * Screen Pilot Service Worker
 * Handles transcription, command interpretation, and action execution
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  TRANSCRIPTION_MODEL: 'gpt-4o-transcribe',
  INTERPRETATION_MODEL: 'gpt-4.1',
  SCREENSHOT_MAX_DIM: 1200,
  SCREENSHOT_QUALITY: 50,
  JPEG_QUALITY: 0.8,
  TAB_MESSAGE_TIMEOUT: 2500,
  TAB_INJECT_TIMEOUT: 5000,
  TAB_MAX_RETRIES: 2,
};

const SYSTEM_PROMPT = `Return ONLY JSON: an object with an 'actions' array: {"actions":[{action,selector,value,amount}]}. 
action must be one of: click, type, scroll, summary. 
You are helping visually impared users navigate this page. Chain actions in actions array to get the desired end output. 
You may use the attached screenshot file named 'screenshot.jpg' to better locate elements or confirm UI state. Always include a summary action at the end describing what was done.
For 'click' action, use 'selector' to specify the element to click.
For 'type' action, use 'selector' to specify the input field and 'value' for the text to enter.
For 'scroll' action, use 'amount' to specify pixels to scroll (positive for down, negative for up).
For 'summary' action, use 'value' to provide a brief summary of actions taken. Optionally use SSML markup for better speech output:
  - Use <speak> tags to wrap content
  - Use <emphasis level="strong">text</emphasis> for emphasis
  - Use <break time="500ms"/> for pauses
  - Use <prosody rate="slow">text</prosody> to control speaking rate
  Example: <speak>Login <emphasis level="strong">successful</emphasis>. <break time="500ms"/> Welcome back.</speak>

Examples:
1. To click a button: {"action":"click","selector":"#submit-button"}
2. To type text into an input field: {"action":"type","selector":"#search-box","value":"OpenAI"}
3. To scroll down 300 pixels: {"action":"scroll","amount":300}
4. To provide a summary with SSML: {"action":"summary","value":"<speak>Payment <emphasis level='strong'>confirmed</emphasis>.</speak>"}

Remember to always end with a summary action.
VERY IMPORTANT: Do not use css class or tag.class in selector attribute, always use IDs or unique attributes.
Use 'type' for entering text (do not return 'input').`;

// ============================================================================
// Storage & API Key Management
// ============================================================================

/**
 * Retrieve OpenAI API key from Chrome storage
 */
async function getKey() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['openai_key'], (x) => resolve(x.openai_key || ''))
  );
}

// ============================================================================
// Audio & Transcription
// ============================================================================

/**
 * Transcribe audio bytes using OpenAI whisper model
 */
async function transcribe(bytes) {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/webm' });
  const file = new File([blob], 'audio.webm');
  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', CONFIG.TRANSCRIPTION_MODEL);

  const key = await getKey();
  if (!key) {
    console.error('No API key set.');
    return '';
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: formData,
  });
  const json = await response.json();
  return json.text;
}

// ============================================================================
// Image Processing
// ============================================================================

/**
 * Convert a data URL to a Blob
 */
async function dataUrlToBlob(dataUrl) {
  const resp = await fetch(dataUrl);
  return await resp.blob();
}

/**
 * Resize image blob using OffscreenCanvas
 */
async function resizeImageBlob(blob, maxDim = CONFIG.SCREENSHOT_MAX_DIM) {
  try {
    const bitmap = await createImageBitmap(blob);
    const sw = bitmap.width;
    const sh = bitmap.height;
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await canvas.convertToBlob({ type: 'image/jpeg', quality: CONFIG.JPEG_QUALITY });
  } catch (e) {
    console.warn('resizeImageBlob failed, returning original blob', e);
    return blob;
  }
}

/**
 * Upload file blob to OpenAI Files API
 */
async function uploadFileBlob(blob, filename = 'screenshot.jpg', purpose = 'vision', key) {
  const formData = new FormData();
  formData.append('file', blob, filename);
  formData.append('purpose', purpose);

  try {
    const response = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable body>');
      console.error('File upload failed', response.status, response.statusText, text);
      throw new Error(
        `File upload failed: ${response.status} ${response.statusText} - ${text.slice(0, 200)}`
      );
    }
    return await response.json();
  } catch (e) {
    console.error('uploadFileBlob error', e);
    throw e;
  }
}

/**
 * Delete file by ID from OpenAI Files API
 */
async function deleteFileId(fileId, key) {
  try {
    const response = await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable body>');
      console.warn('deleteFileId failed', fileId, response.status, response.statusText, text);
    }
    return await response.json().catch(() => null);
  } catch (e) {
    console.warn('deleteFileId error', e);
  }
}

// ============================================================================
// Tab Communication
// ============================================================================

/**
 * Send message to tab with timeout
 */
async function sendMessageToTab(tabId, msg, timeout = CONFIG.TAB_MESSAGE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let finished = false;
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (finished) return;
      finished = true;
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(resp);
    });
    setTimeout(() => {
      if (finished) return;
      finished = true;
      reject(new Error('timeout waiting for tab response'));
    }, timeout);
  });
}

/**
 * Send message to tab with auto-inject retry logic
 */
async function sendMessageToTabWithInject(
  tabId,
  msg,
  timeout = CONFIG.TAB_MESSAGE_TIMEOUT,
  maxRetries = CONFIG.TAB_MAX_RETRIES
) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= maxRetries) {
    try {
      return await sendMessageToTab(tabId, msg, timeout);
    } catch (err) {
      lastErr = err;
      const msg_text = err?.message ?? '';

      // No receiver in tab: try to inject content script
      if (/Receiving end does not exist|Could not establish connection/i.test(msg_text)) {
        console.warn('No content script in tab, trying to inject...', tabId, msg_text);
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content_script.js'],
          });
          attempt++;
          continue;
        } catch (injectErr) {
          throw new Error(
            `Injection failed: ${injectErr?.message ?? String(injectErr)}`
          );
        }
      }

      // Handle flaky message port closed errors
      if (/message port closed before a response|The message port closed before a response/i.test(msg_text)) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 200));
          attempt++;
          continue;
        }
      }

      // Retry on timeout
      if (/timeout waiting for tab response/i.test(msg_text) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 200));
        attempt++;
        continue;
      }

      // Otherwise give up
      throw err;
    }
  }
  throw lastErr || new Error('sendMessageToTabWithInject failed');
}

/**
 * Request screen data from content script and capture screenshot
 */
async function requestScreen(tabId) {
  try {
    const screen = await sendMessageToTabWithInject(tabId, { type: 'REQUEST_SCREEN' });
    if (!screen) return null;

    screen.platform = 'chrome';

    // Try to capture a screenshot
    try {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab(
          tab.windowId,
          { format: 'jpeg', quality: CONFIG.SCREENSHOT_QUALITY },
          (d) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            resolve(d);
          }
        );
      });
      screen.screenshot = dataUrl;
    } catch (scrErr) {
      console.warn('Screenshot capture failed:', scrErr);
      screen.screenshot = null;
    }

    return screen;
  } catch (e) {
    console.error('requestScreen failed for tab', tabId, e);
    return null;
  }
}

// ============================================================================
// Command Interpretation (LLM)
// ============================================================================

/**
 * Interpret user command using OpenAI Responses API
 */
async function interpretCommand(transcript, screen, key) {
  if (!key) throw new Error('No API key available for interpretCommand');

  // Prepare screen data for prompt (replace screenshot with placeholder)
  const screenForPrompt = Object.assign({}, screen);
  if (screenForPrompt.screenshot) {
    screenForPrompt.screenshot = 'screenshot.jpg (attached)';
  }

  // Build input message
  const inputMessages = [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: `SCREEN:${JSON.stringify(screenForPrompt)}` },
        { type: 'input_text', text: `USER:${transcript}` },
      ],
    },
  ];

  // Upload screenshot if available
  let uploadedFileId = null;
  if (screen?.screenshot) {
    try {
      const originalBlob = await dataUrlToBlob(screen.screenshot);
      const resized = await resizeImageBlob(originalBlob, CONFIG.SCREENSHOT_MAX_DIM);
      const uploaded = await uploadFileBlob(resized, 'screenshot.jpg', 'vision', key);
      uploadedFileId = uploaded?.id;
      if (uploadedFileId) {
        // Insert image reference after SCREEN text
        inputMessages[0].content.splice(1, 0, {
          type: 'input_image',
          file_id: uploadedFileId,
          detail: 'high',
        });
      }
    } catch (e) {
      console.warn('Failed to upload/rescale screenshot, continuing without it', e);
    }
  }

  // Call Responses API
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: CONFIG.INTERPRETATION_MODEL,
        input: inputMessages,
        instructions: SYSTEM_PROMPT,
      }),
    });
  } catch (netErr) {
    if (uploadedFileId) {
      try {
        await deleteFileId(uploadedFileId, key);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    console.error('Network error calling Responses API:', netErr);
    throw new Error(
      `Network error calling Responses API: ${netErr?.message ?? String(netErr)}`
    );
  }

  if (!response.ok) {
    if (uploadedFileId) {
      try {
        await deleteFileId(uploadedFileId, key);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    const bodyText = await response.text().catch(() => '<unreadable body>');
    let parsedErrBody = null;
    try {
      parsedErrBody = JSON.parse(bodyText);
    } catch (e) {
      // Ignore JSON parse errors
    }

    console.error(
      'Responses API responded with non-OK status',
      response.status,
      response.statusText,
      parsedErrBody || bodyText.slice(0, 200)
    );

    const err = new Error(
      `Responses API call failed: ${response.status} ${response.statusText} - ${bodyText.slice(0, 200)}`
    );
    if (parsedErrBody?.error) {
      err.code = parsedErrBody.error.code || parsedErrBody.error.type || null;
      err.details = parsedErrBody.error;
    }
    throw err;
  }

  // Parse response
  let json;
  try {
    json = await response.json();
  } catch (parseErr) {
    const text = await response.text().catch(() => '<unreadable body>');
    console.error('Failed to parse Responses API JSON response:', parseErr, text.slice(0, 200));
    throw new Error(
      `Failed to parse Responses API JSON response: ${parseErr?.message ?? String(parseErr)}`
    );
  }

  // Extract text content from response
  let contentText = null;
  if (Array.isArray(json.output) && json.output.length > 0) {
    const outputContent = json.output[0].content;
    if (Array.isArray(outputContent)) {
      for (const c of outputContent) {
        if (typeof c === 'string') {
          contentText = c;
          break;
        }
        if (c?.text) {
          contentText = c.text;
          break;
        }
        if (c?.type === 'output_text' && c?.text) {
          contentText = c.text;
          break;
        }
      }
    }
  }
  if (!contentText && json.output_text) contentText = json.output_text;
  if (!contentText && typeof json.output === 'string') contentText = json.output;
  if (!contentText && json.choices?.[0]?.message?.content) {
    contentText = json.choices[0].message.content;
  }

  if (!contentText) {
    console.error('Responses API returned no textual content:', json);
    throw new Error('Responses API returned no textual content');
  }

  // Parse LLM JSON response
  let parsed;
  try {
    parsed = JSON.parse(contentText);
  } catch (e) {
    console.error('Responses API returned non-JSON content:', contentText);
    throw new Error(
      `Responses API returned non-JSON content: ${
        contentText?.length > 200 ? contentText.slice(0, 200) + '...' : contentText
      }`
    );
  }

  // Normalize to actions array
  let actions = [];
  if (Array.isArray(parsed)) {
    actions = parsed;
  } else if (parsed?.actions && Array.isArray(parsed.actions)) {
    actions = parsed.actions;
  } else if (parsed?.action) {
    actions = [parsed];
  } else {
    throw new Error('Responses API returned JSON but no actions found');
  }

  // Cleanup: delete uploaded file (best-effort)
  if (uploadedFileId) {
    try {
      await deleteFileId(uploadedFileId, key);
    } catch (e) {
      console.warn('Failed to delete uploaded file', uploadedFileId, e);
    }
  }

  return { actions };
}

// ============================================================================
// Message Handling & Main Flow
// ============================================================================

/**
 * Main message listener for AUDIO_DATA from popup
 */
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg.type !== 'AUDIO_DATA') return true;

  try {
    // Get API key
    const key = await getKey();

    // Transcribe audio
    const transcript = await transcribe(msg.payload.audioBytes);
    try {
      chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'transcribing' } });
    } catch (e) {
      // Popup may not be open; ignore
    }

    // Get active tab
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs || tabs.length === 0) {
      console.error('No active tab found to request screen from.');
      sendResponse({ error: 'no active tab' });
      return true;
    }

    const tab = tabs[0];
    if (!tab?.id) {
      console.error('Active tab returned is invalid:', tab);
      sendResponse({ error: 'invalid tab' });
      return true;
    }

    // Request screen from content script
    const screen = await requestScreen(tab.id);
    try {
      chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'requesting_screen' } });
    } catch (e) {
      // Popup may not be open; ignore
    }

    if (!screen) {
      console.error('No screen data returned from content script for tab', tab.id);
      try {
        chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'no screen' } });
      } catch (e) {
        // Popup may not be open; ignore
      }
      sendResponse({ error: 'no screen' });
      return true;
    }

    // Interpret command
    try {
      chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'interpreting' } });
    } catch (e) {
      // Popup may not be open; ignore
    }

    let result;
    try {
      result = await interpretCommand(transcript, screen, key);
    } catch (err) {
      console.warn(
        'interpretCommand failed; checking for rate-limit or token errors',
        err?.code ?? err?.message
      );

      // Retry with compact screen if rate-limited or token error
      const shouldRetryCompact =
        err &&
        (err.code === 'rate_limit_exceeded' ||
          (err.message && /tokens|request too large|rate_limit/i.test(err.message)));

      if (shouldRetryCompact) {
        try {
          try {
            chrome.runtime.sendMessage({
              type: 'STATUS',
              payload: { status: 'interpreting_compact' },
            });
          } catch (e) {
            // Popup may not be open; ignore
          }

          const compactScreen = {
            title: screen.title,
            url: screen.url,
            body: '', // Drop body to save tokens
            interactables: (screen.interactables || [])
              .slice(0, 10)
              .map((i) => ({
                tag: i.tag,
                text: (i.text || '').slice(0, 100),
                selector: i.selector,
                visible: i.visible,
              })),
          };
          result = await interpretCommand(transcript, compactScreen, key);
        } catch (err2) {
          console.error('Compact retry failed for interpretCommand:', err2);
          throw err2;
        }
      } else {
        throw err;
      }
    }

    // Extract actions from result
    const actions = Array.isArray(result?.actions)
      ? result.actions
      : Array.isArray(result)
      ? result
      : [];

    if (!Array.isArray(actions) || actions.length === 0) {
      console.warn('No actions returned by LLM:', result);
      sendResponse({ error: 'no actions', raw: result });
      return true;
    }

    // Separate summary (spoken) actions from executable actions
    const spoken = [];
    const execActions = [];

    for (const action of actions) {
      if (!action) continue;

      if (action.action === 'summary' || action.action === 'speak') {
        const text = (action.value?.toString()) || '';
        if (text) {
          try {
            chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'speaking' } });
          } catch (e) {
            // Popup may not be open; ignore
          }
          try {
            // Enable SSML parsing for richer speech output
            chrome.tts.speak(text, { enqueue: false, lang: 'en-US' });
            spoken.push({ status: 'spoken', value: text });
          } catch (e) {
            console.error('TTS failed for summary action:', e);
            spoken.push({ status: 'error', error: String(e) });
          }
        } else {
          spoken.push({ status: 'skipped', reason: 'no text' });
        }
      } else {
        // Normalize action aliases
        if (action.action === 'input') action.action = 'type';
        execActions.push(action);
      }
    }

    // Execute non-summary actions
    let execRes = null;
    if (execActions.length > 0) {
      try {
        chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'executing' } });
      } catch (e) {
        // Popup may not be open; ignore
      }

      console.debug('Dispatching EXECUTE_ACTION to tab', tab.id, execActions);
      execRes = await sendMessageToTabWithInject(
        tab.id,
        { type: 'EXECUTE_ACTION', payload: execActions },
        CONFIG.TAB_INJECT_TIMEOUT,
        CONFIG.TAB_MAX_RETRIES
      );

      try {
        chrome.runtime.sendMessage({ type: 'STATUS', payload: { status: 'completed' } });
      } catch (e) {
        // Popup may not be open; ignore
      }
    } else {
      try {
        chrome.runtime.sendMessage({
          type: 'STATUS',
          payload: { status: 'completed_no_exec' },
        });
      } catch (e) {
        // Popup may not be open; ignore
      }
    }

    sendResponse({ transcript, actions, spoken, execRes });
  } catch (err) {
    console.error('Error handling AUDIO_DATA:', err);
    try {
      chrome.runtime.sendMessage({
        type: 'STATUS',
        payload: { status: 'error', message: err?.message ?? String(err) },
      });
    } catch (e) {
      // Popup may not be open; ignore
    }

    const resp = { error: err?.message ?? String(err) };
    if (err?.code) resp.code = err.code;
    if (err?.details) resp.details = err.details;
    sendResponse(resp);
  }

  return true;
});
