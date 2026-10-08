'use strict';
// Node.js built-ins only. Raw archives never belong in the published site.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const dataDir = path.join(root, 'data');
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const force = args.includes('--force');
const inputAt = args.indexOf('--input');
if (inputAt >= 0 && !args[inputAt + 1]) throw Error('--input 必須指定資料夾');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const input = inputAt >= 0 ? path.resolve(args[inputAt + 1]) : path.resolve(__dirname, config.sourceDirectory);
const stateDir = path.join(__dirname, '.state');
const statePath = path.join(stateDir, 'processed.json');
const dayMs = 86400000;
const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const atomic = (file, bytes) => {
  const temporary = file + '.tmp-' + process.pid;
  try { fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
};
function archives(dir) {
  const result = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...archives(file));
    else if (item.isFile() && /^\d{4}-\d{2}-\d{2}_BTC_USDT\.OHLC\.csv\.zip$/i.test(item.name)) result.push(file);
  }
  return result.sort();
}
function unzip(zip) {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
  }
  if (end < 0) throw Error('ZIP 尚未複製完成或格式不完整');
  let cursor = zip.readUInt32LE(end + 16);
  let csv;
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw Error('ZIP 目錄格式錯誤');
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10);
    const size = zip.readUInt32LE(cursor + 20), rawSize = zip.readUInt32LE(cursor + 24);
    const nameSize = zip.readUInt16LE(cursor + 28), extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameSize);
    if (/\.csv$/i.test(name)) {
      if (csv !== undefined) throw Error('每個 ZIP 必須只有一個 CSV');
      if (flags & 1 || ![0, 8].includes(method)) throw Error('不支援加密或此壓縮方式');
      if (zip.readUInt32LE(offset) !== 0x04034b50) throw Error('ZIP 檔案標頭錯誤');
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
      const packed = zip.subarray(start, start + size);
      const raw = method === 8 ? zlib.inflateRawSync(packed) : packed;
      if (raw.length !== rawSize) throw Error('CSV 解壓縮長度不符');
      csv = raw.toString('utf8');
    }
    cursor += 46 + nameSize + extra + comment;
  }
  if (csv === undefined) throw Error('ZIP 沒有 CSV');
  return csv;
}
function aggregate(text, sourceDay, targets) {
  const end = text.indexOf('\n');
  if (end < 0) throw Error('CSV 沒有資料列');
  const header = text.slice(0, end).replace(/^\uFEFF/, '').trim().split(',');
  const indexes = ['instrument_name','open_time','open','high','low','close'].map(name => {
    const index = header.indexOf(name);
    if (index < 0) throw Error('CSV 缺少欄位：' + name);
    return index;
  });
  const result = new Map(targets.map(date => [date, new Map()]));
  const dayStart = Date.parse(sourceDay + 'T00:00:00Z');
  let relevant = 0;
  for (let start = end + 1; start < text.length;) {
    let stop = text.indexOf('\n', start); if (stop < 0) stop = text.length;
    const line = text.slice(start, stop).trim(); start = stop + 1;
    if (!line) continue;
    const cells = line.split(',');
    const match = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])-USDT$/.exec(cells[indexes[0]]);
    if (!match) continue;
    const month = months.indexOf(match[2]);
    if (month < 0) throw Error('無效合約月份');
    const expiry = iso(Date.UTC(2000 + Number(match[3]), month, Number(match[1])));
    if (!result.has(expiry)) continue;
    const values = indexes.slice(1).map(index => Number(cells[index]));
    if (indexes.some(index => !cells[index]?.trim()) || !values.every(Number.isFinite)) throw Error('CSV 有無效價格或時間');
    const [time, open, high, low, close] = values;
    if (time < dayStart || time >= dayStart + dayMs) throw Error('CSV 時間不符合 ZIP 檔名日期：' + sourceDay);
    if (high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw Error('CSV 開高低收不合理');
    const symbol = Buffer.from(cells[indexes[0]]).toString('utf8');
    const symbols = result.get(expiry);
    if (!symbols.has(symbol)) symbols.set(symbol, new Map());
    const hours = symbols.get(symbol), bucket = Math.floor(time / 3600000) * 3600000;
    let bar = hours.get(bucket);
    if (!bar) { bar = { row: [bucket, time + 59999, open, high, low, close], first: time, last: time }; hours.set(bucket, bar); }
    else {
      bar.row[3] = Math.max(bar.row[3], high); bar.row[4] = Math.min(bar.row[4], low);
      if (time < bar.first) { bar.first = time; bar.row[2] = open; }
      if (time >= bar.last) { bar.last = time; bar.row[1] = time + 59999; bar.row[5] = close; }
    }
    relevant++;
  }
  if (!relevant) throw Error('CSV 沒有到期日當天至前兩天範圍內的 BTC 期權資料');
  return result;
}
function convert(file, state) {
  const sourceDay = path.basename(file).slice(0, 10);
  const dayStart = Date.parse(sourceDay + 'T00:00:00Z');
  if (!Number.isFinite(dayStart) || iso(dayStart) !== sourceDay) throw Error('檔名日期無效');
  const before = fs.statSync(file), zip = fs.readFileSync(file), after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error('檔案仍在複製，稍後重試');
  const hash = crypto.createHash('sha256').update(zip).digest('hex');
  if (!force && state[sourceDay]?.sha256 === hash) return false;
  const targets = [0, 1, 2].map(offset => iso(dayStart + offset * dayMs));
  const incoming = aggregate(unzip(zip), sourceDay, targets);
  const manifestPath = path.join(dataDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const updates = [];
  const now = new Date().toISOString();
  for (const expiry of targets) {
    const name = expiry + '.json.gz', output = path.join(dataDir, name);
    const existing = fs.existsSync(output) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(output))) : { version: 1, expiry, interval: '1h', fields: ['timeUtcMs','closeTimeUtcMs','open','high','low','close'], symbols: {} };
    for (const [symbol, bars] of Object.entries(existing.symbols)) {
      const kept = bars.filter(bar => bar[0] < dayStart || bar[0] >= dayStart + dayMs);
      if (kept.length) existing.symbols[symbol] = kept; else delete existing.symbols[symbol];
    }
    for (const [symbol, hours] of incoming.get(expiry)) {
      existing.symbols[symbol] = [...(existing.symbols[symbol] || []), ...Array.from(hours.values(), bar => bar.row)].sort((a, b) => a[0] - b[0]);
    }
    const days = new Set(), symbols = Object.keys(existing.symbols).sort();
    if (!symbols.length && !fs.existsSync(output)) continue;
    existing.symbols = Object.fromEntries(symbols.map(symbol => [symbol, existing.symbols[symbol]]));
    let barCount = 0;
    for (const bars of Object.values(existing.symbols)) { barCount += bars.length; for (const bar of bars) days.add(iso(bar[0])); }
    const dates = [...days].sort(), expiryMs = Date.parse(expiry + 'T00:00:00Z');
    const missingDates = [-2, -1, 0].map(offset => iso(expiryMs + offset * dayMs)).filter(date => !days.has(date));
    const bytes = zlib.gzipSync(JSON.stringify(existing), { level: 9 });
    const entry = { name: expiry, path: name, date: expiry, interval: '1h', size: bytes.length, modifiedAt: now, sourceDays: days.size, firstDate: dates[0] || null, lastDate: dates.at(-1) || null, missingDates, barCount, symbolCount: symbols.length, volumeAvailable: false };
    manifest.files = manifest.files.filter(item => item.date !== expiry); manifest.files.push(entry);
    updates.push({ output, bytes });
  }
  manifest.files.sort((a, b) => b.date.localeCompare(a.date));
  manifest.generatedAt = now;
  manifest.totalBars = manifest.files.reduce((sum, item) => sum + item.barCount, 0);
  manifest.totalBytes = manifest.files.reduce((sum, item) => sum + item.size, 0);
  const knownDays = new Set();
  for (const item of manifest.files) {
    const expiryMs = Date.parse(item.date + 'T00:00:00Z');
    for (const offset of [-2, -1, 0]) { const date = iso(expiryMs + offset * dayMs); if (!item.missingDates.includes(date)) knownDays.add(date); }
  }
  manifest.sourceFiles = knownDays.size;
  // Prepare every output before replacing existing files. Failed parsing leaves data unchanged.
  for (const update of updates) atomic(update.output, update.bytes);
  atomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  state[sourceDay] = { sha256: hash, size: after.size, mtimeMs: after.mtimeMs, convertedAt: now };
  atomic(statePath, JSON.stringify(state, null, 2) + '\n');
  console.log(sourceDay + ' 已更新：' + updates.map(item => path.basename(item.output, '.json.gz')).join('、'));
  return true;
}
if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) throw Error('原始資料夾不存在，請修改 config.json 的 sourceDirectory：' + input);
fs.mkdirSync(stateDir, { recursive: true });
const lock = path.join(stateDir, 'convert.lock');
if (fs.existsSync(lock)) {
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let running = true;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; }
  if (running) throw Error('已有轉換程式執行中；請先關閉另一個轉換視窗');
  fs.unlinkSync(lock);
}
fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
process.on('exit', () => { try { fs.unlinkSync(lock); } catch {} });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
// Existing bundled data is the baseline: never unpack historical archives
// merely because this computer has no local processed.json yet.
const baseline = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
const coveredDays = new Set();
for (const entry of baseline.files) {
  const expiryMs = Date.parse(entry.date + 'T00:00:00Z');
  for (const offset of [-2, -1, 0]) {
    const date = iso(expiryMs + offset * dayMs);
    if (!(entry.missingDates || []).includes(date)) coveredDays.add(date);
  }
}
const observations = new Map(), completed = new Map();
function scan() {
  let count = 0, failed = false;
  const files = archives(input), dates = new Set();
  for (const file of files) {
    const date = path.basename(file).slice(0, 10);
    if (dates.has(date)) throw Error('同一日期出現多個 ZIP，請只保留一份：' + date);
    dates.add(date);
  }
  for (const file of files) {
    const date = path.basename(file).slice(0, 10);
    const stat = fs.statSync(file), signature = stat.size + ':' + stat.mtimeMs;

    const previous = state[date];
    if (!force) {
      // No readFile, hashing or decompression for an unchanged historical ZIP.
      if (previous?.sha256 && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      // Baseline archives without a local fingerprint are already published.
      // Use --force to deliberately replace one of these historical days.
      if (!previous && coveredDays.has(date)) continue;
    }
    if (watch) {
      if (observations.get(file) !== signature) { observations.set(file, signature); continue; }
      if (completed.get(file) === signature) continue;
      if (Date.now() - stat.mtimeMs < 10000) continue;
    }
    try { if (convert(file, state)) count++; completed.set(file, signature); }
    catch (error) { console.error(path.basename(file) + '：' + error.message); failed = true; }
  }
  if (!watch) { console.log('完成，更新 ' + count + ' 個 ZIP；未變更的 ZIP 自動略過。'); if (failed) process.exitCode = 1; }
}
console.log('輸入資料夾：' + input);
console.log('既有精簡資料已涵蓋 ' + coveredDays.size + ' 個原始日期；只轉換新增、缺日補檔或已記錄後修改的 ZIP。');
if (watch) {
  console.log('每 10 秒檢查新資料，檔案穩定後轉換。按 Ctrl+C 停止；不會自動上傳 Git。');
  const safeScan = () => { try { scan(); } catch (error) { console.error(error.message); } };
  safeScan(); setInterval(safeScan, 10000);
} else scan();
