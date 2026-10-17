// Acceptance only, isolated synthetic App. No input values or content exported.
window.p422 = (() => {
  let timer;
  const capture = () => {
    const heading=document.querySelector('[data-app-heading]')?.textContent;
    const visible=el => !!el.getClientRects().length && !el.closest('[hidden],[inert]');
    const controls=[...document.querySelectorAll('button,input,textarea,select,[role="dialog"]')].filter(visible);
    const unnamed=controls.filter(el => !el.getAttribute('aria-label')&&!el.getAttribute('aria-labelledby')&&!el.labels?.length&&!el.textContent?.trim()&&!el.title);
    const payload={label:'p422-layout',viewport:[innerWidth,innerHeight,devicePixelRatio],dom:{heading,theme:document.documentElement.dataset.theme,dark:document.documentElement.classList.contains('dark'),motion:document.documentElement.dataset.motion,systemDark:matchMedia('(prefers-color-scheme: dark)').matches,documentWidth:document.documentElement.scrollWidth,unnamedControls:unnamed.map(el=>({tag:el.tagName,placeholder:el.getAttribute('placeholder')})),horizontalRegions:[...document.querySelectorAll('main,section,form,[role=dialog]')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+2).map(e=>({tag:e.tagName,cls:e.className,width:e.clientWidth,scroll:e.scrollWidth})),dialogCount:document.querySelectorAll('[role="dialog"]').length}};
    return fetch('http://127.0.0.1:19441/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  };
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(capture,250);};
  new MutationObserver(schedule).observe(document.getElementById('root'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden','inert']});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-motion']});
  addEventListener('resize',schedule);
  schedule();
  return {capture, resize:(width,height)=>window.__TAURI_INTERNALS__.invoke('plugin:window|set_size',{label:'main',value:{Logical:{width,height:height+32}}})};
})();
