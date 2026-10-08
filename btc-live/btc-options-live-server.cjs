'use strict';
const http=require('http'),fs=require('fs');
const PORT=Number(process.env.PORT || 5084),HTML=require('path').join(__dirname,'btc_usd_desktop_1h.html');
const cache=new Map(),pending=new Map();let blockedUntil=0;
async function market(endpoint){
  const entry=cache.get(endpoint),ttl=endpoint==='exchangeInfo'?300000:800;
  if(entry&&Date.now()-entry.time<ttl)return entry.data;
  if(Date.now()<blockedUntil)throw Error('API 暫時限流，稍後重試');
  if(pending.has(endpoint))return pending.get(endpoint);
  const work=(async()=>{const response=await fetch('https://eapi.binance.com/eapi/v1/'+endpoint,{signal:AbortSignal.timeout(10000)});
    if(!response.ok){if(response.status===429||response.status===418)blockedUntil=Date.now()+Math.max(60,Number(response.headers.get('retry-after'))||60)*1000;throw Error('期權 API HTTP '+response.status);}
    const data=await response.json();if(data.code<0)throw Error(data.msg);cache.set(endpoint,{time:Date.now(),data});return data;
  })();pending.set(endpoint,work);try{return await work;}finally{pending.delete(endpoint);}
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(data));}
http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1:'+PORT);
  if(req.method!=='GET')return send(res,405,{error:'GET only'});
  if(url.pathname==='/ping')return send(res,200,{ok:true,appId:'btc-options-live-overlay'});
  if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(fs.readFileSync(HTML));return;}
  if(url.pathname==='/api/options/contracts'){const data=await market('exchangeInfo');return send(res,200,{items:data.optionSymbols.filter(s=>s.underlying==='BTCUSDT'&&s.status==='TRADING').map(s=>({symbol:s.symbol,expiryDate:s.expiryDate,strikePrice:s.strikePrice,side:s.side}))});}
  if(url.pathname==='/api/options/marks'){const data=await market('mark');return send(res,200,{items:data.filter(s=>s.symbol.startsWith('BTC-')).map(s=>({symbol:s.symbol,markPrice:s.markPrice}))});}
  send(res,404,{error:'Not found'});
}catch(e){send(res,502,{error:e.message});}}).listen(PORT,'127.0.0.1');
