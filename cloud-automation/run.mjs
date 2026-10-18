import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS, isoDay, dateMs, planDates, downloadArchive } from './archives.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.dirname(here);

function command(program, args, cwd, { capture = false } = {}) {
  const result = spawnSync(program, args, { cwd, windowsHide: true, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(program)} ${args[0]} failed (${result.status})${capture ? ': ' + result.stderr.trim() : ''}`);
  return capture ? result.stdout : '';
}

export function git(root, args, capture = true) {
  return command('git', ['-c', `safe.directory=${root}`, ...args], root, { capture });
}
export function checkRemote(root, config) {
  const remote = git(root, ['remote', 'get-url', '--push', 'origin']).trim().replace(/\.git$/, '');
  if (![ `https://github.com/${config.repository}`, `git@github.com:${config.repository}` ].includes(remote)) throw new Error('origin does not match configured repository');
  if (git(root, ['branch', '--show-current']).trim() !== config.branch) throw new Error(`Expected branch ${config.branch}`);
}
export function requireClean(root) {
  if (git(root, ['status', '--porcelain', '--untracked-files=all']).trim()) throw new Error('Working tree must be clean before automatic publishing');
}

async function snapshotData(root) {
  const files = new Map();
  for (const name of await fs.readdir(path.join(root, 'data'))) {
    if (/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(name) || name === 'manifest.json') {
      const bytes = await fs.readFile(path.join(root, 'data', name));
      files.set(name, createHash('sha256').update(bytes).digest('hex'));
    }
  }
  return files;
}

export async function validateData(root, names) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
  const paths = new Set(), dates = new Set();
  let totalBytes = 0, totalBars = 0, checkedBars = 0;
  for (const entry of manifest.files) {
    if (!/^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(entry.path) || entry.path !== `${entry.date}.json.gz` || paths.has(entry.path) || dates.has(entry.date)) throw new Error('Invalid/duplicate manifest dataset');
    paths.add(entry.path); dates.add(entry.date);
    const file = path.join(root, 'data', entry.path);
    const size = (await fs.stat(file)).size;
    if (size !== entry.size) throw new Error(`Manifest size differs: ${entry.path}`);
    totalBytes += size; totalBars += entry.barCount;
    if (!names.has(entry.path)) continue;
    const payload = JSON.parse(gunzipSync(await fs.readFile(file)));
    if (payload.expiry !== entry.date || payload.interval !== '1h' || JSON.stringify(payload.fields) !== JSON.stringify(['timeUtcMs', 'closeTimeUtcMs', 'open', 'high', 'low', 'close'])) throw new Error('Unexpected dataset schema');
    const days = new Set(); let bars = 0;
    for (const [symbol, values] of Object.entries(payload.symbols)) {
      const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-[CP]-USDT$/.exec(symbol);
      if (!m) throw new Error('Invalid option symbol');
      const month = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'].indexOf(m[2]);
      if (isoDay(Date.UTC(2000 + Number(m[3]), month, Number(m[1]))) !== entry.date) throw new Error('Wrong expiry in dataset');
      let previous = -Infinity;
      for (const row of values) {
        if (row.length !== 6 || !row.every(Number.isFinite)) throw new Error('Malformed compact bar');
        const [t, closeTime, open, high, low, close] = row;
        if (!Number.isSafeInteger(t) || t <= previous || t % 3600000 || closeTime < t || closeTime >= t + 3600000) throw new Error('Duplicate/invalid candle timestamp');
        if (low < 0 || high < Math.max(open, low, close) || low > Math.min(open, high, close)) throw new Error('Invalid OHLC');
        const day = isoDay(t), delta = (dateMs(entry.date) - dateMs(day)) / DAY_MS;
        if (![0,1,2].includes(delta)) throw new Error('Candle outside last three source days');
        days.add(day); previous = t; bars++;
      }
    }
    const missing = [-2,-1,0].map(d => isoDay(dateMs(entry.date) + d * DAY_MS)).filter(d => !days.has(d));
    if (bars !== entry.barCount || Object.keys(payload.symbols).length !== entry.symbolCount || days.size !== entry.sourceDays || JSON.stringify(missing) !== JSON.stringify(entry.missingDates)) throw new Error(`Manifest counts differ: ${entry.path}`);
    checkedBars += bars;
  }
  if (totalBytes !== manifest.totalBytes || totalBars !== manifest.totalBars) throw new Error('Manifest totals differ');
  return { checkedBars, totalBars, totalBytes, totalFiles: paths.size };
}

export function changedDataPaths(root) {
  const output = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = output.split('\0').filter(Boolean).map(record => {
    const name = record.slice(3);
    if (/^[RC]/.test(record.slice(0,2).trim()) || !/^data\/(?:manifest\.json|\d{4}-\d{2}-\d{2}\.json\.gz)$/.test(name) || record.slice(0,2).includes('D')) throw new Error(`Unexpected changed path; will not publish: ${name}`);
    return name;
  });
  return paths;
}

export async function runPipeline({ root = projectRoot, options = {}, fetchImpl = fetch, log = console.log } = {}) {
  root = path.resolve(root);
  const config = JSON.parse(await fs.readFile(path.join(root, 'cloud-automation', 'config.json'), 'utf8'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !/^[\w/-]+$/.test(config.branch) || !Number.isInteger(config.maxDaysPerRun) || config.maxDaysPerRun < 1 || config.maxDaysPerRun > 31) throw new Error('Invalid automation configuration');
  if (options.publish) {
    checkRemote(root, config); requireClean(root);
    git(root, ['fetch', 'origin', config.branch], false);
    git(root, ['merge', '--ff-only', `origin/${config.branch}`], false);
    if (git(root, ['rev-parse', 'HEAD']).trim() !== git(root, ['rev-parse', `origin/${config.branch}`]).trim()) throw new Error('Unpublished local commits exist; publish mode requires a fresh remote checkout');
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
  const dates = planDates(manifest, config, options);
  const report = { startedAt: new Date().toISOString(), plannedDates: dates, downloaded: [], pendingDates: [], changedFiles: [], published: false };
  const state = path.join(root, '資料轉換工具', '.state');
  await fs.mkdir(state, { recursive: true });
  const lockPath = path.join(state, 'cloud-run.lock');
  const lock = await fs.open(lockPath, 'wx').catch(error => { throw new Error(`Another pipeline may be running: ${error.code}`); });
  let temporary;
  try {
    log(`UTC source dates: ${dates.join(', ') || '(no missing dates)'}`);
    if (dates.length) {
      temporary = await fs.mkdtemp(path.join(state, 'cloud-zips-'));
      // All archives pass CRC before the converter can touch compact data.
      for (const day of dates) {
        try {
          log(`Downloading official BTC option ZIP: ${day}`);
          const info = await downloadArchive(day, temporary, { fetchImpl });
          const { path: unused, ...receipt } = info;
          report.downloaded.push(receipt);
        } catch (error) {
          if (error.status !== 404) throw error;
          report.pendingDates.push(day);
          log(`Not published by Bybit yet (HTTP 404): ${day}`);
        }
      }
      if (report.downloaded.length) {
        const before = await snapshotData(root);
        command(process.execPath, [path.join(root, '資料轉換工具', 'convert.js'), '--input', temporary, '--force'], root);
        const after = await snapshotData(root);
        for (const name of before.keys()) if (!after.has(name)) throw new Error(`Converter deleted existing data: ${name}`);
        const changed = new Set([...after.keys()].filter(name => after.get(name) !== before.get(name)));
        report.validation = await validateData(root, changed);
        report.changedFiles = [...changed].map(name => `data/${name}`).sort();
        if (options.publish) {
          const paths = changedDataPaths(root);
          if (paths.length) {
            git(root, ['add', '--', ...paths], false);
            git(root, ['commit', '-m', `Update BTC option mark data: ${report.downloaded.map(x => x.date).join(', ')}`], false);
            git(root, ['fetch', 'origin', config.branch], false);
            try { git(root, ['rebase', `origin/${config.branch}`], false); }
            catch (error) { git(root, ['rebase', '--abort'], false); throw error; }
            // Regular fast-forward push only; never force push.
            git(root, ['push', 'origin', `HEAD:refs/heads/${config.branch}`], false);
            report.commit = git(root, ['rev-parse', 'HEAD']).trim();
            report.published = true;
          }
        }
      }
    }
    report.status = report.pendingDates.length ? 'waiting-for-bybit' : 'complete';
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(state, 'last-cloud-run.json'), JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## BTC OP data update\n\n- Downloaded: ${report.downloaded.map(x => x.date).join(', ') || 'none'}\n- Waiting for Bybit: ${report.pendingDates.join(', ') || 'none'}\n- Changed compact files: ${report.changedFiles.length}\n- Git push: ${report.published ? report.commit : 'no changes pushed'}\n- data1: excluded\n- Raw ZIPs: temporary runner disk only; no R2\n`);
    }
    return report;
  } finally {
    if (temporary) {
      const resolved = path.resolve(temporary);
      if (!resolved.startsWith(path.resolve(state) + path.sep) || !path.basename(resolved).startsWith('cloud-zips-')) throw new Error('Refusing unsafe temporary-directory cleanup');
      await fs.rm(resolved, { recursive: true, force: true });
    }
    await lock.close();
    await fs.unlink(lockPath);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--publish' || arg === '--refresh') options[arg.slice(2)] = true;
    else if (['--start', '--end'].includes(arg) && argv[i+1] && !argv[i+1].startsWith('--')) options[arg.slice(2)] = argv[++i];
    else throw new Error('Usage: node cloud-automation/run.mjs [--start YYYY-MM-DD --end YYYY-MM-DD] [--refresh] [--publish]');
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPipeline({ options: parseArgs(process.argv.slice(2)) }).then(report => console.log(JSON.stringify(report,null,2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
