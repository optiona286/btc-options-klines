import fs from 'node:fs/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, inflateRawSync } from 'node:zlib';
import path from 'node:path';

export const DAY_MS = 86400000;
export const isoDay = value => new Date(value).toISOString().slice(0, 10);
export function dateMs(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || isoDay(Date.parse(value)) !== value) {
    throw new Error(`Invalid UTC date: ${value}`);
  }
  return Date.parse(value);
}
export const archiveName = day => `${day}_BTC_USDT.OHLC.csv.zip`;
export function archiveURL(day) {
  dateMs(day);
  return `https://public.bybit.com/mark_kline/option/BTC/${archiveName(day)}`;
}
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Validate the actual uncompressed CSV and its CRC, not just the .zip extension.
// GitHub Actions has normal machine memory; this work does not run in a Worker.
export async function verifyArchive(file, day) {
  dateMs(day);
  const size = (await fs.stat(file)).size;
  if (size < 22 || size > 256 * 1024 * 1024) throw new Error('ZIP size outside supported limits');
  const bytes = await fs.readFile(file);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Incomplete ZIP');
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== 1 || bytes.readUInt16LE(end + 10) !== 1) {
    throw new Error('Expected one CSV in a single-disk ZIP');
  }
  const directorySize = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (directorySize < 46 || offset + directorySize !== end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory');
  const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
  const expectedCRC = bytes.readUInt32LE(offset + 16), packedSize = bytes.readUInt32LE(offset + 20), rawSize = bytes.readUInt32LE(offset + 24);
  const nameSize = bytes.readUInt16LE(offset + 28), localOffset = bytes.readUInt32LE(offset + 42);
  const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize);
  if (name !== archiveName(day).slice(0, -4) || flags & 1 || ![0, 8].includes(method)) throw new Error('Unexpected ZIP CSV, compression, or encryption');
  if (rawSize > 512 * 1024 * 1024 || localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP payload');
  const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
  if (start + packedSize > offset) throw new Error('Truncated compressed data');
  const packed = bytes.subarray(start, start + packedSize);
  const raw = method === 8 ? inflateRawSync(packed, { maxOutputLength: 512 * 1024 * 1024 }) : packed;
  if (raw.length !== rawSize || crc32(raw) !== expectedCRC) throw new Error('ZIP CRC or decompressed length mismatch');
  const header = raw.subarray(0, Math.min(raw.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0].split(',');
  if (!['instrument_name', 'open_time', 'open', 'high', 'low', 'close'].every(key => header.includes(key))) throw new Error('Unexpected Mark Price CSV header');
  return { bytes: size, csvBytes: rawSize, csvName: name, sha256: createHash('sha256').update(bytes).digest('hex'), crcVerified: true };
}

export async function downloadArchive(day, directory, { fetchImpl = fetch, attempts = 3, retryDelayMs = 1000 } = {}) {
  dateMs(day);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, archiveName(day));
  try {
    await fs.access(target);
    return { date: day, path: target, reused: true, ...await verifyArchive(target, day) };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${target}.${process.pid}.part`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(archiveURL(day), { signal: AbortSignal.timeout(300000) });
      if (!response.ok) {
        const error = new Error(`Bybit ${day}: HTTP ${response.status}`);
        error.status = response.status;
        error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
      }
      if (!response.body) throw new Error('Empty response body');
      let downloaded = 0;
      const limit = new Transform({ transform(chunk, encoding, done) {
        downloaded += chunk.length;
        done(downloaded > 256 * 1024 * 1024 ? new Error('ZIP download exceeded size limit') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial, { flags: 'wx' }));
      const length = response.headers.get('content-length');
      if (length && !response.headers.get('content-encoding') && Number(length) !== downloaded) throw new Error('HTTP Content-Length mismatch');
      const info = await verifyArchive(partial, day);
      await fs.copyFile(partial, target, constants.COPYFILE_EXCL);
      await fs.unlink(partial);
      return { date: day, path: target, url: archiveURL(day), reused: false, ...info };
    } catch (error) {
      await fs.rm(partial, { force: true });
      if (error.permanent || error.code === 'EEXIST' || attempt === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** attempt));
    }
  }
}

// Only source dates actually reported by expiry datasets count as covered.
export function coveredSourceDates(manifest) {
  const covered = new Set();
  for (const entry of manifest.files) {
    const expiry = dateMs(entry.date);
    for (const offset of [-2, -1, 0]) {
      const day = isoDay(expiry + offset * DAY_MS);
      if (entry.firstDate && day < entry.firstDate || entry.lastDate && day > entry.lastDate) continue;
      if (!(entry.missingDates || []).includes(day)) covered.add(day);
    }
  }
  return covered;
}

export function planDates(manifest, config, { start, end, refresh = false, now = Date.now() } = {}) {
  if (Boolean(start) !== Boolean(end)) throw new Error('Specify both --start and --end');
  const today = dateMs(isoDay(now)), first = dateMs(start || config.firstSourceDate), stop = dateMs(end || isoDay(today));
  if (first >= stop || stop > today) {
    if (!start && first === stop) return [];
    throw new Error('Require start < end, with end <= today UTC');
  }
  const covered = coveredSourceDates(manifest), result = [];
  for (let t = first; t < stop; t += DAY_MS) {
    const day = isoDay(t);
    if (refresh || !covered.has(day)) result.push(day);
  }
  return result.slice(0, config.maxDaysPerRun);
}
