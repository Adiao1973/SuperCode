// Paste into the isolated App's WebKit Inspector Console through CUA.
// No IPC replacement. Read-only metrics + optional synthetic scroll. No content export.
window.p41 = {
  sample(label, scroll = false) {
    setTimeout(() => {
      const start = performance.now();
      let previous = start;
      const frames = [];
      const visibility = new Set();
      let minItems = Infinity, maxItems = 0;
      const tick = now => {
        frames.push(now - previous);
        previous = now;
        visibility.add(document.visibilityState);
        const scroller = document.querySelector('[data-virtuoso-scroller]');
        const items = document.querySelectorAll('[data-item-index]').length;
        minItems = Math.min(minItems, items); maxItems = Math.max(maxItems, items);
        if (scroll && scroller) {
          // 3s down / 3s up, modest 900 CSS px/s; no smooth-scroll animation overlap.
          const elapsed = (now - start) / 1000;
          scroller.scrollTop = (1 - Math.abs((elapsed % 6) - 3) / 3) * 2700;
        }
        if (now - start < 30000) requestAnimationFrame(tick);
        else fetch('http://127.0.0.1:19441/metrics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({label, viewport:[innerWidth,innerHeight,devicePixelRatio],
            userAgent:navigator.userAgent, frames,
            navigation: performance.getEntriesByType('navigation').map(n => ({domContentLoadedMs:n.domContentLoadedEventEnd,loadMs:n.loadEventEnd})),
            dom:{minVirtualItems:minItems,maxVirtualItems:maxItems,totalElements:document.querySelectorAll('*').length},
            visibility:[...visibility]})
        });
      };
      requestAnimationFrame(tick);
    }, 5000); // Close Inspector and return focus to App before sampling.
    return 'Armed: 5s delay + 30s, close Inspector now';
  }
};
'P41 synthetic WebKit sampler installed';
