# Copilot Instructions — Screen Pilot 🔧

## Project summary
- **Screen Pilot** — Chrome extension (Manifest V3) that converts voice commands into DOM interactions (voice + visual context). Key components: `popup.*` (UI & recording), `service_worker.js` (transcribe + interpret commands), and `content_script.js` (extract screen and execute actions).

## High-level runtime flow
1. User opens the extension popup and saves an OpenAI API key (`popup.html` / `popup.js`).
2. Clicking **Start Listening** records a ~4s audio clip (MediaRecorder) and sends `AUDIO_DATA` to the service worker.
3. `service_worker.js` calls the audio transcription endpoint (`/v1/audio/transcriptions` with model `gpt-4o-transcribe`) then requests the screen from the active tab via message `REQUEST_SCREEN`.
4. The transcript and screen are sent to the Responses API (`/v1/responses` with model `gpt-4.1`) as JSON. If a screenshot is present, the extension uploads it to `/v1/files` (purpose `vision`), references the returned `file_id` inside the `input` as an `input_image` item, and deletes the file after the response. The system prompt requests: `Return ONLY JSON: an object with an 'actions' array: {"actions":[{action,selector,value,amount}]}`.
5. Parsed action JSON is dispatched to the page as `EXECUTE_ACTION`, and `content_script.js` performs `click`, `type`, or `scroll` accordingly.

## Key files & responsibilities
- `manifest.json` — permissions (`scripting`, `storage`, `tts`), background/service worker, content script injection.
- `popup.html` / `popup.js` — API key input (stored in `chrome.storage.local`), microphone capture, sending `AUDIO_DATA`.
 - `popup.html` / `popup.js` — API key input (stored in `chrome.storage.local`), microphone capture, sending `AUDIO_DATA`, and UI status updates. The popup supports keyboard shortcuts: **Space** to start listening and **Esc** to stop early. The UI shows a status line, spinner, and a `Stop` button to cancel recording before the 4s timeout.
 - `popup.html` / `popup.js` — API key input (stored in `chrome.storage.local`), microphone capture, sending `AUDIO_DATA`, and UI status updates. The popup supports **hold-to-talk**: press and hold **Space** to record and release **Space** to stop recording. **Esc** now stops any background TTS playback (stop speaking) rather than stopping recording. The UI shows a status line, spinner, and a `Stop` button to cancel recording early.
- `service_worker.js` — transcription (`transcribe()`), `interpretCommand()` that expects strict JSON output, and sending `EXECUTE_ACTION` results; uses `chrome.tts.speak` to notify completion.
- `content_script.js` — `extractScreen()` returns `{title, url, body, interactables[]}`; `uniqueSelector()` returns `#id` or `tag.class1.class2`; executes actions on received `selector`.
- `content_script.js` — `extractScreen()` returns `{title, url, body, interactables[]}`; `uniqueSelector()` returns `#id` or `tag.class1.class2`; executes actions on received `selector`.

## Message & data formats (examples)
- AUDIO message sent from popup:
  {
    type: "AUDIO_DATA",
    payload: { audioBytes: [...new Uint8Array(buf)] }
  }
- Screen object returned by `REQUEST_SCREEN`:
  {
    title, url, body: <first 3000 chars>,
    interactables: [{tag, text, selector, visible}, ...]
  }
- Expected action JSON (from LLM):
  { "action": "click" | "type" | "scroll", "selector": "<css>", "value": "...", "amount": 100 }

Example: {"action":"click","selector":"#submit","value":"","amount":0}

Notes: The LLM can also return a spoken **summary** action. Use:
  { "action": "summary", "selector": null, "value": "Human-readable summary text...", "amount": null }
When `service_worker.js` receives an action with `action: "summary"` (or `"speak"`/`"read"`), the background will use `chrome.tts.speak(value)` to read the `value` out loud and return `{ execRes: { status: 'spoken' } }` in the response.

## Patterns & important constraints
- The LLM must return strict JSON; the system prompt in `service_worker.js` enforces it. When updating prompt, preserve the instruction to "Return ONLY JSON" to avoid parsing errors.
- Selector strategy is simplistic: `#id` if present else `tag.class1.class2`. This may not be unique—consider improving `uniqueSelector()` to include ancestry or use a stable data-attribute if you add it.
- `extractScreen()` limits body text to 3000 chars — UIs relying on long page content may be truncated.
- `extractScreen()` limits body text to ~1000 chars (was 3000) and truncates interactable text and count to keep LLM requests under token limits — prefer short concise fields.
- If you hit "request too large" / token errors from the LLM, the service worker will automatically retry once with a compacted screen (no body and only the first ~10 interactables). See `service_worker.js` for retry logic.
- Actions supported: `click`, `type`, `scroll`. To add actions, update both `content_script.js` (execution) and `service_worker.js` (system prompt / validation).

## Manual test & debugging steps
- Load extension as Unpacked in Chrome (chrome://extensions) and enable "Service Worker" inspection.
- Set OpenAI key via extension popup. Microphone permissions are requested by the browser when starting recording.
- Start listening and speak a command (e.g., "click Log in").
- Check background/service worker console for errors and logs (transcription, completed action payloads). Inspect page console for `content_script` logs.

## Security & developer notes
- API keys are stored in `chrome.storage.local` and must never be committed to the repo.
- Network calls use explicit OpenAI endpoints in `service_worker.js`; be mindful of API quota and cost when testing.

## How to extend safely
- Adding actions: extend `EXECUTE_ACTION` handler in `content_script.js` and include robust error responses (e.g., `{error:"not found"}`).
- Improve selectors: prefer `data-automation-id` attributes for deterministic targeting if you control the page.
- Make the transcription/chat call resilient: add retries, handle non-JSON responses, and log raw LLM responses to the service worker console for debugging.
- Make the transcription/chat call resilient: handle non-OK HTTP responses from the LLM, surface detailed errors (including rate limit codes like `rate_limit_exceeded`), and retry with a compact payload when appropriate.
  - If you need more tokens, consider using a lighter model or reducing the `body`/`interactables` you send. Adding billing can increase TPM limits.

---

If you'd like, I can: (1) add a short checklist for PR reviewers, (2) add quick local development notes (e.g., simulating messages via `chrome.runtime.sendMessage`), or (3) expand examples of how to extend selectors — which would you prefer?