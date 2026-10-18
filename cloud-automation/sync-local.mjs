import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { coveredSourceDates, dateMs, downloadArchive } from './archives.mjs';
import { checkRemote, git, requireClean } from './run.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--pull')) throw new Error('Usage: node cloud-automation/sync-local.mjs [--pull]');
  const config = JSON.parse(await fs.readFile(path.join(root, 'cloud-automation', 'config.json'), 'utf8'));
  if (args.includes('--pull')) {
    checkRemote(root, config); requireClean(root);
    git(root, ['fetch', 'origin', config.branch], false);
    git(root, ['merge', '--ff-only', `origin/${config.branch}`], false);
  }
  const localConfig = JSON.parse(await fs.readFile(path.join(root, '資料轉換工具', 'config.json'), 'utf8'));
  const rawRoot = path.resolve(root, '資料轉換工具', localConfig.sourceDirectory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'data', 'manifest.json'), 'utf8'));
  const dates = [...coveredSourceDates(manifest)].filter(day => day >= config.firstSourceDate).sort();
  let downloaded = 0, existed = 0;
  const pending = [];
  for (const day of dates) {
    dateMs(day);
    const year = Number(day.slice(0,4)), month = Number(day.slice(5,7));
    const directory = year === config.localBaseYear ? path.join(rawRoot, `${month}月`) : path.join(rawRoot, `${year}年`, `${month}月`);
    try {
      const info = await downloadArchive(day, directory);
      if (info.reused) existed++; else downloaded++;
      console.log(`${info.reused ? 'Verified existing ZIP' : 'Saved official ZIP'}: ${info.path}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      pending.push(day);
    }
  }
  console.log(JSON.stringify({ downloaded, existed, pending, output: rawRoot, data1: 'untouched' }, null, 2));
  if (pending.length) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
