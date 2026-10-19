import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
const nonce=randomBytes(24).toString('hex');
const account='552eb52d78aad7804e9915f37a567f0c';
const worker='btc-data-update';
let working=false;
const page=(message='')=>`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BTC 後台一次性設定</title><style>body{background:#090d14;color:#e6edf7;font:16px system-ui;max-width:560px;margin:40px auto;padding:20px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0;background:#151e2b;color:#fff;border:1px solid #344154;border-radius:8px}button{background:#2563eb;cursor:pointer}p{line-height:1.7}</style><h2>BTC 後台一次性設定</h2><p>這是只在本機開啟的設定頁。Token 會存入你的 Cloudflare Worker Secret；密碼只傳送雜湊值。設定後不再需要在公開網頁填 Token。</p><p>${message}</p><form method="post" action="/${nonce}/save"><input type="hidden" name="csrf" value="${nonce}"><label>你剛建立的 GitHub 專用 Token<input name="token" type="password" autocomplete="off" required></label><label>設定更新密碼（至少 12 個字元）<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>再輸入一次更新密碼<input name="confirm" type="password" autocomplete="new-password" required></label><button>儲存到 Cloudflare 後台</button></form><p>不要填 GitHub 登入密碼。請自行記住這組更新密碼，以後各裝置更新時使用。</p></html>`;
const server=http.createServer(async(req,res)=>{
 const host=`127.0.0.1:${server.address().port}`;
 const send=(status,html)=>{res.writeHead(status,{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(html);};
 if(req.headers.host!==host)return send(403,'Forbidden');
 if(req.method==='GET'&&req.url===`/${nonce}`)return send(200,page());
 if(req.method==='GET'&&req.url===`/${nonce}/save`){res.writeHead(303,{Location:`/${nonce}`,'Cache-Control':'no-store'});res.end();return;}
 if(req.method!=='POST'||req.url!==`/${nonce}/save`)return send(404,'Not found');
 if(req.headers['sec-fetch-site']==='cross-site')return send(403,page('請直接開啟本機設定頁再送出。'));
 if(working)return send(409,'設定進行中，請稍候');
 working=true;
 try{
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error('input');}
  const form=new URLSearchParams(raw);if(form.get('csrf')!==nonce){working=false;return send(403,page('設定頁已更新，請重新填寫後送出。'));}let token=form.get('token')?.trim(),password=form.get('password');
  if(!token?.startsWith('github_pat_')||!password||password.length<12||password.length>128||password!==form.get('confirm')){working=false;return send(400,page('請確認使用 Fine-grained Token，且兩次更新密碼相同、至少 12 個字元。'));}
  const check=await fetch('https://api.github.com/repos/optiona286/btc-options-klines/actions/workflows/update-op-data.yml',{headers:{Authorization:`Bearer ${token}`,'User-Agent':'BTC-private-setup',Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000)});
  if(!check.ok){working=false;return send(400,page('無法使用此 Token 存取指定專案，請確認 Token 與 Actions 權限。'));}
  const credentials=await fs.readFile(path.join(process.env.APPDATA,'xdg.config/.wrangler/config/default.toml'),'utf8');
  const cfToken=credentials.match(/oauth_token\s*=\s*"([^"]+)"/)?.[1];if(!cfToken)throw Error('auth');
  const secrets={GITHUB_TOKEN:{name:'GITHUB_TOKEN',type:'secret_text',text:token},UPDATE_PASSWORD_HASH:{name:'UPDATE_PASSWORD_HASH',type:'secret_text',text:createHash('sha256').update(password).digest('hex')}};
  const update=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets-bulk`,{method:'PATCH',headers:{Authorization:`Bearer ${cfToken}`,'Content-Type':'application/json'},body:JSON.stringify({secrets}),signal:AbortSignal.timeout(30000)});
  const result=await update.json();if(!update.ok||!result.success)throw Error('cloudflare');
  const health=await fetch(`https://${worker}.d1043190.workers.dev/health`,{signal:AbortSignal.timeout(30000)}).then(r=>r.json());
  if(!health.ready)throw Error('not-ready');
  const verify=await fetch(`https://${worker}.d1043190.workers.dev/github/actions/workflows/update-op-data.yml`,{headers:{Origin:'https://optiona286.github.io','X-Update-Key':password},signal:AbortSignal.timeout(30000)});
  if(!verify.ok)throw Error('verify');
  token='';password='';form.delete('token');form.delete('password');form.delete('confirm');raw='';
  console.log('SECRETS_CONFIGURED_AND_AUTH_VERIFIED');
  send(200,'<!doctype html><meta charset="utf-8"><h2>設定成功</h2><p>GitHub Token 已存入 Cloudflare，更新密碼已驗證成功。可關閉本頁，回 BTC 網頁按「手動更新 data」，輸入剛設定的更新密碼。</p>');
  setTimeout(()=>server.close(),500);
 }catch{working=false;send(500,page('設定尚未完成，請保留本頁並告知「設定未完成」，不要傳送 Token 或密碼。'));console.log('SETUP_NOT_COMPLETED');}
});
server.listen(0,'127.0.0.1',()=>console.log(`SETUP_URL=http://127.0.0.1:${server.address().port}/${nonce}`));
setTimeout(()=>server.close(),30*60000).unref();
