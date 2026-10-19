import { timingSafeEqual } from 'node:crypto';
const REPO = 'optiona286/btc-options-klines';
const WORKFLOW = 'update-op-data.yml';
const ORIGIN = 'https://optiona286.github.io';
const BASE = `https://api.github.com/repos/${REPO}`;
function headers(token) { return { Authorization:`Bearer ${token}`, Accept:'application/vnd.github+json', 'User-Agent':'btc-data-update', 'X-GitHub-Api-Version':'2022-11-28' }; }
export async function dispatch(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) throw Error('Configure the GITHUB_TOKEN Worker secret');
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_BRANCH !== 'main' || env.GITHUB_WORKFLOW !== WORKFLOW) throw Error('Unexpected dispatch destination');
  const response = await fetchImpl(`${BASE}/actions/workflows/${WORKFLOW}/dispatches`, { method:'POST', headers:{...headers(env.GITHUB_TOKEN),'Content-Type':'application/json'}, body:JSON.stringify({ref:'main'}), signal:AbortSignal.timeout(30000) });
  if (![200,204].includes(response.status)) throw Error(`GitHub workflow dispatch failed: HTTP ${response.status}`);
  return {accepted:true,repository:REPO,branch:'main',workflow:WORKFLOW};
}
export async function verifyPassword(provided, expectedHash) {
  const actual = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(provided)));
  const expected = Uint8Array.from(expectedHash.match(/../g)||[], x=>parseInt(x,16));
  return expected.length === 32 && timingSafeEqual(actual, expected);
}
function publicRun(run) { return {id:run.id,status:run.status,conclusion:run.conclusion,created_at:run.created_at,html_url:`https://github.com/${REPO}/actions/runs/${run.id}`}; }
export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const cors = { 'Access-Control-Allow-Origin':ORIGIN, 'Vary':'Origin', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' };
    const reply = (body,status=200) => Response.json(body,{status,headers:cors});
    if (request.method === 'GET' && url.pathname === '/health') return reply({service:'BTC data manual update',scheduleEnabled:false,ready:!!(env.GITHUB_TOKEN && env.UPDATE_PASSWORD_HASH)});
    const prefix = `/github/actions/workflows/${WORKFLOW}`;
    const allowed = (request.method === 'GET' && [prefix,prefix+'/runs'].includes(url.pathname)) || (request.method === 'GET' && /^\/github\/actions\/runs\/\d+$/.test(url.pathname)) || (request.method === 'POST' && url.pathname === prefix+'/dispatches');
    if (request.method === 'OPTIONS') {
      if (request.headers.get('Origin') !== ORIGIN) return reply({error:'Origin denied'},403);
      return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'X-Update-Key, Content-Type','Access-Control-Max-Age':'600'}});
    }
    if (!allowed) return reply({error:'Not found'},404);
    if (request.headers.get('Origin') !== ORIGIN) return reply({error:'Origin denied'},403);
    if (!env.GITHUB_TOKEN || !env.UPDATE_PASSWORD_HASH || !env.AUTH_LIMIT || !env.UPDATE_LIMIT) return reply({error:'後台尚未完成設定'},503);
    if (!(await env.AUTH_LIMIT.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'})).success) return reply({error:'嘗試次數過多，請一分鐘後再試'},429);
    const password = request.headers.get('X-Update-Key') || '';
    if (password.length > 256 || !await verifyPassword(password,env.UPDATE_PASSWORD_HASH)) return reply({error:'更新密碼不正確'},401);
    const gh = async route => {
      const r = await fetch(BASE+route,{headers:headers(env.GITHUB_TOKEN),signal:AbortSignal.timeout(30000)});
      if (!r.ok) throw Error(`GitHub HTTP ${r.status}`);
      return r.json();
    };
    try {
      if (request.method === 'POST') {
        const runs = await gh(`/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=30`);
        const active = runs.workflow_runs.find(r=>r.status!=='completed');
        if (active) return reply({workflow_run_id:active.id,alreadyRunning:true});
        if (!(await env.UPDATE_LIMIT.limit({key:'bybit-data'})).success) return reply({error:'剛剛已送出更新，請一分鐘後再檢查'},429);
        const r = await fetch(`${BASE}/actions/workflows/${WORKFLOW}/dispatches`,{method:'POST',headers:{...headers(env.GITHUB_TOKEN),'Content-Type':'application/json'},body:JSON.stringify({ref:'main'}),signal:AbortSignal.timeout(30000)});
        if (![200,204].includes(r.status)) throw Error(`GitHub HTTP ${r.status}`);
        if(r.status===204) return new Response(null,{status:204,headers:cors});
        const d=await r.json();return reply({workflow_run_id:d.workflow_run_id});
      }
      let route=url.pathname.slice('/github'.length);
      if(url.pathname===prefix+'/runs') route+='?branch=main&per_page=30'+(url.searchParams.get('event')==='workflow_dispatch'?'&event=workflow_dispatch':'');
      const d=await gh(route);
      if(url.pathname===prefix) return reply({state:d.state,name:d.name});
      if(url.pathname===prefix+'/runs') return reply({workflow_runs:d.workflow_runs.map(publicRun)});
      if(d.path!=='.github/workflows/'+WORKFLOW) return reply({error:'Not found'},404);
      return reply(publicRun(d));
    } catch(error) { return reply({error:/^GitHub HTTP \d+$/.test(error.message)?error.message:'後台連線失敗，請稍後重試'},502); }
  },
};
