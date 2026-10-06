(() => {
  'use strict';
  const button = document.getElementById('installApp');
  const guide = document.getElementById('installGuide');
  const standalone = window.matchMedia('(display-mode: standalone)');
  let pendingInstall = null;
  function updateButton() { button.hidden = standalone.matches || navigator.standalone === true; }
  updateButton();
  standalone.addEventListener('change', updateButton);
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pendingInstall = event;
    updateButton();
  });
  window.addEventListener('appinstalled', () => { pendingInstall = null; button.hidden = true; });
  button.addEventListener('click', async () => {
    if (pendingInstall) {
      const prompt = pendingInstall;
      pendingInstall = null;
      button.disabled = true;
      try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'accepted') button.hidden = true;
      } catch { showGuide(); }
      finally { button.disabled = false; }
    } else showGuide();
  });
  function showGuide() {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(navigator.userAgent);
    document.getElementById('installInstructions').textContent = ios
      ? '請用 Safari 開啟這個網址，點「分享」，選「加入主畫面」，再點「新增」。'
      : android
        ? '請用 Chrome 開啟這個網址，點右上角 ⋮，選「安裝應用程式」或「加到主畫面」，再確認安裝。若目前在其他 App 內開啟，請先改用 Chrome。'
        : '請用 Chrome 或 Edge 開啟，點網址列的安裝圖示；也可在瀏覽器選單中選「安裝」或「將此網站安裝為應用程式」。';
    guide.showModal();
  }
  function updateConnection() { document.getElementById('offlineNotice').hidden = navigator.onLine; }
  window.addEventListener('online', updateConnection);
  window.addEventListener('offline', updateConnection);
  updateConnection();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' })
        .then(registration => registration.update())
        .catch(error => console.warn('App 快取尚未啟用', error));
    });
  }
})();
