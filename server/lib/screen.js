// The screener and the browse lists as pure functions over in-memory rows,
// so the server route and the browser build (which loads the same rows from
// prebuilt JSON) share one implementation.

import { ROWS as INDICATOR_ROWS } from './indicators.js';
import { AMOUNT_FIELDS } from './scoreModel.js';
import { MARKET_FIELDS } from './marketFields.js';
import { INDUSTRY, industryInfo } from './industry.js';

// Screener fields: the score, every indicator row, statement amounts (from
// the latest filing), and the market snapshot (price, market cap, multiples).
export const SCREEN_FIELDS = [
  { key: 'score', name: '評分', unit: '分', group: '評分' },
  ...INDICATOR_ROWS.filter((r) => !r.abstract).map((r) => ({ key: r.key, name: r.name, unit: r.unit, group: r.group, annualized: !!r.annualized })),
  ...AMOUNT_FIELDS,
  ...MARKET_FIELDS.map((f) => ({ ...f, market: true })),
];
export const MARKET_KEYS = new Set(MARKET_FIELDS.map((f) => f.key));
const fieldOf = (key) => SCREEN_FIELDS.find((f) => f.key === key);
const pctField = (key) => {
  const f = fieldOf(key);
  return f?.unit === '百萬' || f?.unit === '百萬股' || key === 'score';
};

// One screener row: a company's newest score (with prev / yoy), its
// universe record (industry) and market snapshot record.
export function screenRow(s, c, mk) {
  return {
    cik: c.cik,
    ticker: c.ticker,
    tickers: c.tickers,
    name: c.name,
    industry: c.industry,
    industryZh: industryInfo(c.industry)?.zh || null,
    score: { score: s.score, coverage: s.coverage, accession: s.accession, form: s.form, fiscalYear: s.fiscalYear, fiscalPeriod: s.fiscalPeriod, periodEnd: s.periodEnd, filingDate: s.filingDate, categories: s.categories.map((x) => x.score) },
    values: s.values || {},
    prev: s.prev ? { fiscalYear: s.prev.fiscalYear, fiscalPeriod: s.prev.fiscalPeriod, periodEnd: s.prev.periodEnd, score: s.prev.score, values: s.prev.values } : null,
    yoy: s.yoy ? { fiscalYear: s.yoy.fiscalYear, fiscalPeriod: s.yoy.fiscalPeriod, periodEnd: s.yoy.periodEnd, score: s.yoy.score, values: s.yoy.values } : null,
    history: s.history,
    market: mk ? { price: mk.price, currency: mk.currency, change: mk.change, marketCap: mk.marketCap, pe: mk.pe, pb: mk.pb, ps: mk.ps, pfcf: mk.pfcf, evEbitda: mk.evEbitda, divYield: mk.divYield, peg: mk.peg, perfYtd: mk.perfYtd, perfY: mk.perfY, volume: mk.volume, avgVolume: mk.avgVolume, beta: mk.beta, exchange: mk.exchange, tv: mk.tv } : null,
  };
}

// every scored company in the universe as a screener row
export function screenRows(scores, companiesByCik, marketByTicker = null) {
  const rows = [];
  for (const s of scores) {
    const c = companiesByCik.get(s.cik);
    if (!c) continue;
    rows.push(screenRow(s, c, c.ticker ? marketByTicker?.[c.ticker] || null : null));
  }
  return rows;
}

// ---- the screener table ----
// screenQuery reads the rows through a small accessor object, so the two
// layouts share one implementation: the server hands it the row objects
// screenRows builds per request (rowTable: nothing to convert), the static
// build ships the same rows as columns (screenColumns: one array per field
// - a quarter of the JSON of the rows, parsed in a third of the time) and
// the browser's worker reads those (columnTable: the value columns as
// Float64Array, NaN for null). The columns come in two files so the page
// can show its first results before the bigger half has arrived: the
// company / score / values / market columns (index/screen.json) and the
// prev / yoy columns for the change filters (screen-history.json, loaded
// when a query needs them - wantsHistory). Only the rows a query returns
// are materialised as objects.
const SCORE_KEYS = ['score', 'coverage', 'accession', 'form', 'fiscalYear', 'fiscalPeriod', 'periodEnd', 'filingDate', 'categories'];
const BASE_KEYS = ['fiscalYear', 'fiscalPeriod', 'periodEnd', 'score']; // prev / yoy, plus values
const ROW_KEYS = ['cik', 'ticker', 'tickers', 'name', 'industry', 'industryZh', 'history'];

// rows -> columns (what index/screen.json holds)
export function screenColumns(rows) {
  const n = rows.length;
  const col = (get) => {
    const a = new Array(n);
    for (let i = 0; i < n; i++) a[i] = get(rows[i]) ?? null;
    return a;
  };
  const cols = (keys, sel) => Object.fromEntries(keys.map((k) => [k, col((r) => sel(r)?.[k])]));
  const union = (sel) => {
    const keys = new Set();
    for (const r of rows) for (const k of Object.keys(sel(r) || {})) keys.add(k);
    return [...keys];
  };
  const valueKeys = [...new Set([...union((r) => r.values), ...union((r) => r.prev?.values), ...union((r) => r.yoy?.values)])];
  const base = (sel) => ({ has: col((r) => (sel(r) ? 1 : 0)), ...cols(BASE_KEYS, sel), values: cols(valueKeys, (r) => sel(r)?.values) });
  return {
    screen: {
      n,
      ...cols(ROW_KEYS, (r) => r),
      score: cols(SCORE_KEYS, (r) => r.score),
      values: cols(valueKeys, (r) => r.values),
      market: { has: col((r) => (r.market ? 1 : 0)), ...cols(union((r) => r.market), (r) => r.market) },
    },
    history: { n, prev: base((r) => r.prev), yoy: base((r) => r.yoy) },
  };
}

// does a query need the prev / yoy columns (a change filter or sort, or the
// page saying it shows change columns: history=1)?
export const wantsHistory = (q) => Object.keys(q).some((k) => /_(chg|yoy)_(min|max)$/.test(k)) || ['chg', 'yoy'].includes(String(q.sortmode || '')) || String(q.history || '') === '1';

const rowTable = (rows) => ({
  length: rows.length,
  ticker: (i) => rows[i].ticker,
  tickers: (i) => rows[i].tickers,
  name: (i) => rows[i].name,
  industry: (i) => rows[i].industry,
  score: (i) => rows[i].score.score,
  value: (i, key) => rows[i].values[key] ?? null,
  baseScore: (i, mode) => (mode === 'chg' ? rows[i].prev : rows[i].yoy)?.score ?? null,
  baseValue: (i, key, mode) => (mode === 'chg' ? rows[i].prev : rows[i].yoy)?.values?.[key] ?? null,
  market: (i, key) => rows[i].market?.[key] ?? null,
  row: (i) => rows[i],
});

function columnTable(c) {
  const typed = (cols) =>
    Object.fromEntries(
      Object.entries(cols).map(([k, a]) => {
        const f = new Float64Array(a.length);
        for (let i = 0; i < a.length; i++) f[i] = a[i] == null ? NaN : a[i];
        return [k, f];
      }),
    );
  const values = typed(c.values);
  // prev / yoy: absent until the history file is loaded (then every base is null)
  const bases = { chg: c.prev && { ...c.prev, values: typed(c.prev.values) }, yoy: c.yoy && { ...c.yoy, values: typed(c.yoy.values) } };
  const num = (a, i) => (a && !Number.isNaN(a[i]) ? a[i] : null);
  const pick = (cols, keys, i) => {
    const o = {};
    for (const k of keys) o[k] = cols[k]?.[i] ?? null;
    return o;
  };
  const valueKeys = Object.keys(c.values);
  const valuesAt = (cols, i) => {
    const o = {};
    for (const k of valueKeys) o[k] = num(cols[k], i);
    return o;
  };
  const baseAt = (mode, i) => (bases[mode]?.has[i] ? { ...pick(bases[mode], BASE_KEYS, i), values: valuesAt(bases[mode].values, i) } : null);
  const marketKeys = Object.keys(c.market).filter((k) => k !== 'has');
  return {
    length: c.n,
    ticker: (i) => c.ticker[i],
    tickers: (i) => c.tickers[i],
    name: (i) => c.name[i],
    industry: (i) => c.industry[i],
    score: (i) => c.score.score[i],
    value: (i, key) => num(values[key], i),
    baseScore: (i, mode) => (bases[mode]?.has[i] ? bases[mode].score[i] : null),
    baseValue: (i, key, mode) => (bases[mode]?.has[i] ? num(bases[mode].values[key], i) : null),
    market: (i, key) => (c.market.has[i] ? (c.market[key]?.[i] ?? null) : null),
    // the row object screenRow would have built
    row: (i) => ({
      ...pick(c, ROW_KEYS.slice(0, -1), i),
      score: pick(c.score, SCORE_KEYS, i),
      values: valuesAt(values, i),
      prev: baseAt('chg', i),
      yoy: baseAt('yoy', i),
      history: c.history[i],
      market: c.market.has[i] ? pick(c.market, marketKeys, i) : null,
    }),
  };
}

// rows (screenRows) or columns (screenColumns' screen, with or without its
// history spread in) -> the table screenQuery reads
export const screenTable = (x) => (Array.isArray(x) ? rowTable(x) : typeof x.length === 'number' && typeof x.row === 'function' ? x : columnTable(x));

// change since the previous filing (chg) or the same period a year earlier
// (yoy): percentage points for ratios, % growth for amounts and the score
function changeOf(t, i, key, mode) {
  const a = key === 'score' ? t.score(i) : t.value(i, key);
  const b = key === 'score' ? t.baseScore(i, mode) : t.baseValue(i, key, mode);
  if (a == null || b == null) return null;
  return pctField(key) ? (b === 0 ? null : ((a - b) / Math.abs(b)) * 100) : a - b;
}
const valueOf = (t, i, key, mode = 'now') => {
  if (MARKET_KEYS.has(key)) return mode === 'now' ? t.market(i, key) : null;
  if (mode !== 'now') return changeOf(t, i, key, mode);
  return key === 'score' ? t.score(i) : t.value(i, key);
};

// The query of GET /api/screen applied to the rows (an array of screenRow
// objects, the columns of screenColumns, or a screenTable of either):
// industry / division / exclusions / text, <key>[_chg|_yoy]_min|max ranges,
// sort, limit. (history=1 is the page's hint that it shows change columns:
// no effect here, see wantsHistory.)
const list = (v) =>
  String(v || '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
export function screenQuery(rows, q) {
  const t = screenTable(rows);
  const industry = q.industry ? String(q.industry).padStart(2, '0') : null;
  const division = q.division ? String(q.division).toUpperCase() : null;
  const exDiv = new Set(list(q.exdiv));
  const exInd = new Set(list(q.exind).map((x) => x.padStart(2, '0')));
  const text = String(q.q || '').trim().toUpperCase();
  const ranges = [];
  for (const [k, v] of Object.entries(q)) {
    const m = /^(.+?)(?:_(chg|yoy))?_(min|max)$/.exec(k);
    if (!m || v === '' || !Number.isFinite(Number(v))) continue;
    const f = fieldOf(m[1]);
    if (!f) continue;
    if (m[2] && f.market) continue; // no history for market fields
    ranges.push({ key: m[1], mode: m[2] || 'now', op: m[3], value: Number(v) });
  }
  const out = [];
  for (let i = 0; i < t.length; i++) {
    const code = t.industry(i) || '';
    const div = industryInfo(code)?.division || 'I';
    if (industry && code !== industry) continue;
    if (division && div !== division) continue;
    if (exDiv.has(div) || exInd.has(code)) continue;
    if (text && !(t.name(i).toUpperCase().includes(text) || (t.tickers(i) || []).some((x) => x.startsWith(text)))) continue;
    let ok = true;
    for (const x of ranges) {
      const v = valueOf(t, i, x.key, x.mode);
      if (v == null || (x.op === 'min' ? v < x.value : v > x.value)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  const sortKey = String(q.sort || 'score');
  const sortMode = ['chg', 'yoy'].includes(String(q.sortmode || '')) ? String(q.sortmode) : 'now';
  const dir = q.dir === 'asc' ? 1 : -1;
  const sv = (i) => (sortMode !== 'now' ? changeOf(t, i, sortKey, sortMode) : MARKET_KEYS.has(sortKey) ? t.market(i, sortKey) : sortKey === 'score' ? t.score(i) : sortKey === 'name' ? t.name(i) : sortKey === 'ticker' ? t.ticker(i) : t.value(i, sortKey));
  const keys = out.map(sv);
  const order = out.map((_, k) => k);
  order.sort((a, b) => {
    const x = keys[a];
    const y = keys[b];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const limit = Math.min(2000, Math.max(1, Number(q.limit) || 300));
  return { total: out.length, count: Math.min(out.length, limit), rows: order.slice(0, limit).map((k) => t.row(out[k])) };
}

// does a query need the market snapshot (so the server may wait for it)?
export const wantsMarket = (q) => Object.keys(q).some((k) => MARKET_KEYS.has(k.replace(/(?:_(?:chg|yoy))?_(?:min|max)$/, ''))) || MARKET_KEYS.has(String(q.sort || ''));

// ---- browse lists ----

export const companyRow = (c) => {
  const ind = industryInfo(c.industry);
  return {
    cik: c.cik,
    name: c.name,
    fullName: c.fullName,
    nameEn: c.nameEn,
    ticker: c.ticker,
    tickers: c.tickers,
    industry: c.industry,
    industryZh: ind?.zh || null,
    industryTitle: ind?.title || null,
    listedDate: c.listedDate,
    capital: c.capital,
    marketCap: c.marketCap ?? null,
    foreign: c.foreign,
  };
};

// industry divisions and codes with company counts
export function industryCounts(companies) {
  const counts = new Map();
  for (const c of companies) counts.set(c.industry, (counts.get(c.industry) || 0) + 1);
  const codes = INDUSTRY.codes.map((x) => ({ ...x, total: counts.get(x.code) || 0 }));
  for (const [code, total] of counts) if (code && !INDUSTRY.codes.some((x) => x.code === code)) codes.push({ ...industryInfo(code), total });
  return { divisions: INDUSTRY.divisions, codes };
}

// companies of an industry (the universe is already sorted biggest first)
export function browseCompanies(companies, query) {
  const industry = query.industry ? String(query.industry).padStart(2, '0') : null;
  const q = String(query.q || '').trim().toUpperCase();
  let rows = companies;
  if (industry) rows = rows.filter((c) => c.industry === industry);
  if (q) rows = rows.filter((c) => c.name.includes(q) || (c.fullName || '').includes(q) || (c.nameEn || '').toUpperCase().includes(q) || c.ticker.startsWith(q));
  return {
    industry: industry ? industryInfo(industry) : null,
    count: rows.length,
    companies: rows.slice(0, Number(query.limit) || 2000).map(companyRow),
  };
}

// code / company-name suggestions (code prefix first, then names)
export { searchListed as searchRows } from './companySearch.js';

// the score summary every list shows next to a company
export const scoreBadge = (s) => (s ? { score: s.score, coverage: s.coverage, accession: s.accession, form: s.form, fiscalYear: s.fiscalYear, fiscalPeriod: s.fiscalPeriod, periodEnd: s.periodEnd, filingDate: s.filingDate, categories: s.categories.map((c) => c.score) } : null);
