// Local persistence, laid out so the data can live in git (many small
// immutable files, no file near GitHub's 100 MB limit, no LFS):
//
//   data/store/filings/<code>/<code>-<year>Q<q>__<period end>__<form>__v<parser>.json.zst
//       the parsed statements of one MOPS report (zstd JSON, dictionary-
//       compressed). A filed report never changes, so a file is written once
//       and kept; a parser version bump deletes it and it is fetched again.
//       The four primary statements are not stored twice: `statements` is
//       rebuilt from `allStatements`.
//   data/store/scores/<code>/<code>-<year>Q<q>__<period end>__v<score version>.json.zst
//       the score of one report
//   data/store/listed.json
//       the TWSE listed-company table (twse.js): the universe
//   data/store/kv/mops/missing.json
//       the reports MOPS answered "檔案不存在" for, so a CI runner does not
//       ask again (companies.js)
//   data/cache.sqlite   (not for git)
//       kv cache: market snapshot, latest quarters, crawl bookkeeping …
//
// `cik` throughout is the TWSE company code as a number (2330); codes have
// no leading zero. Everything the store knows about which files exist is
// read from the file names at startup (no index file to drift). Writes are
// atomic (temp + rename).
// Locations: STOCKSCAN_STORE (default <repo>/data/store), STOCKSCAN_CACHE
// (default <repo>/data/cache.sqlite) - relative to the repo, not the working
// directory.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { slim, fatten } from './storeFormat.js';

// Files are zstd with a dictionary trained on this kind of JSON (server/data/
// zdict, node server/tools/train-zdict.mjs): a report is about half the size
// it is with plain zstd. A dictionary is frozen once used.
const EXT = '.json.zst';
// paths default to the repo's data/ whatever the working directory is
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(REPO, 'data');
const ZDICT_DIR = path.join(REPO, 'server', 'data', 'zdict');
// STOCKSCAN_ZDICT=off writes plain zstd: only for collecting the samples the
// dictionaries are trained on (a throw-away store), never for the real one.
const NO_DICT = /^(0|off|no|false)$/i.test(process.env.STOCKSCAN_ZDICT || '');
const DICTS = NO_DICT ? {} : { filings: fs.readFileSync(path.join(ZDICT_DIR, 'filings-v1.zdict')), scores: fs.readFileSync(path.join(ZDICT_DIR, 'scores-v1.zdict')) };
const withDict = (kind) => (DICTS[kind] ? { dictionary: DICTS[kind] } : {});
const pack = (kind, value) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(value)), { ...withDict(kind), params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } });
const unpack = (kind, buf) => JSON.parse(zlib.zstdDecompressSync(buf, withDict(kind)).toString('utf8'));

let root = null; // data/store
let cache = null; // the kv SQLite

// kv keys that also live as files in the store (see getKV): what a fresh
// CI runner must not have to find out again - the reports MOPS does not have
const DURABLE_KV = ['mops:missing'];
const durableKV = (key) => DURABLE_KV.some((p) => (p.endsWith(':') ? key.startsWith(p) : key === p));
// 'mops:missing' -> 'kv/mops/missing.json'
const durableFile = (key) => `kv/${key.replace(/[^A-Za-z0-9:_.-]/g, '_').replace(/:/g, '/')}.json`;
const filings = new Map(); // accession -> { cik, form, reportDate, version, file, bytes }
const scores = new Map(); // accession -> { cik, reportDate, version, file }
// file name <-> record
const safe = (s) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
const unsafe = (s) => (s === '-' ? null : s.replace(/~/g, '/'));
const filingName = (accession, reportDate, form, version) => `${accession}__${safe(reportDate)}__${safe(form)}__v${version}${EXT}`;
const scoreName = (accession, reportDate, version) => `${accession}__${safe(reportDate)}__v${version}${EXT}`;
const FILING_RE = /^(.+?)__(.+?)__(.+?)__v(\d+)\.json\.zst$/;
const SCORE_RE = /^(.+?)__(.+?)__v(\d+)\.json\.zst$/;

const dir = (kind, cik) => path.join(root, kind, String(cik));

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}
const unlinkQuiet = (file) => {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
};
const rmdirQuiet = (d) => {
  try {
    fs.rmdirSync(d);
  } catch {
    /* not empty / gone */
  }
};

// scan the tree once: file names carry everything the indexes need
function scan(kind, re, into, make) {
  into.clear();
  const base = path.join(root, kind);
  if (!fs.existsSync(base)) return;
  for (const cikDir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!cikDir.isDirectory() || !/^\d+$/.test(cikDir.name)) continue;
    const cik = Number(cikDir.name);
    for (const name of fs.readdirSync(path.join(base, cikDir.name))) {
      const m = re.exec(name);
      if (!m) continue;
      const file = path.join(base, cikDir.name, name);
      const rec = make(m, cik, file);
      // two files for one accession (a crash between write and delete): keep the newest version
      const prev = into.get(rec.accession);
      if (prev && prev.version >= rec.version) {
        unlinkQuiet(file);
        continue;
      }
      if (prev) unlinkQuiet(prev.file);
      into.set(rec.accession, rec);
    }
  }
}
const scanFilings = () =>
  scan('filings', FILING_RE, filings, (m, cik, file) => ({ accession: m[1], cik, reportDate: unsafe(m[2]), form: unsafe(m[3]), version: Number(m[4]), file, bytes: fs.statSync(file).size }));
const scanScores = () => scan('scores', SCORE_RE, scores, (m, cik, file) => ({ accession: m[1], cik, reportDate: unsafe(m[2]), version: Number(m[3]), file }));

export function openStore(storeDir = process.env.STOCKSCAN_STORE || path.join(DATA, 'store'), cacheFile = process.env.STOCKSCAN_CACHE || path.join(DATA, 'cache.sqlite')) {
  root = storeDir;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  cache = new DatabaseSync(cacheFile);
  cache.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      json       BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  scanFilings();
  scanScores();
  cache.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the WAL back into the file so it does not sit at its high-water mark
  return root;
}

// files written by another parser version are thrown away (rebuilt on demand)
export function requireVersion(version) {
  let n = 0;
  for (const [acc, f] of filings) {
    if (f.version === version) continue;
    unlinkQuiet(f.file);
    rmdirQuiet(path.dirname(f.file));
    filings.delete(acc);
    n++;
  }
  if (n) console.log(`store: dropped ${n} filings parsed by an older version`);
}

const need = () => {
  if (!root) throw new Error('store not opened');
  return root;
};
// the kv cache is brotli'd (fast setting: the market snapshot is rewritten every half hour)
const KV_BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };
const kvPack = (value) => zlib.brotliCompressSync(Buffer.from(JSON.stringify(value)), KV_BROTLI);
const kvUnpack = (col) => JSON.parse(col instanceof Uint8Array ? zlib.brotliDecompressSync(col).toString('utf8') : col);

export const store = {
  get file() {
    return root;
  },

  getFiling(accession) {
    need();
    const f = filings.get(accession);
    if (!f) return null;
    try {
      return fatten(unpack('filings', fs.readFileSync(f.file)).data);
    } catch (err) {
      console.warn(`store: ${path.basename(f.file)} unreadable (${err.message}), dropped`);
      unlinkQuiet(f.file);
      filings.delete(accession);
      return null;
    }
  },
  // just the `filing` header of a saved filing (no statements rebuilt): for indexes
  filingHeader(accession) {
    need();
    const f = filings.get(accession);
    if (!f) return null;
    try {
      return unpack('filings', fs.readFileSync(f.file)).data?.filing || null;
    } catch {
      return null;
    }
  },
  hasFiling(accession) {
    need();
    return filings.has(accession);
  },
  putFiling(accession, cik, result, version, fetchedAt = new Date().toISOString()) {
    need();
    const reportDate = result.filing?.periodEnd ?? null;
    const form = result.filing?.form ?? null;
    const file = path.join(dir('filings', cik), filingName(accession, reportDate, form, version));
    const buf = pack('filings', { accession, cik, form, reportDate, version, fetchedAt, data: slim(result) });
    writeAtomic(file, buf);
    const prev = filings.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    filings.set(accession, { accession, cik: Number(cik), form, reportDate, version, file, bytes: buf.length });
  },
  filingCount(cik = null) {
    need();
    if (cik == null) return filings.size;
    let n = 0;
    for (const f of filings.values()) if (f.cik === Number(cik)) n++;
    return n;
  },
  // every saved filing / score (light: from the file names), with the file's
  // path relative to the store - for the static-site build
  allFilings() {
    need();
    return [...filings.values()].map((f) => ({ accession: f.accession, cik: f.cik, form: f.form, reportDate: f.reportDate, version: f.version, file: path.relative(root, f.file) }));
  },
  allScores() {
    need();
    return [...scores.values()].map((s) => ({ accession: s.accession, cik: s.cik, reportDate: s.reportDate, version: s.version, file: path.relative(root, s.file) }));
  },
  // accession -> report_date of every saved filing of a company (cheap: no file reads)
  filingIndex(cik) {
    need();
    const out = [];
    for (const f of filings.values()) if (f.cik === Number(cik)) out.push({ accession: f.accession, form: f.form, report_date: f.reportDate });
    return out;
  },

  // small plain-JSON documents in the store (listed.json …): git-
  // friendly, with the write time so callers can apply their own TTL
  getDoc(name) {
    need();
    try {
      const st = fs.statSync(path.join(root, name));
      return { value: JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')), ageMs: Date.now() - st.mtimeMs };
    } catch {
      return null;
    }
  },
  putDoc(name, value) {
    need();
    writeAtomic(path.join(root, name), JSON.stringify(value));
  },
  listDocs(dir) {
    need();
    try {
      return fs.readdirSync(path.join(root, dir)).filter((n) => n.endsWith('.json')).map((n) => `${dir}/${n}`);
    } catch {
      return [];
    }
  },

  // kv entries come back with their age so callers can apply their own TTL.
  // Durable keys (DURABLE_KV) are mirrored as data/store/kv/<key>.json with
  // the write time inside, so they travel with the store (the data ref, a
  // fresh CI runner) and the TTL still works after a git checkout; the
  // SQLite row is only a faster copy of the file.
  getKV(key) {
    const row = cache.prepare('SELECT json, updated_at FROM kv WHERE key = ?').get(key);
    if (row) {
      const value = kvUnpack(row.json);
      // a row written as plain text (first migration pass): re-pack it on the way out
      if (typeof row.json === 'string') cache.prepare('UPDATE kv SET json = ? WHERE key = ?').run(kvPack(value), key);
      return { value, ageMs: Date.now() - row.updated_at };
    }
    if (!durableKV(key)) return null;
    const doc = this.getDoc(durableFile(key))?.value;
    if (!doc || typeof doc !== 'object' || !('value' in doc)) return null;
    const at = Date.parse(doc.updatedAt || '') || 0;
    cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, kvPack(doc.value), at);
    return { value: doc.value, ageMs: Date.now() - at };
  },
  putKV(key, value) {
    const now = Date.now();
    cache.prepare('INSERT OR REPLACE INTO kv (key, json, updated_at) VALUES (?, ?, ?)').run(key, kvPack(value), now);
    if (durableKV(key)) this.putDoc(durableFile(key), { key, updatedAt: new Date(now).toISOString(), value });
  },
  kvKeys(prefix) {
    return cache.prepare('SELECT key FROM kv WHERE substr(key, 1, ?) = ?').all(prefix.length, prefix).map((r) => r.key);
  },
  deleteKV(key) {
    cache.prepare('DELETE FROM kv WHERE key = ?').run(key);
  },
  compactKV() {
    cache.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
  },

  // scores: one per filing, keyed by accession, invalidated by version
  getScore(accession, version) {
    need();
    const s = scores.get(accession);
    if (!s || s.version !== version) return null;
    return this.scoreJson(accession);
  },
  putScore(accession, cik, reportDate, version, score) {
    need();
    const file = path.join(dir('scores', cik), scoreName(accession, reportDate, version));
    writeAtomic(file, pack('scores', { accession, cik, reportDate, version, score }));
    const prev = scores.get(accession);
    if (prev && prev.file !== file) unlinkQuiet(prev.file);
    scores.set(accession, { accession, cik: Number(cik), reportDate: reportDate ?? null, version, file });
  },
  scoreCount(version) {
    need();
    let n = 0;
    for (const s of scores.values()) if (s.version === version) n++;
    return n;
  },
  // newest scored filing per company
  latestScoreRows(version) {
    const best = new Map();
    for (const s of scores.values()) {
      if (s.version !== version || !s.reportDate) continue;
      const b = best.get(s.cik);
      if (!b || s.reportDate > b.reportDate) best.set(s.cik, s);
    }
    return [...best.values()].map((s) => this.scoreJson(s.accession)).filter(Boolean);
  },
  // every scored filing (light: no file reads), newest first within a company
  scoreIndex(version) {
    need();
    const rows = [];
    for (const s of scores.values()) if (s.version === version) rows.push({ accession: s.accession, cik: s.cik, report_date: s.reportDate });
    return rows.sort((a, b) => a.cik - b.cik || (a.report_date < b.report_date ? 1 : a.report_date > b.report_date ? -1 : 0));
  },
  scoreJson(accession) {
    need();
    const s = scores.get(accession);
    if (!s) return null;
    try {
      return unpack('scores', fs.readFileSync(s.file)).score;
    } catch {
      unlinkQuiet(s.file);
      scores.delete(accession);
      return null;
    }
  },
  unscoredAccessions(version) {
    need();
    const out = [];
    for (const acc of filings.keys()) {
      const s = scores.get(acc);
      if (!s || s.version !== version) out.push(acc);
    }
    return out;
  },
  // drop every saved filing / score of companies outside `ciks` (delisted
  // companies: nothing to buy, so nothing to keep) -> { companies, filings, scores }
  purgeExcept(ciks) {
    need();
    const keep = new Set(ciks.map(Number));
    const gone = new Set();
    let nf = 0;
    let ns = 0;
    for (const [acc, f] of filings) {
      if (keep.has(f.cik)) continue;
      unlinkQuiet(f.file);
      filings.delete(acc);
      gone.add(f.cik);
      nf++;
    }
    for (const [acc, s] of scores) {
      if (keep.has(s.cik)) continue;
      unlinkQuiet(s.file);
      scores.delete(acc);
      gone.add(s.cik);
      ns++;
    }
    for (const cik of gone) {
      rmdirQuiet(dir('filings', cik));
      rmdirQuiet(dir('scores', cik));
    }
    return { companies: gone.size, filings: nf, scores: ns };
  },
  size() {
    need();
    let bytes = 0;
    for (const f of filings.values()) bytes += f.bytes;
    const k = cache.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(json)), 0) AS bytes FROM kv').get();
    return { filings: filings.size, filingsBytes: bytes, scores: scores.size, kv: k.n, kvBytes: k.bytes };
  },
};
