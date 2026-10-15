(() => {
  'use strict';
  const button = document.getElementById('pwaInstall');
  const notice = document.getElementById('pwaNotice');
  const message = document.getElementById('pwaMessage');
  const action = document.getElementById('pwaAction');
  let installPrompt = null;
  let registration = null;
  let reloading = false;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  function show(text, label = '關閉', callback = () => { notice.hidden = true; }) {
    message.textContent = text;
    action.textContent = label;
    action.onclick = callback;
    notice.hidden = false;
  }
  function connectionStatus() {
    if (!navigator.onLine) show('目前離線：可開啟介面，行情與期權資料需要網路。');
    else if (!registration?.waiting) notice.hidden = true;
  }
  button.hidden = standalone();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); installPrompt = event;
    button.hidden = standalone();
  });
  button.addEventListener('click', async () => {
    if (!installPrompt) {
      show(/iPad|iPhone|iPod/.test(navigator.userAgent)
        ? '請使用 Safari 的「分享」→「加入主畫面」。'
        : '請開啟瀏覽器選單，選擇「安裝應用程式」或「新增至主畫面」。若沒有此選項，請先重新整理。');
      return;
    }
    const prompt = installPrompt; installPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === 'accepted') button.hidden = true;
    } catch { show('請使用瀏覽器選單安裝此應用程式。'); }
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; installPrompt = null; notice.hidden = true; });
  matchMedia('(display-mode: standalone)').addEventListener('change', () => { button.hidden = standalone(); });
  window.addEventListener('offline', connectionStatus);
  window.addEventListener('online', connectionStatus);
  connectionStatus();
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  function offerUpdate() {
    if (!registration.waiting) return;
    show('有新版本，可更新應用程式。', '更新', () => {
      reloading = true;
      registration.waiting?.postMessage({type:'SKIP_WAITING'});
    });
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  window.addEventListener('load', async () => {
    try {
      registration = await navigator.serviceWorker.register('./sw.js', {scope:'./', updateViaCache:'none'});
      offerUpdate();
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') offerUpdate();
        });
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && navigator.onLine) registration.update().catch(() => {});
      });
    } catch { show('離線功能尚未啟用，請連線後重新整理。'); }
  });
})();
