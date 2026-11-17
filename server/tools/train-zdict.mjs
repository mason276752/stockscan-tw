// Train the zstd dictionaries the store compresses reports and scores with
// (server/data/zdict/*.zdict). Needs the `zstd` CLI. A dictionary must never
// change once files were written with it: to retrain, add a new name and
// keep the old file (see DICTS in server/lib/store.js).
//
// The samples come from a store written without a dictionary: collect one
// with STOCKSCAN_ZDICT=off (e.g. STOCKSCAN_ZDICT=off STOCKSCAN_STORE=/tmp/s
// STOCKSCAN_CACHE=/tmp/s.sqlite npm run fetch:new -- --budget 15), then
//   node server/tools/train-zdict.mjs /tmp/s [samples per kind]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = process.argv[2];
if (!root) {
  console.error('usage: node server/tools/train-zdict.mjs <store written with STOCKSCAN_ZDICT=off> [samples per kind]');
  process.exit(1);
}
const N = Number(process.argv[3]) || 1500;
const out = path.join(process.cwd(), 'server', 'data', 'zdict');
fs.mkdirSync(out, { recursive: true });

for (const [kind, size] of [['filings', 262144], ['scores', 112640]]) {
  const base = path.join(root, kind);
  const all = [];
  for (const cik of fs.readdirSync(base)) for (const name of fs.readdirSync(path.join(base, cik))) if (name.endsWith('.json.zst')) all.push(path.join(base, cik, name));
  // an evenly spread sample across companies
  const step = Math.max(1, Math.floor(all.length / N));
  const sample = all.filter((_, i) => i % step === 0).slice(0, N);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `zdict-${kind}-`));
  sample.forEach((f, i) => fs.writeFileSync(path.join(tmp, `${i}.json`), zlib.zstdDecompressSync(fs.readFileSync(f))));
  const dict = path.join(out, `${kind}-v1.zdict`);
  if (fs.existsSync(dict)) {
    console.error(`${dict} exists - a dictionary in use must not change; add a new version instead`);
    process.exit(1);
  }
  execFileSync('zstd', ['--train', '-q', `--maxdict=${size}`, '-o', dict, ...fs.readdirSync(tmp).map((n) => path.join(tmp, n))], { stdio: 'pipe' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${kind}: trained on ${sample.length} samples -> ${dict} (${fs.statSync(dict).size} bytes)`);
}
