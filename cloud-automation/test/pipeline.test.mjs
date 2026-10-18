import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib';
import { archiveName, archiveURL, downloadArchive, verifyArchive, planDates } from '../archives.mjs';
import { runPipeline, git, changedDataPaths, checkRemote, requireClean } from '../run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = { repository: 'optiona286/btc-options-klines', branch: 'main', firstSourceDate: '2026-10-17', maxDaysPerRun: 7 };

function makeZip(day, csv) {
  const name = Buffer.from(archiveName(day).slice(0, -4));
  const raw = Buffer.from(csv), packed = deflateRawSync(raw), crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + packed.length, 16);
  return Buffer.concat([local, name, packed, central, name, end]);
}

function csvFor(day, invalid = false) {
  const start = Date.parse(day), date = Number(day.slice(-2));
  const header = 'instrument_name,open_time,open,high,low,close,delta,gama,vega,theta\n';
  // Deliberately out of order, and with an absent minute. No fake minute should appear.
  const rows = [
    `BTC-${date}OCT26-80000-C-USDT,${start + 120000},13,15,12,14,0,0,0,0`,
    `BTC-${date}OCT26-80000-C-USDT,${start},10,${invalid ? 5 : 14},9,13,0,0,0,0`,
    `BTC-${date + 1}OCT26-80000-P-USDT,${start},20,23,19,22,0,0,0,0`,
    `BTC-${date + 2}OCT26-80000-C-USDT,${start},30,34,29,32,0,0,0,0`,
    // Far expiry is deliberately omitted by this project's three-day policy.
    `BTC-24SEP27-170000-C-USDT,${start},900,901,899,900,0,0,0,0`,
  ];
  return header + rows.join('\n') + '\n';
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'btc-op-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'cloud-automation'), { recursive: true });
  await fs.mkdir(path.join(dir, '資料轉換工具'));
  await fs.mkdir(path.join(dir, 'data'));
  await fs.mkdir(path.join(dir, 'data1'));
  await fs.writeFile(path.join(dir, 'data1', 'untouched.txt'), 'data1 must stay exactly the same');
  await fs.writeFile(path.join(dir, 'cloud-automation', 'config.json'), JSON.stringify(config));
  await fs.copyFile(path.join(root, '資料轉換工具', 'convert.js'), path.join(dir, '資料轉換工具', 'convert.js'));
  await fs.writeFile(path.join(dir, '資料轉換工具', 'config.json'), JSON.stringify({ sourceDirectory: '.' }));
  await fs.writeFile(path.join(dir, 'data', 'manifest.json'), JSON.stringify({ version: 1, files: [], sourceFiles: 0, totalBars: 0, totalBytes: 0 }));
  return dir;
}

test('plan catches up missing UTC source days and respects publication boundary/batch limit', () => {
  const manifest = { files: [{ date: '2026-10-19', firstDate: '2026-10-17', lastDate: '2026-10-17', missingDates: ['2026-10-18', '2026-10-19'] }] };
  assert.deepEqual(planDates(manifest, { ...config, maxDaysPerRun: 2 }, { now: Date.parse('2026-10-21T12:00:00Z') }), ['2026-10-18', '2026-10-19']);
  assert.throws(() => planDates(manifest, config, { start: '2026-10-17' }), /both/);
  assert.throws(() => planDates(manifest, config, { start: '2026-02-30', end: '2026-10-18' }), /Invalid UTC/);
  assert.throws(() => planDates(manifest, config, { start: '2026-10-17', end: '2026-10-22', now: Date.parse('2026-10-21') }), /today/);
});

test('download preserves official bytes, verifies CRC, and reuses a valid file without HTTP', async t => {
  const dir = await fixture(t), bytes = makeZip('2026-10-17', csvFor('2026-10-17'));
  let calls = 0;
  const fetchImpl = async url => { calls++; assert.equal(url, archiveURL('2026-10-17')); return new Response(bytes, { headers: { 'content-length': String(bytes.length) } }); };
  const first = await downloadArchive('2026-10-17', dir, { fetchImpl });
  assert.equal(first.crcVerified, true);
  assert.deepEqual(await fs.readFile(first.path), bytes);
  const second = await downloadArchive('2026-10-17', dir, { fetchImpl });
  assert.equal(second.reused, true); assert.equal(calls, 1);
  const damaged = Buffer.from(bytes), centralOffset = damaged.readUInt32LE(damaged.length - 6);
  damaged.writeUInt32LE((damaged.readUInt32LE(centralOffset + 16) ^ 1) >>> 0, centralOffset + 16);
  await fs.writeFile(first.path, damaged);
  await assert.rejects(verifyArchive(first.path, '2026-10-17'), /CRC/);
});

test('HTML masquerading as ZIP is rejected and never promoted to the final file', async t => {
  const dir = await fixture(t);
  await assert.rejects(downloadArchive('2026-10-17', dir, { fetchImpl: async () => new Response('<html>Access denied</html>'), attempts: 1 }), /ZIP/);
  await assert.rejects(fs.access(path.join(dir, archiveName('2026-10-17'))));
  assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.part')), false);
});

test('full download/conversion/validation preserves data1 and repeat run is a no-op', async t => {
  const dir = await fixture(t), bytes = makeZip('2026-10-17', csvFor('2026-10-17'));
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(bytes); };
  const report = await runPipeline({ root: dir, options: { now: Date.parse('2026-10-18T12:00:00Z') }, fetchImpl, log() {} });
  assert.equal(report.status, 'complete'); assert.equal(report.downloaded.length, 1);
  assert.equal(report.validation.checkedBars, 3);
  const payload = JSON.parse(gunzipSync(await fs.readFile(path.join(dir, 'data', '2026-10-17.json.gz'))));
  assert.deepEqual(payload.symbols['BTC-17OCT26-80000-C-USDT'], [[Date.parse('2026-10-17'), Date.parse('2026-10-17') + 179999, 10, 15, 9, 14]]);
  assert.equal(Object.keys(payload.symbols).length, 1);
  assert.equal(await fs.readFile(path.join(dir, 'data1', 'untouched.txt'), 'utf8'), 'data1 must stay exactly the same');
  const manifestBefore = await fs.readFile(path.join(dir, 'data', 'manifest.json'));
  const repeat = await runPipeline({ root: dir, options: { now: Date.parse('2026-10-18T12:00:00Z') }, fetchImpl, log() {} });
  assert.equal(calls, 1); assert.deepEqual(repeat.changedFiles, []);
  assert.deepEqual(await fs.readFile(path.join(dir, 'data', 'manifest.json')), manifestBefore);
  assert.equal((await fs.readdir(path.join(dir, '資料轉換工具', '.state'))).some(name => name.startsWith('cloud-zips-') || name.endsWith('.lock')), false);
});

test('404 publication lag is retained as pending while available days still convert', async t => {
  const dir = await fixture(t);
  const report = await runPipeline({ root: dir, options: { now: Date.parse('2026-10-19T12:00:00Z') }, fetchImpl: async url => url.includes('2026-10-17') ? new Response('', { status: 404 }) : new Response(makeZip('2026-10-18', csvFor('2026-10-18'))), log() {} });
  assert.deepEqual(report.pendingDates, ['2026-10-17']); assert.equal(report.status, 'waiting-for-bybit');
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'data', 'manifest.json')));
  assert.deepEqual(planDates(manifest, config, { now: Date.parse('2026-10-19T12:00:00Z') }), ['2026-10-17']);
});

test('transient network errors retry, but 403 fails before touching compact data', async t => {
  const dir = await fixture(t), bytes = makeZip('2026-10-17', csvFor('2026-10-17'));
  let calls = 0;
  await downloadArchive('2026-10-17', dir, { fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response(bytes), retryDelayMs: 0 });
  assert.equal(calls, 2);
  const before = await fs.readFile(path.join(dir, 'data', 'manifest.json'));
  await assert.rejects(runPipeline({ root: dir, options: { now: Date.parse('2026-10-18') }, fetchImpl: async () => new Response('', { status: 403 }), log() {} }), /403/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'data', 'manifest.json')), before);
});

test('invalid OHLC is rejected before any compact dataset is replaced', async t => {
  const dir = await fixture(t), before = await fs.readFile(path.join(dir, 'data', 'manifest.json'));
  await assert.rejects(runPipeline({ root: dir, options: { now: Date.parse('2026-10-18') }, fetchImpl: async () => new Response(makeZip('2026-10-17', csvFor('2026-10-17', true))), log() {} }), /failed/);
  assert.deepEqual(await fs.readFile(path.join(dir, 'data', 'manifest.json')), before);
});

test('publishing guards reject data1 changes, dirty worktrees, and a wrong remote', async t => {
  const dir = await fixture(t);
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'Pipeline Test']); git(dir, ['config', 'user.email', 'pipeline@example.invalid']);
  git(dir, ['add', '.']); git(dir, ['commit', '-m', 'fixture']);
  git(dir, ['remote', 'add', 'origin', 'https://github.com/optiona286/btc-options-klines.git']);
  checkRemote(dir, config); requireClean(dir);
  await fs.writeFile(path.join(dir, 'data1', 'untouched.txt'), 'changed');
  assert.throws(() => changedDataPaths(dir), /Unexpected changed path/);
  assert.throws(() => requireClean(dir), /clean/);
  git(dir, ['remote', 'set-url', 'origin', 'https://github.com/another/repository.git']);
  assert.throws(() => checkRemote(dir, config), /origin/);
});
