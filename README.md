# Screen Pilot 🚀

Navigate the web with voice + visual context — control web pages using short spoken commands and optional screenshots.

---

## Overview ✨
**Screen Pilot** is a Manifest V3 Chrome extension that converts spoken commands into deterministic DOM interactions. It captures short audio clips, transcribes them, and uses the visible page context to interpret actions like click, type, scroll, or speak a short summary. The extension is designed for fast, privacy-guarded automation and prototyping of voice-driven web workflows.

## Key features ✅
- Voice-to-action: Speak short commands like "click Log in" or "type hello in search".
- Visual awareness: The content script extracts page context (title, URL, interactables) to ground interpretations.
- Deterministic output: The LLM is instructed to return strict JSON only: {"actions":[{action,selector,value,amount}]}
- Flexible actions: Supports `click`, `type`, `scroll`, and spoken `summary` results.
- Local developer tooling: Easy to load as an unpacked extension and debug service worker logs.

## Quick start — Install & use 🧭
1. Open Chrome and go to chrome://extensions
2. Enable **Developer mode** and click **Load unpacked**
3. Select this repository folder
4. Open the extension popup, paste your OpenAI API key, and save
5. Use Space to start/hold-to-talk (press to start and release to stop). Say commands like:
   - "click Log in"  
   - "type hello in search"  
   - "scroll down 400"

## Development & debugging 🔧
- Files of interest:
  - `manifest.json` — permissions and background/service worker
  - `popup.html` / `popup.js` — API key UI, recording, and sending `AUDIO_DATA`
  - `service_worker.js` — calls transcription and Responses API, enforces strict JSON, uses `chrome.tts` for spoken replies
  - `content_script.js` — extracts `title`, `url`, a truncated `body`, `interactables[]`, and executes `EXECUTE_ACTION` messages
- Inspect the Service Worker in Chrome's extension inspector to view logs and raw LLM responses
- When the LLM returns an action, the service worker dispatches `EXECUTE_ACTION` to the active tab; the content script performs the action and logs results

## Data formats & constraints 💡
- AUDIO message (from popup):
  {
    type: "AUDIO_DATA",
    payload: { audioBytes: [...new Uint8Array(buf)] }
  }
- Screen object (from content_script):
  { title, url, body: <truncated>, interactables: [{tag, text, selector, visible}, ...] }
- Expected LLM action JSON: `{ "action": "click" | "type" | "scroll", "selector": "<css>", "value": "...", "amount": 0 }`
- Important: The system prompt enforces **Return ONLY JSON** — preserve that if you change prompts or models

## Testing & manual checks ✅
- Load as Unpacked in Chrome and open Service Worker console to verify requests and parsed actions
- Use `chrome.runtime.sendMessage` in the console to simulate `EXECUTE_ACTION` messages for the content script
- If you hit token or size limits, the service worker has a compact-retry path that removes `body` and trims `interactables`

## Security & privacy 🔒
- API keys are stored in `chrome.storage.local` — do not commit them to source control
- Be mindful when uploading screenshots or extra page content; limit sensitive page data when testing

## How to extend 🛠️
- Add actions: implement execution in `content_script.js` and add validation/response guidance in `service_worker.js`
- Improve selectors: prefer `data-automation-id` attributes for deterministic selectors when possible
- Make the transcription/chat call resilient: add retries, handle non-JSON responses, and log raw LLM responses for debugging

## Contributing & PR checklist ✅
- Keep the system prompt that requires strict JSON and include an example action
- Add automated tests for any new action types and include error responses
- Ensure no API keys or secrets are added

## License
MIT — see `LICENSE` (add if you want to include a license file)

---

If you'd like, I can add a short PR reviewer checklist or local dev notes (simulate messages, sample commands) — tell me which you'd prefer.