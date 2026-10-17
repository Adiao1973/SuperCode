// Acceptance-only: paste in isolated release WebKit Inspector, close Inspector.
// Records numbers only; input content, paths, credentials are never exported.
window.p421 = (() => {
  const input = [];
  let armed = false; let inputViewport = null; let compositionEvents = 0;
  for (const type of ['input', 'click']) document.addEventListener(type, e => {
    if (!armed || !e.isTrusted) return;
    if(e.type === "input" && e.isComposing) compositionEvents++;
    inputViewport = [innerWidth,innerHeight,devicePixelRatio];
    const start = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => input.push(performance.now() - start)));
  }, true);
  const send = payload => fetch('http://127.0.0.1:19441/metrics', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
  });
  return {
    armInput() { input.length=0; compositionEvents=0; armed=true; return 'Input capture armed'; },
    saveInput(label = 'trusted-input-click-paint-proxy') {
      armed=false;
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => {
        const sorted=[...input].sort((a,b)=>a-b);
        const summary={samples:input.length,p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null,compositionEvents};
        return send({label,input,viewport:inputViewport,dom:{compositionEvents}}).then(()=>summary);
      });
    },
    anchor(label) {
      return new Promise(resolve => setTimeout(() => {
      const el=document.querySelector('[data-virtuoso-scroller]');
      const rect=el?.getBoundingClientRect();
      const row=[...document.querySelectorAll('[data-timeline-key]')].find(n=>n.getBoundingClientRect().bottom>rect?.top);
      return send({label,dom:{key:row?.dataset.timelineKey,offset:row?row.getBoundingClientRect().top-rect.top:null,
        top:el?.scrollTop,height:el?.scrollHeight,viewport:el?.clientHeight,rows:document.querySelectorAll('[data-item-index]').length,
        unread:!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('新消息 ·'))}}).then(resolve);
      }, 2000));
    },
    sample(label, scroll=false, done) {
      setTimeout(() => {
        const start=performance.now(); let last=start, min=Infinity, max=0;
        const frames=[], visibility=new Set(), viewports=new Set();
        const splitters=[...document.querySelectorAll('[role="separator"][aria-valuenow]')].map(el=>({el,min:Infinity,max:-Infinity}));
        function tick(now) {
          frames.push(now-last); last=now; visibility.add(document.visibilityState); viewports.add(innerWidth+"x"+innerHeight);
          for(const range of splitters) { const value=Number(range.el.getAttribute('aria-valuenow'));range.min=Math.min(range.min,value);range.max=Math.max(range.max,value); }
          const nodes=document.querySelectorAll('[data-item-index]').length;
          min=Math.min(min,nodes);max=Math.max(max,nodes);
          const scroller=document.querySelector('[data-virtuoso-scroller]');
          if(scroll&&scroller) scroller.scrollTop=(1-Math.abs(((now-start)/1000%6)-3)/3)*2700;
          if(now-start<30000) requestAnimationFrame(tick);
          else { const payload={label,frames,visibility:[...visibility],viewport:[innerWidth,innerHeight,devicePixelRatio],
            dom:{viewports:[...viewports],splitterRanges:splitters.map(({min,max})=>({min,max})),minVirtualItems:min,maxVirtualItems:max,totalElements:document.querySelectorAll('*').length,
            longtaskSupported:PerformanceObserver.supportedEntryTypes?.includes('longtask')??false}};
            send(payload).then(()=>done?.(payload));
          }
        }
        requestAnimationFrame(tick);
      },5000);
      return '5s delay then 30s capture; close Inspector';
    }
  };
})();
'P421 numeric-only sampler installed';

// Temporary measurement controls, outside the product React root. Removed on app exit.
document.getElementById('p421-controls')?.remove();
const panel=document.createElement('details'); panel.id='p421-controls'; panel.open=true;
panel.style='position:fixed;right:12px;top:60px;z-index:10000;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground);font:12px -apple-system,sans-serif;max-width:240px';
panel.innerHTML='<summary>性能采样（临时）</summary><div style="display:grid;gap:8px;margin-top:8px"><button type="button">分栏 30 秒</button><button type="button">开始中文输入采样</button><button type="button">保存输入采样</button><output aria-live="polite">尚未采样</output></div>';
document.body.append(panel);
const buttons=panel.querySelectorAll('button'), status=panel.querySelector('output');
buttons[0].onclick=()=>{buttons[0].disabled=true;status.textContent='5秒后记录；请持续拖动分栏30秒';p421.sample('manual-split-drag-30s',false,result=>{const sorted=[...result.frames].sort((a,b)=>a-b);status.textContent='分栏已保存 · p95 '+sorted[Math.ceil(sorted.length*.95)-1]+'ms';buttons[0].disabled=false;});};
buttons[1].onclick=()=>{p421.armInput();status.textContent='请在任务框输入至少30字中文，不运行任务';};
buttons[2].onclick=()=>{p421.saveInput('manual-chinese-ime').then(summary=>{status.textContent='输入已保存 · '+summary.samples+'次 · p95 '+summary.p95Ms+'ms · 组合输入 '+summary.compositionEvents+'次';});};
'P421 temporary controls ready';
