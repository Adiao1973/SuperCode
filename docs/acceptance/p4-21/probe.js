// Acceptance-only: paste in isolated release WebKit Inspector, close Inspector.
// Records numbers only; input content, paths, credentials are never exported.
window.p421 = (() => {
  const input = [];
  let armed = false; let inputViewport = null;
  for (const type of ['input', 'click']) document.addEventListener(type, e => {
    if (!armed || !e.isTrusted) return;
    inputViewport = [innerWidth,innerHeight,devicePixelRatio];
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => input.push(performance.now() - start)));
  }, true);
  const send = payload => fetch('http://127.0.0.1:19441/metrics', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
  });
  return {
    armInput() { input.length=0; armed=true; return 'Input capture armed'; },
    saveInput() { armed=false; return send({label:'trusted-input-click-paint-proxy',input,viewport:inputViewport}); },
    sample(label, scroll=false) {
      setTimeout(() => {
        const start=performance.now(); let last=start, min=Infinity, max=0;
        const frames=[], visibility=new Set();
        function tick(now) {
          frames.push(now-last); last=now; visibility.add(document.visibilityState);
          const nodes=document.querySelectorAll('[data-item-index]').length;
          min=Math.min(min,nodes);max=Math.max(max,nodes);
          const scroller=document.querySelector('[data-virtuoso-scroller]');
          if(scroll&&scroller) scroller.scrollTop=(1-Math.abs(((now-start)/1000%6)-3)/3)*2700;
          if(now-start<30000) requestAnimationFrame(tick);
          else send({label,frames,visibility:[...visibility],viewport:[innerWidth,innerHeight,devicePixelRatio],
            dom:{minVirtualItems:min,maxVirtualItems:max,totalElements:document.querySelectorAll('*').length,
            longtaskSupported:PerformanceObserver.supportedEntryTypes?.includes('longtask')??false}});
        }
        requestAnimationFrame(tick);
      },5000);
      return '5s delay then 30s capture; close Inspector';
    }
  };
})();
'P421 numeric-only sampler installed';
