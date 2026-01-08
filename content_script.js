/**
 * Screen Pilot Content Script
 * Manages screen extraction and DOM action execution
 */

// ============================================================================
// Screen Extraction
// ============================================================================

/**
 * Extract screen context: page info, text content, and interactive elements
 */
function extractScreen() {
  const interactableElements = [];

  // Find all interactive elements
  document.querySelectorAll('button,a,input,[role="button"]').forEach((el) => {
    const rect = el.getBoundingClientRect();
    interactableElements.push({
      tag: el.tagName.toLowerCase(),
      text: el.innerText || el.value || el.getAttribute('aria-label'),
      selector: uniqueSelector(el),
      visible: rect.width > 0 && rect.height > 0,
    });
  });

  return {
    title: document.title,
    url: location.href,
    // Keep body short to avoid large LLM payloads
    body: document.body.innerText.slice(0, 1000),
    // Limit number of interactables and truncate text fields
    interactables: interactableElements
      .slice(0, 40)
      .map((item) => ({
        tag: item.tag,
        text: item.text ? item.text.toString().trim().slice(0, 200) : '',
        selector: item.selector,
        visible: !!item.visible,
      })),
  };
}

/**
 * Generate a unique CSS selector for an element
 * Prefers ID, falls back to tag + classes
 */
function uniqueSelector(el) {
  if (el.id) {
    return `#${el.id}`;
  }
  let selector = el.tagName.toLowerCase();
  if (el.className) {
    const classes = el.className.toString().split(' ').join('.');
    selector += `.${classes}`;
  }
  return selector;
}

// ============================================================================
// Action Execution
// ============================================================================

/**
 * Execute a single action (click, type, scroll)
 */
function executeAction(action) {
  if (!action) {
    return { error: 'invalid action' };
  }

  try {
    // Scroll doesn't need a selector
    if (action.action === 'scroll') {
      const amount = action.amount || 0;
      window.scrollBy(0, amount);
      return { action: 'scroll', status: 'done', amount };
    }

    // Find target element
    const element = action.selector ? document.querySelector(action.selector) : null;
    if (!element) {
      return { action: action.action, selector: action.selector, error: 'not found' };
    }

    // Click action
    if (action.action === 'click') {
      element.click();
      return { action: 'click', selector: action.selector, status: 'done' };
    }

    // Type/input action
    if (action.action === 'type' || action.action === 'input') {
      return executeTypeAction(element, action);
    }

    // Unknown action type
    return { action: action.action, selector: action.selector, error: 'unsupported action' };
  } catch (e) {
    return { action: action.action, selector: action.selector, error: String(e) };
  }
}

/**
 * Execute type/input action on an element
 */
function executeTypeAction(element, action) {
  try {
    // Focus element
    if (typeof element.focus === 'function') {
      element.focus();
    }

    // Set value using native setter if available
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    const value = action.value ?? '';
    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    // Trigger input and change events
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    // Blur element
    if (typeof element.blur === 'function') {
      element.blur();
    }

    return { action: 'type', selector: action.selector, status: 'done' };
  } catch (e) {
    return { action: 'type', selector: action.selector, error: String(e) };
  }
}

// ============================================================================
// Message Handling
// ============================================================================

/**
 * Listen for messages from service worker
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'REQUEST_SCREEN') {
    sendResponse(extractScreen());
  } else if (msg.type === 'EXECUTE_ACTION') {
    handleExecuteAction(msg.payload, sendResponse);
  }
  return true;
});

/**
 * Handle EXECUTE_ACTION message: execute all actions in payload
 */
function handleExecuteAction(payload, sendResponse) {
  const actions = Array.isArray(payload) ? payload : [payload];
  const results = [];

  for (const action of actions) {
    const result = executeAction(action);
    results.push(result);
  }

  sendResponse({ status: 'done', results });
}
