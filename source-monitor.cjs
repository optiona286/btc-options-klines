'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
module.exports=function start(root){
 const state={enabled:true,running:false,stage:'等待新資料',lastScan:null,error:'',revision:{data:'',data1:''},sources:{data:'',data1:path.join(root,'原始資料','幣安成交')}};
 const config=JSON.parse(fs.readFileSync(path.join(root,'資料轉換工具','config.json'),'utf8'));state.sources.data=path.resolve(root,'資料轉換工具',config.sourceDirectory);
 const children=new Set();let stopping=false;
 function revision(){for(const mode of ['data','data1']){try{const s=fs.statSync(path.join(root,mode,'manifest.json'));state.revision[mode]=s.size+':'+s.mtimeMs;}catch{state.revision[mode]='';}}}
 function run(script,args,label){return new Promise(resolve=>{state.stage=label;const child=spawn(process.execPath,[script,...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});children.add(child);let error='',buffer='';
 child.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split(/\r?\n/);buffer=lines.pop();for(const line of lines)if(line.trim())state.stage=label+'：'+line.trim().slice(-220);});
 child.stderr.on('data',b=>{error=(error+b.toString()).slice(-1600);});
 child.on('error',e=>{error=e.message;});child.on('close',code=>{children.delete(child);if(code!==0||error)state.error+=(state.error?'\n':'')+label+'：'+(error||'退出碼 '+code);resolve();});});}
 async function tick(){if(state.running||stopping)return;state.running=true;state.error='';try{
  await run(path.join(root,'資料轉換工具','convert.js'),[],'標記價格');
  if(!stopping)await run(path.join(root,'convert-binance-data1.cjs'),[root],'幣安成交');
 }catch(e){state.error=e.message;}finally{revision();state.lastScan=new Date().toISOString();state.running=false;state.stage=state.error?'部分資料轉換失敗':'檢查完成；重新整理或重開網頁時再檢查';}}
 revision();tick();
 const stop=()=>{stopping=true;for(const child of children)child.kill();};process.on('exit',stop);process.on('SIGTERM',()=>{stop();process.exit(0);});process.on('SIGINT',()=>{stop();process.exit(0);});
 return {status:()=>({...state,revision:{...state.revision}}),scan:tick,stop};
};
