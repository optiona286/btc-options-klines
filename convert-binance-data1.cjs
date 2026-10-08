'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),readline=require('readline');
const root=process.argv[2]||__dirname,dir=path.join(root,'data1'),input=path.join(root,'原始資料','幣安成交'),stateDir=path.join(root,'資料轉換工具','.state');
const atomic=(file,data)=>{const tmp=file+'.tmp-'+process.pid;try{fs.writeFileSync(tmp,data);fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}};
const parse=line=>{let quote=false,value='',out=[];for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){value+='"';i++;}else quote=!quote;}else if(c===','&&!quote){out.push(value);value='';}else value+=c;}out.push(value);return out;};
const num=v=>v==null||v===''?null:Number(v),local=ms=>new Date(ms+28800000).toISOString().slice(0,10);
function files(folder){return fs.readdirSync(folder,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(folder,e.name)):e.name.toLowerCase().endsWith('.csv')?[path.join(folder,e.name)]:[]).sort();}
(async()=>{
 if(!fs.existsSync(input))throw Error('找不到幣安來源資料夾：'+input);
 fs.mkdirSync(stateDir,{recursive:true});
 const lock=path.join(stateDir,'binance.lock');if(fs.existsSync(lock)){try{process.kill(Number(fs.readFileSync(lock,'utf8')),0);throw Error('幣安轉換已在執行');}catch(e){if(e.code!=='ESRCH')throw e;fs.unlinkSync(lock);}}
 fs.writeFileSync(lock,String(process.pid),{flag:'wx'});process.on('exit',()=>{try{fs.unlinkSync(lock);}catch{}});
 const ledgerPath=path.join(stateDir,'binance-processed.json'),ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{};
 const manifestPath=path.join(dir,'manifest.json'),manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):{version:1,interval:'15m',dataType:'OPTION_TRADE_OHLC',volumeAvailable:true,files:[]};
 let updated=0,failed=0;
 for(const file of files(input)){
  if(/_(all_symbols|all_failed_symbols)\.csv$/i.test(file))continue;
  const stat=fs.statSync(file),signature=stat.size+':'+stat.mtimeMs,key=path.relative(input,file);
  if(ledger[key]?.signature===signature)continue;
  console.log('處理 '+key);
  try{
   let headers,interval;const groups=new Map();
   const reader=readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity});
   for await(const line of reader){if(!line.trim())continue;if(!headers){headers=parse(line.replace(/^\uFEFF/,''));for(const k of ['symbol','expiryDate','interval','openTimeUtc','closeTimeUtc','open','high','low','close'])if(!headers.includes(k))throw Error('無法辨識格式，缺少欄位 '+k);continue;}
    const vals=parse(line),r=Object.fromEntries(headers.map((k,i)=>[k,vals[i]]));
    if(r.interval!=='15m')throw Error('僅接受幣安 15m K 線 CSV；請放入 15m 版本，避免混合週期');interval=r.interval;
    const t=Date.parse((r.openTimeUtc||'').replace(' ','T')+'Z'),end=Date.parse((r.closeTimeUtc||'').replace(' ','T')+'Z'),prices=['open','high','low','close'].map(k=>num(r[k]));
    if(!Number.isFinite(t)||!Number.isFinite(end)||prices.some(n=>n==null||!Number.isFinite(n)))continue;
    if(!/^BTC-\d{6}-\d+(?:\.\d+)?-[CP]$/.test(r.symbol)||!/^\d{4}-\d{2}-\d{2}$/.test(r.expiryDate))throw Error('合約名稱或到期日格式不符');
    if(end<t||prices[1]<Math.max(prices[0],prices[3])||prices[2]>Math.min(prices[0],prices[3]))throw Error('K 線價格或時間不合理');
    const expiry=r.expiryDate,day=local(t),first=new Date(Date.parse(expiry+'T00:00:00Z')-172800000).toISOString().slice(0,10);if(day<first||day>expiry)continue;
    const optional=['volume','quoteVolume','numberOfTrades','takerBuyVolume','takerBuyQuoteVolume'].map(k=>num(r[k]));if(optional.some(n=>n!=null&&(!Number.isFinite(n)||n<0)))throw Error('成交量或筆數不合理');
    if(!groups.has(expiry))groups.set(expiry,new Map());const symbols=groups.get(expiry);if(!symbols.has(r.symbol))symbols.set(r.symbol,new Map());symbols.get(r.symbol).set(t,[t,end,...prices,...optional]);
   }
   if(!headers)throw Error('CSV 為空檔');const after=fs.statSync(file);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('檔案仍在寫入，稍後重試');
   const outputs=[];
   for(const [expiry,symbols] of groups){const name='binance-'+expiry+'.json.gz',target=path.join(dir,name),content=fs.existsSync(target)?JSON.parse(zlib.gunzipSync(fs.readFileSync(target))):{expiry,interval,symbols:{},dataType:'OPTION_TRADE_OHLC'};
    if(content.interval!==interval)throw Error('既有資料週期不符');
    for(const [symbol,added] of symbols){const merged=new Map((content.symbols[symbol]||[]).map(b=>[b[0],b]));for(const [t,b] of added)merged.set(t,b);content.symbols[symbol]=[...merged.values()].sort((a,b)=>a[0]-b[0]);}
    const dates=new Set();let barCount=0;for(const bars of Object.values(content.symbols)){barCount+=bars.length;for(const b of bars)dates.add(local(b[0]));}const sorted=[...dates].sort(),bytes=zlib.gzipSync(JSON.stringify(content));
    const entry={name:'data1:'+expiry,path:name,date:expiry,interval,size:bytes.length,modifiedAt:new Date().toISOString(),sourceDays:dates.size,firstDate:sorted[0],lastDate:sorted.at(-1),barCount,symbolCount:Object.keys(content.symbols).length,volumeAvailable:true,provider:'Binance',dataType:'OPTION_TRADE_OHLC',missingDates:Array.from({length:3},(_,i)=>new Date(Date.parse(expiry+'T00:00:00Z')-(2-i)*86400000).toISOString().slice(0,10)).filter(d=>!dates.has(d))};outputs.push({target,bytes,entry});
   }
   for(const item of outputs){atomic(item.target,item.bytes);manifest.files=manifest.files.filter(f=>f.name!==item.entry.name);manifest.files.push(item.entry);}
   if(outputs.length){manifest.files.sort((a,b)=>b.date.localeCompare(a.date));manifest.generatedAt=new Date().toISOString();atomic(manifestPath,JSON.stringify(manifest,null,2));updated++;}
   ledger[key]={signature,convertedAt:new Date().toISOString(),expiries:[...groups.keys()]};atomic(ledgerPath,JSON.stringify(ledger,null,2));console.log(key+' 完成，更新 '+outputs.length+' 個到期日');
  }catch(e){failed++;console.error(key+'：'+e.message);}
 }
 console.log('完成，更新 '+updated+' 個 CSV；未變更資料略過。');if(failed)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
