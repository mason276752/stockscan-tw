// The pure-frontend data layer, in a Web Worker: the same methods as
// api.http.js, answered from static files (the saved filings and the indexes
// `npm run build:static` writes) with the server's own computation modules
// running in the browser. Nothing here talks to MOPS, TradingView or a
// broker, so what needs live data (fetching a report that is not saved)
// is unavailable and says so.
//
// It runs off the main thread so fetching, inflating and parsing the indexes
// (the screener's 11 MB of columns, the 12 MB company list), decoding a
// company's filings for its indicators and computing a basket index never
// stall the page; api.static.js on the page is the proxy that forwards each
// call here (see the message loop at the end) and only the answers cross.
import { reclassify } from '../../server/lib/statementTypes.js';
import { fatten } from '../../server/lib/storeFormat.js';
import { currentView } from '../../server/lib/current.js';
import { buildQuarterly } from '../../server/lib/quarters.js';
import { buildIndicators } from '../../server/lib/indicators.js';
import { filingFile, mopsUrls, parseAccession, pickFiling, scoreFile } from '../../server/lib/filings.js';
import { ITEMS, SCORE_VERSION, scoreFilingOf } from '../../server/lib/scoreModel.js';
import { SCREEN_FIELDS, browseCompanies, screenQuery, screenTable, searchRows, wantsHistory } from '../../server/lib/screen.js';
import { INDUSTRY } from '../../server/lib/industry.js';
import { adjusted, decodeBars } from '../../server/lib/barFormat.js';
import { basketRequest, runBasket } from '../../server/lib/basket.js';
import { buildValuation } from '../../server/lib/valuation.js';
import * as data from './staticData';
import { translate } from './locales/translate.js';

// the page's UI language, sent with every request (no DOM / localStorage here)
let locale = 'zh';
const t = (key, params) => translate(locale, key, params);

const unavailable = (what) => Promise.reject(new Error(t('static.unavailable', { what: t(what) })));

// company code (or short name) -> the company record of the index
async function companyOf(id) {
  const all = await data.companies();
  const s = String(id).trim();
  let cik = /^\d+$/.test(s) ? Number(s) : null;
  if (cik == null) {
    const row = (await data.tickers()).find((r) => r.name === s);
    if (!row) throw new Error(t('static.noCompany', { cik: s }));
    cik = row.cik;
  }
  const c = all[cik];
  if (!c) throw new Error(t('static.noCompany', { cik }));
  if (!c.urlsDone) {
    // the MOPS links and store paths the index left out because they follow the naming
    const m = await data.meta();
    for (const f of c.filings) {
      const p = parseAccession(f.accession);
      Object.assign(f, { cik }, p ? mopsUrls(p.code, p.year, p.quarter, f.reportId || 'C') : {});
      f.file ??= filingFile(cik, f, m.scrapeVersion);
      if (f.scoreFile === true) f.scoreFile = scoreFile(cik, f, m.scoreVersion);
      else f.scoreFile ??= null;
    }
    c.urlsDone = true;
  }
  return c;
}

// a saved report, as the server hands it out
async function loadFiling(f) {
  if (!f?.file) throw new Error(t('static.notSaved', { what: f?.accession || t('static.thisFiling') }));
  const rec = await data.readZst('filings', `/data/store/${f.file}`);
  return reclassify(fatten(rec.data));
}

// the screener's columns as the table screenQuery reads: without the prev /
// yoy columns (index/screen.json alone, enough for most queries) or with
// them (screen-history.json spread in); each built once
const screenTables = {};
const screenRows = (history) => (screenTables[history ? 'full' : 'core'] ??= (history ? Promise.all([data.screenIndex(), data.screenHistoryIndex()]) : Promise.all([data.screenIndex()])).then(([core, hist]) => screenTable(hist ? { ...core, prev: hist.prev, yoy: hist.yoy } : core)));

const api = {
  meta: () => data.meta(),

  async search(q) {
    const [rows, scores] = await Promise.all([data.tickers(), data.scoresMin()]);
    return searchRows(rows, q, 10).map((r) => ({ ...r, score: scores[r.cik] || null }));
  },
  async company(id) {
    const c = await companyOf(id);
    return { ...c, filingsUpdatedAt: (await data.meta()).builtAt, filingsStale: false };
  },
  async filing(cik, accession, view = 'all') {
    const c = await companyOf(cik);
    const filing = c.filings.find((f) => f.accession === accession);
    if (!filing) throw new Error(`Filing ${accession} not found`);
    const d = await loadFiling(filing);
    if (view !== 'current') return d;
    let prev = null;
    const q = /^Q([2-3])$/.exec(filing.fiscalPeriod || '');
    if (q) {
      const pf = pickFiling(c.filings, { year: filing.fiscalYear, period: `Q${Number(q[1]) - 1}` });
      if (pf?.file) {
        try {
          prev = { filing: pf, data: await loadFiling(pf) };
        } catch {
          prev = null;
        }
      }
    }
    return currentView(d, filing, prev);
  },
  async quarters(id, year) {
    const c = await companyOf(id);
    return buildQuarterly(loadFiling, c, Number(year));
  },
  async indicators(id, params) {
    const c = await companyOf(id);
    const year = Number(params.year);
    const period = String(params.period || 'FY').toUpperCase();
    const mode = ['year', 'same'].includes(params.mode) ? params.mode : 'quarter';
    const n = Math.min(mode === 'quarter' ? 40 : 10, Math.max(1, Number(params.n) || (mode === 'quarter' ? 20 : 5)));
    const basis = params.basis === 'ttm' ? 'ttm' : 'x4';
    return buildIndicators(loadFiling, c, { year, period, n, basis, mode });
  },
  // the valuation page from saved reports and shipped bars: share counts
  // travel inside each report (buildValuation indexes them itself). No split
  // events or FX rates are shipped.
  async valuation(id, params) {
    const c = await companyOf(id);
    const year = Number(params.year);
    const period = String(params.period || 'FY').toUpperCase();
    if (!year || !/^(Q[1-4]|FY)$/.test(period)) throw new Error('year and period (Q1-Q4 or FY) required');
    const n = Math.min(40, Math.max(4, Number(params.n) || 20));
    const adr = Math.max(0.0001, Number(params.adr) || 1);
    return buildValuation(c, { year, period, n, adr }, {
      load: loadFiling,
      shares: async () => ({ version: 2, byAccn: {}, list: [] }),
      prices: async (ticker) => {
        const b = await api.bars(ticker);
        return { symbol: b.symbol, source: b.source, currency: b.currency, days: b.days.map((d) => ({ date: d.date, close: d.close })), splits: null, fetchedAt: b.fetchedAt, headMissing: b.headMissing };
      },
      fx: async () => null,
    });
  },
  // an index the idle prefetcher warms after start-up (api.warmup on the
  // page lists them in order; here what each key loads - it stays here)
  async warm(key) {
    if (!WARM[key]) throw new Error(`unknown warmup ${key}`);
    await WARM[key]();
  },
  async status() {
    const m = await data.meta();
    return { static: true, meta: m, store: { filings: m.filings, scores: m.scores }, crawler: { enabled: false } };
  },
  async screenFields() {
    const m = await data.meta();
    return { fields: SCREEN_FIELDS, industries: INDUSTRY, market: m.market };
  },
  async screen(params) {
    const [rows, m] = await Promise.all([screenRows(wantsHistory(params)), data.meta()]);
    return { ...screenQuery(rows, params), scored: rows.length, market: m.market };
  },
  async scores(ciks) {
    const all = await data.scoresMin();
    const out = {};
    for (const cik of ciks) out[cik] = all[cik] || null;
    return { version: SCORE_VERSION, items: ITEMS.map(({ key, name, category, benchmark, weight }) => ({ key, name, category, benchmark, weight })), scores: out };
  },
  async score(cik, accession) {
    const c = await companyOf(cik);
    const f = c.filings.find((x) => x.accession === accession);
    if (!f) throw new Error(`Filing ${accession} not found`);
    if (f.scoreFile) return (await data.readZst('scores', `/data/store/${f.scoreFile}`)).score;
    const s = await scoreFilingOf(loadFiling, c, f);
    if (!s) throw new Error('Cannot score this filing');
    return s;
  },
  // browse page (the counts come precomputed; the company lists from the universe)
  async browseIndustry() {
    const b = await data.browse();
    return { updatedAt: b.updatedAt, ...b.industry };
  },
  async browseCompanies(params) {
    const u = await data.universe();
    return { updatedAt: u.updatedAt, ...browseCompanies(u.companies, params) };
  },
  // custom ETF charts: the bars the build shipped (data/bars, TradingView's
  // to the build's day), else only TradingView's own widget
  async quotesStatus() {
    const m = await data.meta();
    return { static: true, bars: m.bars || null, builtAt: m.builtAt, tv: { enabled: false, connected: false }, ib: { enabled: false, connected: false }, source: 'TradingView', tvLibrary: false };
  },
  async tvSymbol(ticker) {
    const t = String(ticker).toUpperCase();
    const m = (await data.tvSymbols())[t];
    return m ? { ticker: t, ...m, known: true } : { ticker: t, symbol: `TWSE:${t}`, exchange: 'TWSE', known: false };
  },
  ibConnect: () => unavailable('static.whatTws'),
  // ten years of daily bars from the files the build shipped: the finished
  // years (immutable, cached for good) plus this year's head, split
  // adjustments applied - the same series the server hands out
  async bars(symbol) {
    const m = await data.meta();
    if (!m.bars) return unavailable('static.whatBars');
    const s = String(symbol).toUpperCase().replace(/[^A-Z0-9.\-=^]/gi, '_');
    const dir = `/data/bars/tv2/${s}`;
    let meta;
    try {
      meta = await data.readBarsMeta(`${dir}/meta.json`);
    } catch (err) {
      throw new Error(err.status === 404 ? t('static.noBars', { s }) : err.message);
    }
    const [years, head] = await Promise.all([
      Promise.all((meta.years || []).map((y) => data.readBarsZst(`${dir}/${y}.zst`, { immutable: true }))),
      data.readBarsZst(`${dir}/head.zst`).catch(() => null),
    ]);
    const raw = years.flatMap(decodeBars).concat(head ? decodeBars(head) : []);
    if (!raw.length) throw new Error(t('static.noBars', { s }));
    // headMissing: the build shipped no head.zst for it - the series stops at last year's end
    return { symbol: s, source: meta.source || 'TradingView', currency: meta.currency || 'TWD', resolved: meta.resolved || null, fetchedAt: head?.fetchedAt || null, headMissing: !head, days: adjusted(raw, meta.adjust || []) };
  },
  // the custom-ETF index, computed here from those bars
  async basket(body) {
    return this.basketStream(body, null);
  },
  async basketStream(body, onEvent, signal) {
    const req = basketRequest(body || {});
    const rows = await data.tickers();
    const byTicker = new Map(rows.map((r) => [r.ticker, r]));
    const listingOf = (ticker) => ({ listed: byTicker.has(String(ticker).toUpperCase()) });
    const m = await data.meta();
    return runBasket(req, (t) => api.bars(t), { emit: onEvent, interim: body?.interim ? 1200 : 0, signal, listingOf, extra: { static: true, ib: false, tv: false, asOf: m.builtAt } });
  },
};

const WARM = {
  'idx:tickers': data.tickers,
  'idx:scores': data.scoresMin,
  'idx:companies': data.companies,
  'idx:tvsymbols': data.tvSymbols,
  'idx:browse': data.browse,
  'idx:universe': data.universe,
  'idx:screen': () => screenRows(false),
  'idx:screen-history': () => screenRows(true),
};

// download progress -> the page (busy.js), at most every 150 ms per file
const reported = new Map(); // path -> time of the last report
data.setProgress((path, loaded, total, done) => {
  const now = Date.now();
  if (!done && loaded > 0 && now - (reported.get(path) || 0) < 150) return;
  if (done) reported.delete(path);
  else reported.set(path, now);
  self.postMessage({ progress: { path, loaded, total, done } });
});

// ---- the message loop ----
// page -> worker  { id, method, args, locale }   call api[method](...args)
//                 { id, abort: true }            cancel that call (basketStream)
// worker -> page  { id, result } | { id, error: { message, status } }
//                 { id, event }                  a streamed event (basketStream's onEvent)
// basketStream's onEvent / signal arguments are made here: its args are
// [body, { stream: true }] and the events go back as they happen.
const inflight = new Map(); // id -> AbortController
self.onmessage = async ({ data: msg }) => {
  if (msg.abort) return inflight.get(msg.id)?.abort();
  const { id, method, args } = msg;
  locale = msg.locale || locale;
  const ctrl = new AbortController();
  inflight.set(id, ctrl);
  try {
    const fn = api[method];
    if (typeof fn !== 'function') throw new Error(`unknown method ${method}`);
    const emit = (event) => self.postMessage({ id, event });
    const result = await (method === 'basketStream' ? api.basketStream(args[0], emit, ctrl.signal) : fn.apply(api, args));
    self.postMessage({ id, result: result === undefined ? null : result });
  } catch (err) {
    self.postMessage({ id, error: { message: err?.message || String(err), status: err?.status ?? null } });
  } finally {
    inflight.delete(id);
  }
};
