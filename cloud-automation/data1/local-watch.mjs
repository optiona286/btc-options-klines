import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const once=process.argv.includes('--once');
const stateDir=path.join(root,'資料轉換工具','.state','data1-auto');
const input=path.join(root,'原始資料','幣安成交');
const checkout=path.join(stateDir,'publish-checkout');
const gitExe=process.env.BTC_GIT_EXE || (process.platform==='win32'?'C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe':'git');
const remote='https://github.com/optiona286/btc-options-klines.git';
fs.mkdirSync(stateDir,{recursive:true});fs.mkdirSync(input,{recursive:true});
const statusPath=path.join(stateDir,'status.json'),receiptPath=path.join(stateDir,'processed.json'),lockPath=path.join(stateDir,'watch.lock');
let receipts=fs.existsSync(receiptPath)?JSON.parse(fs.readFileSync(receiptPath)):{};
let busy=false,rerunAfter=0;
const observations=new Map();
function atomic(file,value){const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(value,null,2));fs.renameSync(temp,file);}
function log(stage,details={}){const data={at:new Date().toISOString(),pid:process.pid,stage,...details};atomic(statusPath,data);fs.appendFileSync(path.join(stateDir,'activity.log'),JSON.stringify(data)+'\n');console.log(stage);}
function run(exe,args,cwd){const r=spawnSync(exe,args,{cwd,windowsHide:true,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});if(r.error||r.status!==0)throw Error(`${path.basename(exe)} ${args[0]} failed: ${r.error?.message || (r.stderr||r.stdout).slice(-1200)}`);return r.stdout;}
const git=(cwd,args)=>{const out=run(gitExe,['-c',`safe.directory=${cwd}`,...args],cwd);return args.includes('-z')?out:out.trim();};
function csvFiles(folder){return fs.readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?csvFiles(path.join(folder,e.name)):e.isFile()&&e.name.toLowerCase().endsWith('_klines.csv')&&e.name.includes('_15m_')?[path.join(folder,e.name)]:[]);}
function signature(file){const s=fs.statSync(file);return `${s.size}:${s.mtimeMs}`;}
function validate(names){const manifest=JSON.parse(fs.readFileSync(path.join(checkout,'data1','manifest.json')));let bars=0;for(const name of names){if(!name.endsWith('.json.gz'))continue;const entry=manifest.files.find(x=>'data1/'+x.path===name);if(!entry)throw Error('Missing manifest entry');const bytes=fs.readFileSync(path.join(checkout,name)),data=JSON.parse(gunzipSync(bytes));if(bytes.length!==entry.size||data.expiry!==entry.date||data.interval!=='15m')throw Error('Wrong data1 size or schema');let count=0;const days=new Set();for(const[symbol,rows]of Object.entries(data.symbols)){if(!/^BTC-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(symbol))throw Error('Wrong symbol');let prev=-Infinity;for(const row of rows){const[t,end,o,h,l,c,...vol]=row;if(row.length!==11||!row.slice(0,6).every(Number.isFinite)||t<=prev||t%900000||end<t||end>=t+900000||l<0||h<Math.max(o,l,c)||l>Math.min(o,h,c)||vol.some(n=>n!==null&&(!Number.isFinite(n)||n<0)))throw Error('Invalid Kline');const day=new Date(t+28800000).toISOString().slice(0,10);if(![0,1,2].includes((Date.parse(entry.date)-Date.parse(day))/86400000))throw Error('Wrong date range');days.add(day);prev=t;count++;}}const missing=[2,1,0].map(n=>new Date(Date.parse(entry.date)-n*86400000).toISOString().slice(0,10)).filter(d=>!days.has(d));if(!count||count!==entry.barCount||Object.keys(data.symbols).length!==entry.symbolCount||days.size!==entry.sourceDays||JSON.stringify(missing)!==JSON.stringify(entry.missingDates))throw Error('Manifest counts differ');bars+=count;}return bars;}
function publish(files){
 log('準備轉換及上傳');
 if(!fs.existsSync(path.join(checkout,'.git')))git(root,['clone','--quiet','--single-branch','--branch','main',remote,checkout]);
 if(git(checkout,['remote','get-url','origin'])!==remote)throw Error('Unexpected publishing remote');
 const unfinished=git(checkout,['status','--porcelain=v1','-z','--untracked-files=all']).split('\0').filter(Boolean);
 if(unfinished.length){
  for(const item of unfinished)if(!/^data1\/(manifest\.json|binance-\d{4}-\d{2}-\d{2}\.json\.gz)$/.test(item.slice(3)))throw Error('Unexpected unfinished publishing path');
  // Only this managed scratch checkout is reset; source CSVs and the user's checkout are untouched.
  git(checkout,['restore','--staged','--worktree','--','data1']);
  for(const item of unfinished)if(item.startsWith('??'))fs.unlinkSync(path.join(checkout,item.slice(3)));
  const scratchLedger=path.join(checkout,'資料轉換工具','.state','binance-processed.json');
  if(fs.existsSync(scratchLedger))fs.unlinkSync(scratchLedger);
 }
 git(checkout,['fetch','--quiet','origin','main']);
 try{git(checkout,['rebase','origin/main']);}catch(e){try{git(checkout,['rebase','--abort']);}catch{}throw e;}
 const captured={};
 for(const file of files){const relative=path.relative(input,file);const target=path.join(checkout,'原始資料','幣安成交',relative);fs.mkdirSync(path.dirname(target),{recursive:true});const before=signature(file);fs.copyFileSync(file,target);if(signature(file)!==before)throw Error('來源仍在寫入，稍後重試');captured[relative]=before;}
 log('轉換 15m CSV 並更新索引');
 run(process.execPath,[path.join(root,'convert-binance-data1.cjs'),checkout],root);
 const changed=git(checkout,['status','--porcelain=v1','-z','--untracked-files=all']).split('\0').filter(Boolean).map(record=>{const name=record.slice(3);if(!/^data1\/(manifest\.json|binance-\d{4}-\d{2}-\d{2}\.json\.gz)$/.test(name)||record.slice(0,2).includes('D'))throw Error('Unexpected publish path: '+name);return name;});
 const bars=validate(changed);
 if(changed.length){git(checkout,['config','user.name','BTC data1 local automation']);git(checkout,['config','user.email','btc-data1-local@users.noreply.github.com']);git(checkout,['add','--',...changed]);git(checkout,['commit','-m','Update Binance data1 from local source CSVs']);}
 git(checkout,['fetch','--quiet','origin','main']);
 try{git(checkout,['rebase','origin/main']);}catch(e){try{git(checkout,['rebase','--abort']);}catch{}throw e;}
 git(checkout,['push','origin','HEAD:refs/heads/main']);
 const commit=git(checkout,['rev-parse','HEAD']);
 let localSynced=false,warning='';
 try{if(git(root,['branch','--show-current'])!=='main'||git(root,['status','--porcelain']))throw Error('本機有未提交修改，未自動同步');git(root,['fetch','--quiet','origin','main']);git(root,['merge','--ff-only','origin/main']);localSynced=true;}catch(e){warning=e.message;}
 receipts={...receipts,...captured};atomic(receiptPath,receipts);
 log('精簡資料及索引已上傳 Git',{commit,changedFiles:changed,checkedBars:bars,localSynced,warning});
}
function scan(force=false){if(busy||(!force&&Date.now()<rerunAfter))return;const all=csvFiles(input);const changed=all.filter(file=>receipts[path.relative(input,file)]!==signature(file));if(!changed.length)return;const stable=all.map(file=>{const s=fs.statSync(file),sig=signature(file),seen=observations.get(file);observations.set(file,sig);return seen===sig&&Date.now()-s.mtimeMs>=10000;}).every(Boolean);if(!force&&!stable)return;busy=true;try{publish(all);rerunAfter=0;}catch(e){log('自動更新失敗，保留原始資料並稍後重試',{error:e.message});rerunAfter=Date.now()+60000;if(once)process.exitCode=1;}finally{busy=false;}}
try{const fd=fs.openSync(lockPath,'wx');fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lockPath));try{process.kill(pid,0);console.log('data1 監看已在執行');process.exit(0);}catch(x){if(x.code!=='ESRCH')throw x;fs.unlinkSync(lockPath);fs.writeFileSync(lockPath,String(process.pid),{flag:'wx'});}}
process.on('exit',()=>{try{fs.unlinkSync(lockPath);}catch{}});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));
log(once?'執行一次 data1 轉換上傳':'已啟動 data1 背景監看');
if(once)scan(true);else{scan();setInterval(()=>{try{scan();}catch(e){log('監看錯誤',{error:e.message});}},10000);}
