function extractScreen(){
  const items=[];
  document.querySelectorAll("button,a,input,[role='button']").forEach(el=>{
    const r=el.getBoundingClientRect();
    items.push({
      tag:el.tagName.toLowerCase(),
      text:el.innerText||el.value||el.getAttribute("aria-label"),
      selector:uniqueSelector(el),
      visible:r.width>0&&r.height>0
    });
  });
  return {
    title:document.title,
    url:location.href,
    // Keep body short to avoid large LLM payloads
    body:document.body.innerText.slice(0,1000),
    // Limit number of interactables and truncate text fields
    interactables: items.slice(0,40).map(i=>({
      tag:i.tag,
      text: i.text ? (i.text.toString().trim().slice(0,200)) : '',
      selector:i.selector,
      visible:!!i.visible
    }))
  };
}

function uniqueSelector(el){
  if(el.id) return "#"+el.id;
  let s=el.tagName.toLowerCase();
  if(el.className) s+="."+el.className.toString().split(" ").join(".");
  return s;
}

chrome.runtime.onMessage.addListener((msg,s,r)=>{
  if(msg.type==="REQUEST_SCREEN") return r(extractScreen());
  if(msg.type==="EXECUTE_ACTION"){
    const payload = msg.payload;
    const actions = Array.isArray(payload) ? payload : [payload];
    const results = [];

    for(const a of actions){
      if(!a) { results.push({error:'invalid action'}); continue; }
      try{
        // scroll doesn't need a selector
        if(a.action === 'scroll'){
          window.scrollBy(0, a.amount || 0);
          results.push({action:'scroll', status:'done', amount:a.amount||0});
          continue;
        }

        const el = a.selector ? document.querySelector(a.selector) : null;
        if(!el) { results.push({action:a.action, selector:a.selector, error:'not found'}); continue; }

        if(a.action === 'click'){
          el.click();
          results.push({action:'click', selector:a.selector, status:'done'});
          continue;
        }

        if(a.action === 'type' || a.action === 'input'){
          // Focus first
          if(typeof el.focus === 'function') el.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set || null;
          if(nativeSetter){
            nativeSetter.call(el, a.value != null ? a.value : '');
          } else {
            el.value = a.value != null ? a.value : '';
          }
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          if(typeof el.blur === 'function') el.blur();
          results.push({action:'type', selector:a.selector, status:'done'});
          continue;
        }

        // unknown action type
        results.push({action:a.action, selector:a.selector, error:'unsupported action'});
      } catch(e){
        results.push({action:a.action, selector:a.selector, error:String(e)});
      }
    }

    r({status:"done", results});
  }
  return true;
});