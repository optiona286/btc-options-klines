// Dedicated Binance option TRADE pipeline. Never imports Bybit mark prices.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { checkRemote, git, requireClean } from '../run.mjs';
import { dateMs, isoDay, DAY_MS } from '../archives.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = 'https://eapi.binance.com';
const INTERVAL_MS = 900000;
const taipeiDay = ms => isoDay(ms + 28800000);
const utcText = ms => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const localText = ms => utcText(ms + 28800000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(route, query = {}) {
  const url = new URL(route, API);
  url.search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        const region = response.status === 451 ? ' Binance does not allow access from this runner region.' : '';
        const error = new Error(`Binance ${route}: HTTP ${response.status}.${region}`);
        error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
      }
      const data = await response.json();
      if (!Array.isArray(data) && Number(data.code) < 0) {
        const error = new Error(`Binance API ${data.code}: ${data.msg}`);
        error.permanent = ![-1003, -1006, -1007, -1008].includes(data.code);
        throw error;
      }
      return data;
    } catch (error) {
      if (error.permanent || attempt === 3) throw error;
      await pause(1000 * 2 ** attempt);
    }
  }
}

function csv(values) {
  return values.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',');
}

function decodeKline(row) {
  if (!Array.isArray(row) || row.length < 12) throw new Error('Unexpected Binance Kline response; expected a 12-column tuple');
  for (let i = 0; i <= 10; i++) {
    if (row[i] === '' || row[i] === null || !Number.isFinite(Number(row[i]))) throw new Error('Missing/invalid price, volume, or time in Binance response');
  }
  const [time, open, high, low, close, volume, end, amount, trades, takerVolume, takerAmount] = row.map(Number);
  if (!Number.isSafeInteger(time) || time % INTERVAL_MS || !Number.isSafeInteger(end) || end < time || end >= time + INTERVAL_MS) throw new Error('Invalid 15m candle timestamps');
  if (low < 0 || high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw new Error('Invalid Binance trade OHLC');
  if ([volume, amount, trades, takerVolume, takerAmount].some(value => value < 0) || !Number.isSafeInteger(trades)) throw new Error('Invalid trade volume or trade count');
  return [time, end, open, high, low, close, volume, amount, trades, takerVolume, takerAmount];
}

function validateCompact(payload, entry, expected, expiry) {
  if (payload.expiry !== expiry || payload.interval !== '15m' || payload.dataType !== 'OPTION_TRADE_OHLC') throw new Error('Wrong data1 schema');
  const actual = new Map();
  const dates = new Set();
  for (const [symbol, rows] of Object.entries(payload.symbols)) {
    let previous = -Infinity;
    for (const row of rows) {
      if (row.length !== 11 || row[0] <= previous || row[0] % INTERVAL_MS || !row.slice(0, 6).every(Number.isFinite)) throw new Error('Invalid or duplicate compact data1 bar');
      const day = taipeiDay(row[0]);
      const distance = (dateMs(expiry) - dateMs(day)) / DAY_MS;
      if (![0,1,2].includes(distance)) throw new Error('data1 bar outside the existing three-day Taipei window');
      actual.set(`${symbol}:${row[0]}`, row);
      dates.add(day); previous = row[0];
    }
  }
  if (actual.size !== expected.size) throw new Error('data1 merge lost or added unexpected bars');
  for (const [key, row] of expected) {
    if (JSON.stringify(row) !== JSON.stringify(actual.get(key))) throw new Error(`data1 conversion differs from source: ${key}`);
  }
  const missing = [-2,-1,0].map(n => isoDay(dateMs(expiry) + n * DAY_MS)).filter(day => !dates.has(day));
  if (entry.barCount !== actual.size || entry.symbolCount !== Object.keys(payload.symbols).length || entry.sourceDays !== dates.size || JSON.stringify(entry.missingDates) !== JSON.stringify(missing)) throw new Error('data1 manifest does not match the converted data');
  return actual.size;
}

function allowedChanges() {
  const records = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  return records.map(record => {
    const name = record.slice(3);
    if (/^[RC]/.test(record.slice(0,2).trim()) || record.slice(0,2).includes('D') || !/^data1\/(?:manifest\.json|binance-\d{4}-\d{2}-\d{2}\.json\.gz)$/.test(name)) throw new Error(`Refusing to publish a path outside data1: ${name}`);
    return name;
  });
}

async function main() {
  const publish = process.argv.includes('--publish');
  if (process.argv.slice(2).some(arg => arg !== '--publish')) throw new Error('Usage: node cloud-automation/data1/run.mjs [--publish]; optional REQUEST_EXPIRY=YYYY-MM-DD');
  const config = JSON.parse(await fs.readFile(path.join(root, 'cloud-automation', 'config.json'), 'utf8'));
  if (publish) {
    checkRemote(root, config); requireClean(root);
    git(root, ['fetch', 'origin', config.branch], false);
    git(root, ['merge', '--ff-only', `origin/${config.branch}`], false);
    if (git(root, ['rev-parse', 'HEAD']).trim() !== git(root, ['rev-parse', `origin/${config.branch}`]).trim()) throw new Error('Publish mode requires a fresh checkout without unpublished local commits');
  }
  const state = path.join(root, '資料轉換工具', '.state');
  await fs.mkdir(state, { recursive: true });
  const lockPath = path.join(state, 'data1-cloud.lock');
  const lock = await fs.open(lockPath, 'wx');
  let temporary;
  const report = { provider: 'Binance', dataset: 'data1', interval: '15m', startedAt: new Date().toISOString(), emptySymbols: [], fetchedSymbols: 0, fetchedBars: 0, published: false };
  try {
    // Read the symbol list once before contacting each contract; never change
    // the target expiry midway through a delayed job or a settlement boundary.
    const exchange = await api('/eapi/v1/exchangeInfo');
    if (!Array.isArray(exchange.optionSymbols)) throw new Error('Binance exchangeInfo has no optionSymbols');
    const serverNow = Number(exchange.serverTime);
    if (!Number.isSafeInteger(serverNow) || Math.abs(serverNow - Date.now()) > 600000) throw new Error('Binance server time differs from the runner clock');
    const expiry = process.env.REQUEST_EXPIRY || taipeiDay(serverNow);
    dateMs(expiry); report.expiry = expiry;
    const shortDate = expiry.replaceAll('-', '').slice(2);
    const symbols = exchange.optionSymbols.filter(item => item.underlying === 'BTCUSDT' && item.status === 'TRADING' && isoDay(Number(item.expiryDate)) === expiry);
    if (!symbols.length) throw new Error(`No listed BTC option contracts for ${expiry}. The job may have started after the 16:00 Taipei expiry; expired-contract recovery is not guaranteed.`);
    symbols.sort((a,b) => a.symbol.localeCompare(b.symbol));
    const startTime = dateMs(expiry) - 2 * DAY_MS - 28800000;
    const lines = [csv(['queryDate','timeZone','underlying','symbol','expiryDate','strikePrice','side','interval','openTimeUtc','openTimeLocal','open','high','low','close','volume','closeTimeUtc','closeTimeLocal','quoteVolume','numberOfTrades','takerBuyVolume','takerBuyQuoteVolume'])];
    const incoming = new Map();
    let formingBars = 0;
    for (const [index, meta] of symbols.entries()) {
      const pattern = new RegExp(`^BTC-${shortDate}-\\d+(?:\\.\\d+)?-[CP]$`);
      if (!pattern.test(meta.symbol) || !Number.isSafeInteger(Number(meta.expiryDate))) throw new Error('Invalid Binance option metadata');
      console.log(`[${index + 1}/${symbols.length}] ${meta.symbol}`);
      const endTime = Math.min(Date.now(), Number(meta.expiryDate) - 1);
      // Three local days have at most 288 fifteen-minute candles, below the
      // documented 1,500-row page limit. A truncated full page is an error.
      const page = await api('/eapi/v1/klines', { symbol: meta.symbol, interval: '15m', startTime, endTime, limit: 1500 });
      if (!Array.isArray(page) || page.length >= 1500) throw new Error('Unexpected/truncated Binance three-day Kline response');
      if (!page.length) report.emptySymbols.push(meta.symbol);
      for (const raw of page) {
        const bar = decodeKline(raw), [t, closeTime, open, high, low, close, volume, amount, trades, takerVolume, takerAmount] = bar;
        if (t < startTime || t > endTime) throw new Error('Binance returned a candle outside the requested time window');
        const key = `${meta.symbol}:${t}`;
        if (incoming.has(key)) throw new Error(`Duplicate source candle: ${key}`);
        incoming.set(key, bar);
        formingBars += closeTime > Date.now();
        lines.push(csv(['all-available', 'Asia/Taipei', 'BTCUSDT', meta.symbol, expiry, meta.strikePrice, meta.side, '15m', utcText(t), localText(t), raw[1], raw[2], raw[3], raw[4], raw[5], utcText(closeTime), localText(closeTime), raw[7], raw[8], raw[9], raw[10]]));
      }
      report.fetchedSymbols++;
      await pause(150);
    }
    if (!incoming.size) throw new Error('All symbols returned zero Klines; data1 will not be changed');
    report.fetchedBars = incoming.size;
    report.formingBars = formingBars;
    temporary = await fs.mkdtemp(path.join(state, 'data1-cloud-'));
    const source = path.join(temporary, '原始資料', '幣安成交');
    const stagedData = path.join(temporary, 'data1');
    await fs.mkdir(source, { recursive: true }); await fs.mkdir(stagedData);
    const rawName = `BTCUSDT_Options_all-available_15m_${expiry}_all_klines.csv`;
    await fs.writeFile(path.join(source, rawName), '\uFEFF' + lines.join('\r\n') + '\r\n');
    const targetName = `binance-${expiry}.json.gz`;
    const expected = new Map();
    try {
      const prior = await fs.readFile(path.join(root, 'data1', targetName));
      const old = JSON.parse(gunzipSync(prior));
      for (const [symbol, bars] of Object.entries(old.symbols)) for (const bar of bars) expected.set(`${symbol}:${bar[0]}`, bar);
      await fs.writeFile(path.join(stagedData, targetName), prior);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const [key, bar] of incoming) expected.set(key, bar);
    await fs.copyFile(path.join(root, 'data1', 'manifest.json'), path.join(stagedData, 'manifest.json'));
    const converted = spawnSync(process.execPath, [path.join(root, 'convert-binance-data1.cjs'), temporary], { cwd: root, windowsHide: true, stdio: 'inherit' });
    if (converted.error) throw converted.error;
    if (converted.status !== 0) throw new Error('data1 converter failed; nothing will be published');
    const bytes = await fs.readFile(path.join(stagedData, targetName));
    const manifest = JSON.parse(await fs.readFile(path.join(stagedData, 'manifest.json'), 'utf8'));
    const entry = manifest.files.find(item => item.path === targetName);
    if (!entry || entry.size !== bytes.length) throw new Error('Missing/incorrect data1 manifest entry');
    report.validatedBars = validateCompact(JSON.parse(gunzipSync(bytes)), entry, expected, expiry);
    // This is intentionally a pre-expiry snapshot, including any forming bar;
    // it must not be described as a complete 16:00 settlement-day archive.
    entry.capturedAt = new Date().toISOString();
    entry.captureStatus = 'scheduled-snapshot';
    entry.formingBarsAtCapture = formingBars;
    await fs.copyFile(path.join(stagedData, targetName), path.join(root, 'data1', targetName));
    await fs.writeFile(path.join(root, 'data1', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (publish) {
      const changed = allowedChanges();
      if (changed.length) {
        git(root, ['add', '--', ...changed], false);
        git(root, ['commit', '-m', `Update Binance BTC OP trade data1: ${expiry}`], false);
        git(root, ['fetch', 'origin', config.branch], false);
        try { git(root, ['rebase', `origin/${config.branch}`], false); }
        catch (error) { git(root, ['rebase', '--abort'], false); throw error; }
        git(root, ['push', 'origin', `HEAD:refs/heads/${config.branch}`], false);
        report.published = true; report.commit = git(root, ['rev-parse', 'HEAD']).trim();
      }
    }
    report.status = report.emptySymbols.length ? 'complete-with-empty-symbols' : 'complete';
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(state, 'last-data1-cloud-run.json'), JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Binance OP data1\n\n- Expiry: ${expiry}\n- Requested symbols: ${symbols.length}\n- Captured 15m bars: ${report.fetchedBars}\n- Empty symbols: ${report.emptySymbols.join(', ') || 'none'}\n- Forming bars at capture: ${formingBars}\n- Git push: ${report.published ? report.commit : 'not pushed'}\n- Bybit data: unchanged\n- Raw CSV: temporary cloud disk only; not in Git or R2\n`);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.status = 'failed'; report.error = error.message;
    await fs.writeFile(path.join(state, 'last-data1-cloud-run.json'), JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Binance OP data1 failed\n\n${error.message}\n\nNo failed fetch is reported as a successful data upload.\n`);
    throw error;
  } finally {
    try {
      if (temporary) {
        const resolved = path.resolve(temporary);
        if (!resolved.startsWith(path.resolve(state) + path.sep) || !path.basename(resolved).startsWith('data1-cloud-')) throw new Error('Unsafe temporary directory cleanup');
        await fs.rm(resolved, { recursive: true, force: true });
      }
    } finally {
      await lock.close(); await fs.unlink(lockPath);
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
