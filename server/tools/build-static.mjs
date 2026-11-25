// Build the pure-frontend site: the Vue app compiled with VITE_STATIC=1, the
// saved reports / scores as they are in data/store, and the indexes the
// browser needs because a static host cannot list directories or run the
// screener (company lists, latest scores, market snapshot).
//
//   node server/tools/build-static.mjs [--out web/dist-static] [--link]
//
// Output is a directory to put on any static host (GitHub Pages, S3, nginx).
// --link hard-links the store files instead of copying them (same disk).
// Everything comes from the local store and caches; the TWSE listed-company
// table and the market snapshot are refreshed when the network allows.
//
// The slow parts - copying the store, decoding every report / score file
// for its header, zstd-19 of the indexes - are done by the Rust
// helper tools/stockscan-static: the committed binary for this platform
// (bin/stockscan-static-<arch>-<os>; the Linux one is what the Pages
// workflow runs, nothing is compiled there), else a local cargo build
// (made here when missing). STOCKSCAN_STATIC_NATIVE=0 forces the pure-Node
// path, which produces the same output, only slower. What goes into the
// indexes is decided in this file either way.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = path.resolve(REPO, opt('--out', path.join('web', 'dist-static')));
const LINK = args.includes('--link');
const t0 = Date.now();

// ---- the native helper (tools/stockscan-static) ----
const NATIVE = (() => {
  if (/^(0|false|no|off)$/i.test(process.env.STOCKSCAN_STATIC_NATIVE || '')) return null;
  const tool = path.join(REPO, 'tools', 'stockscan-static');
  const bundled = path.join(tool, 'bin', `stockscan-static-${process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch}-${process.platform}`);
  const bin = process.env.STOCKSCAN_STATIC_BIN || (fs.existsSync(bundled) ? bundled : path.join(tool, 'target', 'release', 'stockscan-static'));
  if (!fs.existsSync(bin)) {
    try {
      console.log('build-static: building tools/stockscan-static (cargo build --release) …');
      execFileSync('cargo', ['build', '--release', '--quiet'], { cwd: tool, stdio: 'inherit' });
    } catch (err) {
      console.warn(`build-static: no native helper (${err.message.split('\n')[0]}) - the slower Node path is used`);
      return null;
    }
  }
  return fs.existsSync(bin) ? bin : null;
})();
const native = (...cmd) => execFileSync(NATIVE, cmd, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 });
console.log(`build-static: ${NATIVE ? `native helper ${path.relative(REPO, NATIVE)}` : 'pure Node'}`);

// ---- 1. the app ----
console.log(`build-static: web app -> ${OUT}`);
execFileSync('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir'], { cwd: path.join(REPO, 'web'), stdio: 'inherit', env: { ...process.env, VITE_STATIC: '1' } });

// ---- 2. the store ----
const { openStore, store } = await import('../lib/store.js');
openStore();
const { SCRAPE_VERSION } = await import('../lib/scrape.js');
const { SCORE_VERSION, latestScores } = await import('../lib/score.js');
const { industryCounts, screenColumns, screenRows, scoreBadge } = await import('../lib/screen.js');
const { filingFile, scoreFile, parseAccession, filingRecord, byPeriodDesc } = await import('../lib/filings.js');
const { universeOf } = await import('../lib/universe.js');
const { companyRecord } = await import('../lib/companies.js');

function copyTree(from, to) {
  if (NATIVE) return native('copy', from, to, ...(LINK ? ['--link'] : []));
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.tmp'), ...(LINK ? { mode: fs.constants.COPYFILE_FICLONE } : {}) });
}
const dataOut = path.join(OUT, 'data');
fs.mkdirSync(dataOut, { recursive: true });
console.log('build-static: copying data/store …');
copyTree(store.file, path.join(dataOut, 'store'));
copyTree(path.join(REPO, 'server', 'data', 'zdict'), path.join(dataOut, 'zdict'));
// the daily bars (data/bars/<source>/<SYMBOL>/{<year>.zst, head.zst, meta.json}): the
// custom-ETF page computes its index in the browser from them. head.zst (this
// year) is not in git - the workflow fetches it before building (npm run fetch:bars)
const barsDir = process.env.STOCKSCAN_BARS || path.join(REPO, 'data', 'bars');
let bars = { symbols: 0, heads: 0, bytes: 0 };
if (fs.existsSync(barsDir)) {
  console.log('build-static: copying data/bars …');
  copyTree(barsDir, path.join(dataOut, 'bars'));
  for (const src of fs.readdirSync(barsDir, { withFileTypes: true })) {
    if (!src.isDirectory()) continue;
    for (const sym of fs.readdirSync(path.join(barsDir, src.name), { withFileTypes: true })) {
      if (!sym.isDirectory()) continue;
      const d = path.join(barsDir, src.name, sym.name);
      if (!fs.existsSync(path.join(d, 'meta.json'))) continue;
      bars.symbols++;
      if (fs.existsSync(path.join(d, 'head.zst'))) bars.heads++;
      for (const f of fs.readdirSync(d)) bars.bytes += fs.statSync(path.join(d, f)).size;
    }
  }
  console.log(`build-static: bars ${bars.symbols} symbols (${bars.heads} with this year), ${(bars.bytes / 1048576).toFixed(0)} MB`);
}

// ---- 3. indexes ----
const idx = path.join(OUT, 'index');
fs.mkdirSync(idx, { recursive: true });
// Index files go out zstd'd and content-addressed (<name>.<hash>.json.zst,
// the hash of the JSON): a static host may not compress what it serves and
// the browser has zstd-wasm anyway (the filings need it); the name changing
// only with the content lets the browser keep an index across builds until
// it really changes (the industry counts and the listed table rarely do).
// meta.json (plain, always revalidated) maps each
// index to its current file. With the native helper the raw JSON is written
// now and all of them are compressed together (in parallel) at the end.
const toCompress = [];
const files = {}; // index -> file name of this build
const write = (name, obj, { compress = true } = {}) => {
  const json = Buffer.from(JSON.stringify(obj));
  if (!compress) {
    fs.writeFileSync(path.join(idx, name), json);
    console.log(`build-static: ${name} ${(json.length / 1024).toFixed(1)} KB`);
    return;
  }
  const base = name.replace(/\.json$/, '');
  const hashed = `${base}.${createHash('sha1').update(json).digest('hex').slice(0, 10)}.json`;
  files[base] = `${hashed}.zst`;
  if (NATIVE) {
    const raw = path.join(idx, hashed);
    fs.writeFileSync(raw, json);
    toCompress.push(raw);
    return;
  }
  const file = path.join(idx, `${hashed}.zst`);
  fs.writeFileSync(file, zlib.zstdCompressSync(json, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } }));
  console.log(`build-static: ${path.basename(file)} ${(fs.statSync(file).size / 1048576).toFixed(1)} MB (${(json.length / 1048576).toFixed(1)} MB raw)`);
};

// the headers of every filing and every score, decoded once by the helper;
// the store then answers filingHeader / scoreJson from these instead of
// reading and inflating each file on demand
if (NATIVE) {
  const t = Date.now();
  const decoded = JSON.parse(native('decode', store.file, path.join(REPO, 'server', 'data', 'zdict')).toString('utf8'));
  const headers = decoded.filings;
  const scoreJson = decoded.scores;
  store.filingHeader = (accession) => (store.hasFiling(accession) ? headers[accession] ?? null : null);
  const scoreVersion = new Map(store.allScores().map((s) => [s.accession, s.version]));
  store.scoreJson = (accession) => (scoreVersion.has(accession) ? scoreJson[accession] ?? null : null);
  console.log(`build-static: decoded ${Object.keys(headers).length} headers, ${Object.keys(scoreJson).length} scores in ${((Date.now() - t) / 1000).toFixed(1)} s`);
}

// the TWSE listed-company table and the market snapshot: refreshed when the
// network allows, else the saved copies (data/store/listed.json is in the
// data ref, so even a runner that cannot reach TWSE has it)
const { TwClient } = await import('../lib/twClient.js');
const { refreshListed, savedListed } = await import('../lib/twse.js');
const { marketSnapshot } = await import('../lib/market.js');
const client = new TwClient();
let listed = savedListed()?.value || [];
let listedAt = savedListed()?.updatedAt || null;
try {
  listed = await refreshListed(client);
  listedAt = new Date().toISOString();
  console.log(`build-static: TWSE listed companies ${listed.length}`);
} catch (err) {
  console.warn(`build-static: TWSE listed-company table: ${err.message} - using the saved one (${listed.length})`);
}
let market = store.getKV('market:snapshot')?.value || null;
try {
  market = (await marketSnapshot({ wait: true })) || market;
  console.log(`build-static: market snapshot ${market?.count ?? 0} symbols`);
} catch (err) {
  console.warn(`build-static: market snapshot: ${err.message}`);
}
// without it the site is broken (no search, no company page, empty browse /
// screener): fail the build rather than publish it over a good one
if (!listed.length) {
  console.error('build-static: ERROR no listed-company table - neither in the store (data/store/listed.json) nor fetched from the TWSE OpenAPI');
  process.exit(1);
}
const universe = universeOf(listed, market?.byTicker || null, listedAt);
const byCik = new Map(universe.companies.map((c) => [c.cik, c]));

// companies: every listed company, with its saved reports (the list the
// report picker shows). The store paths are derived in the browser when they
// follow the naming - file / scoreFile are only spelled out when they do
// not, scoreFile: true when they do.
console.log('build-static: reading report headers …');
const filingsByCik = new Map();
for (const f of store.allFilings()) (filingsByCik.get(f.cik) || filingsByCik.set(f.cik, []).get(f.cik)).push(f);
const scoreFiles = new Map(store.allScores().filter((s) => s.version === SCORE_VERSION).map((s) => [s.accession, s.file]));
const companies = {};
let withReports = 0;
for (const row of listed) {
  const filings = [];
  for (const rec of filingsByCik.get(row.cik) || []) {
    const p = parseAccession(rec.accession);
    const h = store.filingHeader(rec.accession);
    if (!p || !h) continue;
    const full = filingRecord(p.code, p.year, p.quarter, { cik: row.cik, filingDate: h.filingDate, reportId: h.reportId });
    const f = { accession: full.accession, form: full.form, filingDate: full.filingDate, reportDate: full.reportDate, fiscalYear: full.fiscalYear, fiscalPeriod: full.fiscalPeriod, reportId: full.reportId };
    if (rec.file !== filingFile(row.cik, f, SCRAPE_VERSION)) f.file = rec.file;
    const sf = scoreFiles.get(rec.accession);
    if (sf) f.scoreFile = sf === scoreFile(row.cik, f, SCORE_VERSION) ? true : sf;
    filings.push(f);
  }
  filings.sort(byPeriodDesc);
  if (filings.length) withReports++;
  const { filings: _, ...rec } = companyRecord(row, []);
  companies[row.cik] = { ...rec, filings };
}
write('companies.json', companies);
console.log(`build-static: ${Object.keys(companies).length} listed companies, ${withReports} with saved reports`);

write('tickers.json', listed.map((r) => ({ cik: r.cik, ticker: r.ticker, name: r.name, fullName: r.fullName, nameEn: r.nameEn })));

console.log('build-static: latest scores, screener columns …');
const scores = latestScores();
write('scores-min.json', Object.fromEntries(scores.map((s) => [s.cik, scoreBadge(s)])));
// the screener rows as columns (one array per field): a quarter of the
// JSON of the rows, parsed by the browser's worker in a third of the time;
// the prev / yoy columns apart, so the first results need not wait for them
const screenCols = screenColumns(screenRows(scores, byCik, market?.byTicker || null));
write('screen.json', screenCols.screen);
write('screen-history.json', screenCols.history);
write('universe.json', { updatedAt: universe.updatedAt, companies: universe.companies });
// the industry counts of the browse page and the screener's pickers, so
// those need not load the universe
write('browse.json', { updatedAt: universe.updatedAt, industry: industryCounts(universe.companies) });
write('tvsymbols.json', Object.fromEntries(Object.entries(market?.byTicker || {}).map(([t, r]) => [t, { symbol: r.tv, exchange: r.exchange || null }])));

write(
  'meta.json',
  {
    builtAt: new Date().toISOString(),
    filings: store.filingCount(),
    scores: scores.length,
    companies: Object.keys(companies).length,
    withReports,
    scrapeVersion: SCRAPE_VERSION,
    scoreVersion: SCORE_VERSION,
    market: { count: market?.count ?? 0, updatedAt: market?.updatedAt ?? null, refreshing: false },
    bars: bars.symbols ? { symbols: bars.symbols, heads: bars.heads, sources: ['tv2'] } : null,
    files,
  },
  { compress: false },
);

if (toCompress.length) {
  console.log(`build-static: compressing ${toCompress.length} index files (zstd -19, ${(toCompress.reduce((n, f) => n + fs.statSync(f).size, 0) / 1048576).toFixed(0)} MB raw) …`);
  native('compress', '19', ...toCompress);
}

// GitHub Pages: no Jekyll processing (paths with __ would otherwise be skipped)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
console.log(`build-static: done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${OUT}`);
process.exit(0);
