const REPO = 'optiona286/btc-options-klines';
const WORKFLOW = 'update-op-data.yml';
const API = `https://api.github.com/repos/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
const DAY = 86400000;

export function missingDays(manifest, first = '2026-10-01', now = Date.now()) {
  const covered = new Set();
  for (const entry of manifest.files) {
    for (const offset of [-2,-1,0]) {
      const day = new Date(Date.parse(entry.date) + offset * DAY).toISOString().slice(0,10);
      if ((!entry.firstDate || day >= entry.firstDate) && (!entry.lastDate || day <= entry.lastDate) && !(entry.missingDates || []).includes(day)) covered.add(day);
    }
  }
  const today = Math.floor(now / DAY) * DAY, missing = [];
  for (let t = Date.parse(first); t < today; t += DAY) {
    const day = new Date(t).toISOString().slice(0,10);
    if (!covered.has(day)) missing.push(day);
  }
  return missing;
}

if (typeof document !== 'undefined' && location.origin === 'https://optiona286.github.io' && location.pathname.startsWith('/btc-options-klines/')) setup();

function setup() {
  const el = id => document.getElementById(id);
  el('gitUpdatePanel').hidden = false;
  // Tab-scoped storage survives reloads; never put credentials in localStorage, URLs or logs.
  const storageKey = 'btc-options-klines:github-actions-token';
  function storedToken() { try { return sessionStorage.getItem(storageKey) || ''; } catch { return ''; } }
  function saveToken(value) { try { if (value) sessionStorage.setItem(storageKey, value); else sessionStorage.removeItem(storageKey); } catch { /* Memory-only fallback when tab storage is blocked. */ } }
  let token = '', busy = false, generation = 0;
  const status = message => { el('gitUpdateStatus').textContent = message; };
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'max-width:460px;width:90%;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:20px';
  dialog.innerHTML = `<form><h3>授權更新 Bybit data</h3><p>Token 保留在目前分頁，重新整理不必重填；關閉分頁或按「清除授權」可清除。按下更新後會在後台執行一次：檢查缺少日期、下載、精簡及存回 Git。不設定排程。</p><p>建立專用 Fine-grained Token，只選 btc-options-klines，設定 Repository permissions → Actions: Read and write。請設定短效期。</p><p><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">前往 GitHub 建立 Token</a></p><label>專用 GitHub Token<input type="password" required autocomplete="off" spellcheck="false" style="display:block;width:100%;margin:10px 0" aria-label="專用 GitHub Token"></label><button class="btn" type="submit">授權並更新一次</button> <button class="btn" type="button" data-cancel>取消</button></form>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { input.value = ''; });
  el('gitUpdateAuthorize').onclick = () => { dialog.showModal(); input.focus(); };
  dialog.querySelector('form').onsubmit = event => {
    event.preventDefault(); token = input.value.trim(); input.value = ''; dialog.close();
    saveToken(token);
    generation++;
    el('gitUpdateCheck').hidden = false; el('gitUpdateForget').hidden = false;
    el('gitUpdateAuthorize').textContent = '更換授權';
    check();
  };
  el('gitUpdateForget').onclick = () => {
    token = ''; generation++; input.value = '';
    saveToken('');
    el('gitUpdateCheck').hidden = true; el('gitUpdateForget').hidden = true;
    el('gitUpdateAuthorize').textContent = '手動更新 data';
    status('授權已清除；已啟動的雲端工作仍會完成。');
  };
  el('gitUpdateCheck').onclick = () => check(true);
  function restoreAuthorization() {
    token = storedToken();
    if (!token) return;
    el('gitUpdateCheck').hidden = false; el('gitUpdateForget').hidden = false;
    el('gitUpdateAuthorize').textContent = '更換授權';
    status('已載入本分頁授權，可按「手動更新」。');
  }
  restoreAuthorization();
  async function api(route, method = 'GET', body) {
    const response = await fetch(API + route, {
      method, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 401) { saveToken(''); throw Error('Token 無效或已到期，請重新授權。'); }
      if (response.status === 403 || response.status === 404) throw Error('無法存取工作流程；請確認專案權限及 Actions: Read and write，或稍後重試。');
      throw Error(`GitHub 回應 HTTP ${response.status}，請稍後重試。`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function manifest() {
    const response = await fetch(RAW + 'data/manifest.json?t=' + Date.now(), { cache:'no-store', signal:AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('無法核對 Git 最新資料清單。');
    return response.json();
  }
  function showRun(run) {
    el('gitUpdateRun').href = `https://github.com/${REPO}/actions/runs/${run.id}`;
    el('gitUpdateRun').hidden = false;
  }
  async function watch(run, ownGeneration) {
    showRun(run);
    for (let i = 0; i < 180; i++) {
      if (!token || ownGeneration !== generation) return;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw Error(`雲端更新未成功（${run.conclusion}），請查看執行紀錄。`);
        const missing = missingDays(await manifest());
        if (ownGeneration !== generation) return;
        window.btcResetStaticData?.(); el('refresh').click();
        if (missing.length) {

          status(`工作完成；仍缺 ${missing.length} 個來源日（最早 ${missing[0]}）。可能尚未發布或待分批補齊，可再按「檢查更新」。`);
        } else { status('更新完成，已存回 Git 並重新載入資料。'); }
        return;
      }
      status(run.status === 'queued' ? 'GitHub 工作排隊中…' : '雲端更新中：下載官方 ZIP → 精簡 → 驗證 → 存回 Git…');
      await new Promise(resolve => setTimeout(resolve, 15000));
      if (!token || ownGeneration !== generation) return;
      run = await api(`/actions/runs/${run.id}`);
    }
    throw Error('工作尚未完成，可查看執行紀錄，稍後再檢查。');
  }
  async function check() {
    if (!token || busy) return;
    busy = true; el('gitUpdateCheck').disabled = true;
    const ownGeneration = generation;
    try {
      status('檢查 Git 資料及雲端工作…');
      const workflow = await api(`/actions/workflows/${WORKFLOW}`);
      if (ownGeneration !== generation) return;
      if (workflow.state !== 'active') throw Error('GitHub 工作流程尚未啟用，請先在 Actions 啟用。');
      const runs = await api(`/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=30`);
      if (ownGeneration !== generation) return;
      const active = runs.workflow_runs.find(run => run.status !== 'completed');
      if (active) { await watch(active, ownGeneration); return; }
      const missing = missingDays(await manifest());
      if (ownGeneration !== generation) return;
      if (!missing.length) { status('資料已更新至昨日 UTC，沒有缺少的來源日。'); return; }
      status(`缺少 ${missing.length} 個來源日，正在啟動更新…`);
      const previous = new Set(runs.workflow_runs.map(run => run.id));
      const receipt = await api(`/actions/workflows/${WORKFLOW}/dispatches`, 'POST', { ref:'main' });
      if (ownGeneration !== generation) return;
      if (receipt?.workflow_run_id) { await watch(await api(`/actions/runs/${receipt.workflow_run_id}`), ownGeneration); return; }
      // Older API versions return 204: identify the newly created run, never a previous success.
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (!token || ownGeneration !== generation) return;
        const recent = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=30`);
        const run = recent.workflow_runs.find(run => !previous.has(run.id));
        if (run) { await watch(run, ownGeneration); return; }
      }
      throw Error('GitHub 已接受更新，但尚未出現執行紀錄；請稍後按「檢查更新」。');
    } catch (error) {
      if (ownGeneration === generation) { status(error.message); }
    } finally {
      busy = false; el('gitUpdateCheck').disabled = false;
      if (ownGeneration !== generation && token) check();
    }
  }


  window.addEventListener('pagehide', () => { token = ''; generation++; input.value = ''; });
  window.addEventListener('pageshow', event => { if (event.persisted) restoreAuthorization(); });
}
