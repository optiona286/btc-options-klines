(() => {
'use strict';
const dataCache=new Map(),btcCache=new Map();let manifest=null, activeMode="data";
const dataURL=relative=>location.hostname==='optiona286.github.io'?new URL(relative,'https://raw.githubusercontent.com/optiona286/btc-options-klines/main/'):new URL('./'+relative,document.baseURI);
window.btcResetStaticData=()=>{manifest=null;dataCache.clear();};
function listDataFiles(){return manifest.files;}
function resolveDataFile(name){const files=listDataFiles();if(!files.length)throw new Error('沒有精簡資料');return files.find(file=>file.name===name)||files[0];}
function loadRows(name){const selected=resolveDataFile(name),cached=dataCache.get(selected.name);if(!cached)throw new Error('資料尚未載入');return {selected,...cached};}
async function prepare(name,signal,mode="data"){
 if(activeMode!==mode){manifest=null;activeMode=mode;}
 if(!manifest){const response=await fetch(dataURL(activeMode+'/manifest.json'),{signal,cache:'no-store'});if(!response.ok)throw new Error('到期日清單讀取失敗');manifest=await response.json();}
 const selected=resolveDataFile(name);if(dataCache.has(selected.name))return;
 const response=await fetch(dataURL(activeMode+'/'+selected.path),{signal,cache:'no-store'});if(!response.ok)throw new Error('精簡資料下載失敗');
 const bytes=new Uint8Array(await response.arrayBuffer());
 const text=bytes[0]===31&&bytes[1]===139?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text():new TextDecoder().decode(bytes);
 const content=JSON.parse(text),rows=[],bySymbol=new Map();
 for(const [symbol,bars] of Object.entries(content.symbols)){
 const match=symbol.match(/^BTC-(?:\d{1,2}[A-Z]{3}\d{2}|\d{6})-(\d+(?:\.\d+)?)-([CP])(?:-USDT)?$/);if(!match)throw new Error('合約格式錯誤');
 const items=bars.map(([time,closeTime,open,high,low,close,volume=null,quoteVolume=null,numberOfTrades=null,takerBuyVolume=null,takerBuyQuoteVolume=null])=>({symbol,expiryDate:content.expiry,strikePrice:Number(match[1]),side:match[2]==='C'?'CALL':'PUT',openTimeLocal:formatMarketTime(time,true),openTimeUtc:formatMarketTime(time),closeTimeLocal:formatMarketTime(closeTime,true),closeTimeUtc:formatMarketTime(closeTime),open,high,low,close,volume,quoteVolume,numberOfTrades,takerBuyVolume,takerBuyQuoteVolume}));bySymbol.set(symbol,items);rows.push(...items);
 }
 rows.sort((a,b)=>a.openTimeUtc.localeCompare(b.openTimeUtc));dataCache.set(selected.name,{rows,bySymbol,symbols:buildSymbolInfo(rows)});while(dataCache.size>3)dataCache.delete(dataCache.keys().next().value);
}
function toBar(row) {
  return {
    time: row.openTimeLocal,
    timeUtc: row.openTimeUtc,
    closeTime: row.closeTimeLocal,
    closeTimeUtc: row.closeTimeUtc,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume == null ? null : Number(row.volume),
    quoteVolume: row.quoteVolume == null ? null : Number(row.quoteVolume),
    trades: row.numberOfTrades == null ? null : Number(row.numberOfTrades),
    takerBuyVolume: row.takerBuyVolume == null ? null : Number(row.takerBuyVolume),
    takerBuyQuoteVolume: row.takerBuyQuoteVolume == null ? null : Number(row.takerBuyQuoteVolume),
  };
}

function periodMinutes(period) {
  return { "1m": 1, "15m": 15, "1h": 60, "4h": 240 }[String(period).toLowerCase()] || null;
}

function normalizePeriod(requestedPeriod, sourceInterval) {
  const source = String(sourceInterval || "").toLowerCase();
  const requested = String(requestedPeriod || source).toLowerCase();
  const period = requested === "source" ? source : requested;
  const sourceMinutes = periodMinutes(source);
  const requestedMinutes = periodMinutes(period);
  if (!requestedMinutes) throw new Error("不支援的週期");
  if (!sourceMinutes) throw new Error("來源 CSV 週期無法辨識");
  if (requestedMinutes < sourceMinutes) throw new Error(`目前來源是 ${sourceInterval}，無法還原成 ${period}`);
  if (requestedMinutes % sourceMinutes !== 0) throw new Error(`${sourceInterval} 無法整除聚合成 ${period}`);
  return period;
}

function groupKeyForLocalTime(time, minutes) {
  const match = String(time).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return String(time);
  const date = match[1];
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const total = hour * 60 + minute;
  const bucket = Math.floor(total / minutes) * minutes;
  const hh = String(Math.floor(bucket / 60)).padStart(2, "0");
  const mm = String(bucket % 60).padStart(2, "0");
  return `${date} ${hh}:${mm}:00`;
}

function aggregateBars(rows, period, sourceInterval) {
  const target = normalizePeriod(period, sourceInterval);
  if (target === sourceInterval) return rows;

  const minutes = periodMinutes(target);
  const grouped = new Map();
  for (const row of rows) {
    const key = groupKeyForLocalTime(row.time, minutes);
    if (!grouped.has(key)) {
      grouped.set(key, {
        time: key,
        timeUtc: row.timeUtc,
        closeTime: row.closeTime,
        closeTimeUtc: row.closeTimeUtc,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: null,
        quoteVolume: null,
        trades: null,
        takerBuyVolume: null,
        takerBuyQuoteVolume: null,
        sourceBars: 0,
      });
    }
    const item = grouped.get(key);
    item.high = Math.max(item.high, row.high);
    item.low = Math.min(item.low, row.low);
    item.close = row.close;
    item.closeTime = row.closeTime;
    item.closeTimeUtc = row.closeTimeUtc;
    if (row.volume != null) item.volume = (item.volume || 0) + row.volume;
    if (row.quoteVolume != null) item.quoteVolume = (item.quoteVolume || 0) + row.quoteVolume;
    if (row.trades != null) item.trades = (item.trades || 0) + row.trades;
    if (row.takerBuyVolume != null) item.takerBuyVolume = (item.takerBuyVolume || 0) + row.takerBuyVolume;
    if (row.takerBuyQuoteVolume != null) item.takerBuyQuoteVolume = (item.takerBuyQuoteVolume || 0) + row.takerBuyQuoteVolume;
    item.sourceBars += 1;
  }
  return [...grouped.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function buildSymbolInfo(rows) {
  const bySymbol = new Map();
  for (const row of rows) {
    if (!row.symbol) continue;
    if (!bySymbol.has(row.symbol)) {
      bySymbol.set(row.symbol, {
        symbol: row.symbol,
        expiryDate: row.expiryDate,
        strikePrice: Number(row.strikePrice),
        side: row.side,
        count: 0,
        firstTime: row.openTimeLocal,
        lastTime: row.openTimeLocal,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: null,
        quoteVolume: null,
        trades: null,
      });
    }
    const item = bySymbol.get(row.symbol);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    item.count += 1;
    item.lastTime = row.openTimeLocal;
    if (Number.isFinite(open) && item.count === 1) item.open = open;
    if (Number.isFinite(high)) item.high = Math.max(item.high, high);
    if (Number.isFinite(low)) item.low = Math.min(item.low, low);
    if (Number.isFinite(close)) item.close = close;
    if (row.volume != null) item.volume = (item.volume || 0) + Number(row.volume);
    if (row.quoteVolume != null) item.quoteVolume = (item.quoteVolume || 0) + Number(row.quoteVolume);
    if (row.numberOfTrades != null) item.trades = (item.trades || 0) + Number(row.numberOfTrades);
  }

  return [...bySymbol.values()]
    .map((item) => ({
      ...item,
      changePct: item.open ? ((item.close / item.open) - 1) * 100 : 0,
    }))
    .sort((a, b) => a.strikePrice - b.strikePrice || a.side.localeCompare(b.side));
}

function buildOptionChain(symbols) {
  const byStrike = new Map();
  for (const item of symbols) {
    const key = `${item.expiryDate}:${item.strikePrice}`;
    if (!byStrike.has(key)) {
      byStrike.set(key, { expiryDate: item.expiryDate, strikePrice: item.strikePrice, call: null, put: null });
    }
    const row = byStrike.get(key);
    if (item.side === "CALL") row.call = item;
    if (item.side === "PUT") row.put = item;
  }
  return [...byStrike.values()].sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.strikePrice - b.strikePrice);
}

function getMeta(fileName) {
  const { selected, rows, symbols } = loadRows(fileName);
  return {
    ok: true,
    file: selected,
    files: listDataFiles(),
    rowCount: rows.length,
    symbolCount: symbols.length,
    symbols,
    expiries: [...new Set(symbols.map((item) => item.expiryDate))].sort(),
    chain: buildOptionChain(symbols),
    periods: selected.interval === "15m" ? ["15m", "1h", "4h"] : ["1h", "4h"],
  };
}

function getKlines(fileName, symbol, period) {
  if (!symbol) throw new Error("缺少 symbol");
  const { selected, bySymbol } = loadRows(fileName);
  const rawItems = (bySymbol.get(symbol) || [])
    .map(toBar)
    .filter((row) => [row.open, row.high, row.low, row.close].every(Number.isFinite))
    .sort((a, b) => a.time.localeCompare(b.time));
  const selectedPeriod = normalizePeriod(period, selected.interval);
  const items = aggregateBars(rawItems, selectedPeriod, selected.interval);
  return {
    ok: true,
    file: selected,
    symbol,
    sourceInterval: selected.interval,
    period: selectedPeriod,
    count: items.length,
    sourceCount: rawItems.length,
    items,
  };
}

function formatMarketTime(milliseconds, local = false) {
  return new Date(milliseconds + (local ? 8 * 3600000 : 0)).toISOString().slice(0, 19).replace("T", " ");
}

function optionTimestamp(row) {
  if (row.openTimeUtc) return Date.parse(row.openTimeUtc.replace(" ", "T") + "Z");
  return Date.parse(String(row.openTimeLocal).replace(" ", "T") + "+08:00");
}

async function fetchBtcCandles(start, end, granularity, signal) {
  const key = `${start}:${end}:${granularity}`;
  const cached = btcCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const step = granularity * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("BTC/USD 時間範圍無效");
  if ((end - start) / step > 10000) throw new Error("此契約時間範圍過長，請選擇較短的資料檔");
  const providers = [
    {
      name: "Coinbase Exchange", pageSize: 299,
      url(from, to) {
        const url = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
        url.search = new URLSearchParams({start: new Date(from).toISOString(), end: new Date(to - 1).toISOString(), granularity: String(granularity)});
        return url;
      },
      candles(data) { return Array.isArray(data) ? data : null; }
    },
    {
      name: "Bitstamp", pageSize: 999,
      url(from, to) {
        const url = new URL("https://www.bitstamp.net/api/v2/ohlc/btcusd/");
        url.search = new URLSearchParams({step: String(granularity), start: String(Math.floor(from / 1000)), end: String(Math.floor((to - 1) / 1000)), limit: String(Math.ceil((to - from) / step))});
        return url;
      },
      candles(data) {
        return Array.isArray(data?.data?.ohlc) ? data.data.ohlc.map(c => [c.timestamp, c.low, c.high, c.open, c.close, c.volume]) : null;
      }
    }
  ];
  const errors = [];
  for (const provider of providers) {
    // Start the whole range over on fallback: do not mix exchanges within one chart.
    const bars = new Map();
    try {
      for (let cursor = start; cursor < end; cursor += step * provider.pageSize) {
        signal.throwIfAborted();
        const pageEnd = Math.min(end, cursor + step * provider.pageSize);
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal.addEventListener("abort", cancel, {once: true});
        const timeout = setTimeout(() => controller.abort(new DOMException("行情來源連線逾時", "TimeoutError")), 8000);
        let candles;
        try {
          signal.throwIfAborted();
          const response = await fetch(provider.url(cursor, pageEnd), {signal: controller.signal, headers: {Accept: "application/json"}});
          if (!response.ok) throw new Error(response.status === 429 ? "請求過於頻繁（HTTP 429）" : `HTTP ${response.status}`);
          candles = provider.candles(await response.json());
          if (!Array.isArray(candles)) throw new Error("行情回傳格式異常");
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener("abort", cancel);
        }
        for (const candle of candles) {
          if (!Array.isArray(candle) || candle.length < 6 || candle.slice(0, 6).some(n => n === null || n === "" || !Number.isFinite(Number(n)))) continue;
          const [seconds, low, high, open, close, volume] = candle.map(Number);
          const time = seconds * 1000;
          if (time < start || time >= end || time >= Date.now()) continue;
          if (low <= 0 || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0) continue;
          bars.set(time, {
            time: formatMarketTime(time, true), timeUtc: formatMarketTime(time),
            closeTime: formatMarketTime(time + step - 1000, true), closeTimeUtc: formatMarketTime(time + step - 1000),
            open, high, low, close, volume,
            quoteVolume: null, trades: null, takerBuyVolume: null, takerBuyQuoteVolume: null
          });
        }
      }
      signal.throwIfAborted();
      const items = [...bars.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
      if (!items.length) throw new Error("此時間區間沒有 BTC/USD K 線");
      const result = {items, provider: provider.name};
      btcCache.delete(key);
      btcCache.set(key, {result, expires: Date.now() + (end < Date.now() - 3600000 ? 3600000 : 30000)});
      while (btcCache.size > 24) btcCache.delete(btcCache.keys().next().value);
      return result;
    } catch (error) {
      // A changed selection or overall request timeout must stop all providers.
      signal.throwIfAborted();
      errors.push(provider.name + "：" + (error?.message || "連線失敗"));
    }
  }
  throw new Error("BTC/USD 所有來源皆無法載入（" + errors.join("；") + "），請稍後按重讀");
}

async function getBtcKlines(fileName, symbol, period, signal) {
  const { selected, bySymbol, symbols } = loadRows(fileName);
  const reference = symbols.find((item) => item.symbol === symbol);
  if (!reference) throw new Error("找不到對應契約，請重新選擇履約價");
  const selectedPeriod = normalizePeriod(period, selected.interval);
  // A strike represents both CALL and PUT at the same expiry. Use their union in this CSV.
  const times = symbols.filter((item) => item.expiryDate === reference.expiryDate && item.strikePrice === reference.strikePrice)
    .flatMap((item) => bySymbol.get(item.symbol) || []).map(optionTimestamp).filter(Number.isFinite);
  if (!times.length) throw new Error("此契約沒有有效的歷史時間範圍");
  const optionStart = Math.min(...times);
  const optionEnd = Math.max(...times) + periodMinutes(selected.interval) * 60000;
  const bucket = periodMinutes(selectedPeriod) * 60000;
  const fullOnlineRange = /\.github\.io$/i.test(location.hostname);
  const expiryEnd = Date.parse(reference.expiryDate + 'T16:00:00+08:00');
  const start = fullOnlineRange ? expiryEnd - 3 * 86400000 : Math.floor(optionStart / bucket) * bucket;
  const end = fullOnlineRange ? expiryEnd : Math.ceil(optionEnd / bucket) * bucket;
  if (start >= Date.now()) throw new Error("此契約對應時間尚未到來，無法取得 BTC/USD 歷史 K 線");
  const sourceInterval = selectedPeriod === "15m" ? "15m" : "1h";
  const granularity = periodMinutes(sourceInterval) * 60;
  const availableEnd = Math.min(end, Math.ceil(Date.now() / (granularity * 1000)) * granularity * 1000);
  const {items: rawItems, provider} = await fetchBtcCandles(start, availableEnd, granularity, signal);
  const items = aggregateBars(rawItems, selectedPeriod, sourceInterval).map((bar) => ({
    ...bar, quoteVolume: null, trades: null, takerBuyVolume: null, takerBuyQuoteVolume: null,
    timeUtc: formatMarketTime(Date.parse(bar.time.replace(" ", "T") + "+08:00")),
  }));
  return {
    ok: true, market: "btc", symbol: "BTC-USD", provider, file: selected,
    reference: { symbol, expiryDate: reference.expiryDate, strikePrice: reference.strikePrice },
    range: { start: formatMarketTime(start, true), end: formatMarketTime(end - 1000, true),
      optionStart: formatMarketTime(optionStart, true), optionEnd: formatMarketTime(optionEnd - 1000, true) },
    period: selectedPeriod, sourceInterval, count: items.length, sourceCount: rawItems.length,
    missingSourceBars: Math.max(0, Math.round((availableEnd - start) / (granularity * 1000)) - rawItems.length), items,
  };
}


window.btcStaticApi=async function(requestedUrl,controller){
 const url=new URL(requestedUrl,'https://static.local'),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(url.pathname==='/api/btc-klines'?50000:20000)]);
 await prepare(url.searchParams.get('file'),signal,url.searchParams.get('mode')||'data');signal.throwIfAborted();
 if(url.pathname==='/api/meta')return getMeta(url.searchParams.get('file'));
 if(url.pathname==='/api/klines')return getKlines(url.searchParams.get('file'),url.searchParams.get('symbol'),url.searchParams.get('period'));
 if(url.pathname==='/api/btc-klines')return getBtcKlines(url.searchParams.get('file'),url.searchParams.get('symbol'),url.searchParams.get('period'),signal);
 throw new Error('不支援的資料操作');
};
})();
