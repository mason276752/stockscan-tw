// Company lookup and report lists. MOPS has no machine-readable list of a
// company's reports, so a company's list is made up: every quarter from
// STOCKSCAN_FROM_YEAR (default six years back) to the newest one that can be
// out, minus the ones MOPS has answered "檔案不存在" for (kept in the store,
// see markMissing), plus whatever is saved.

import { store } from './store.js';
import { listedTable, latestPeriods, savedListed } from './twse.js';
import { filingRecord, parseAccession, deadlineOf, byPeriodDesc, pickFiling } from './filings.js';
import { reportOf } from './predecessors.js';
import { industryInfo } from './industry.js';
import { searchListed } from './companySearch.js';

export { pickFiling };

export const FROM_YEAR = Number(process.env.STOCKSCAN_FROM_YEAR) || new Date().getFullYear() - 6;
const DAY = 86400000;

// The newest quarter whose reports can be out on `now`: the first reports of
// a quarter arrive a few weeks after it ends.
export function newestPeriod(now = new Date()) {
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3); // the last finished quarter (0 = Q4 of last year)
  if (q === 0) {
    q = 4;
    y--;
  }
  const end = new Date(Date.UTC(q === 4 ? y + 1 : y, q === 4 ? 0 : q * 3, 1));
  if (now - end < 20 * DAY) {
    if (--q === 0) {
      q = 4;
      y--;
    }
  }
  return { year: y, quarter: q };
}

// ---- reports MOPS does not have ----
// accession -> ISO time of the "檔案不存在" answer. A quarter long past its
// deadline is not coming any more (the company was not public yet, or files
// no Taiwan IFRS XBRL); a recent one is asked again after a few days.
const MISSING_KEY = 'mops:missing';
const RETRY_MS = 2 * DAY;
let missingMemo = null;
const missing = () => (missingMemo ??= store.getKV(MISSING_KEY)?.value || {});
export function markMissing(accession) {
  missing()[accession] = new Date().toISOString();
  store.putKV(MISSING_KEY, missingMemo);
}
export function knownMissing(accession, now = Date.now()) {
  const at = missing()[accession];
  if (!at) return false;
  const p = parseAccession(accession);
  const settled = p && Date.parse(deadlineOf(p.year, p.quarter)) + 120 * DAY < Date.parse(at);
  return settled || now - Date.parse(at) < RETRY_MS;
}
export function clearMissing(accession) {
  if (missing()[accession]) {
    delete missingMemo[accession];
    store.putKV(MISSING_KEY, missingMemo);
  }
}

// ---- lookup ----
export async function searchCompanies(client, q, limit = 10) {
  return searchListed(await listedTable(client), q, limit);
}
export async function companyRow(client, id) {
  const rows = await listedTable(client);
  const s = String(id).trim();
  const row = rows.find((r) => r.ticker === s) || rows.find((r) => r.name === s);
  if (!row) throw Object.assign(new Error(`不是目前的上市公司：${id}`), { status: 404 });
  return row;
}

// Listing status from the saved table (no network): listed or not.
export function listingOf(ticker) {
  const rows = savedListed()?.value;
  if (!rows) return null;
  return { listed: rows.some((r) => r.ticker === String(ticker).trim()) };
}

// The quarters to list for a company, newest first: from its latest report
// on TWSE's table (else the newest that can be out) back to FROM_YEAR.
export function candidatePeriods(latest, fromYear = FROM_YEAR) {
  const out = [];
  let { year, quarter } = latest;
  while (year > fromYear || (year === fromYear && quarter >= 1)) {
    out.push({ year, quarter });
    if (--quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return out;
}

export function companyRecord(row, filings) {
  const ind = industryInfo(row.industry);
  return {
    cik: row.cik,
    ticker: row.ticker,
    tickers: [row.ticker],
    name: row.name,
    fullName: row.fullName,
    nameEn: row.nameEn,
    exchanges: ['TWSE'],
    industry: ind?.code || null,
    industryZh: ind?.zh || null,
    industryTitle: ind?.title || null,
    listedDate: row.listedDate,
    par: row.par,
    reportType: row.reportType,
    foreign: row.foreign,
    website: row.website,
    filings,
  };
}

// The saved reports of a company as list entries (headers from the store).
export function savedFilings(cik) {
  const out = [];
  for (const r of store.filingIndex(cik)) {
    const p = parseAccession(r.accession);
    if (!p) continue;
    const h = store.filingHeader(r.accession);
    out.push({ ...filingRecord(p.code, p.year, p.quarter, { cik, filingDate: h?.filingDate, reportId: h?.reportId }), saved: true });
  }
  return out.sort(byPeriodDesc);
}

export async function getCompany(client, id) {
  const row = await companyRow(client, id);
  let latest = newestPeriod();
  try {
    const lp = (await latestPeriods(client))[row.ticker];
    if (lp && lp.year * 10 + lp.quarter > latest.year * 10 + latest.quarter) latest = lp;
  } catch {
    /* TWSE unreachable: the calendar's guess */
  }
  const saved = new Map(savedFilings(row.cik).map((f) => [f.accession, f]));
  const filings = [];
  if (row.industry !== '91') {
    // depositary receipts file no Taiwan IFRS reports
    for (const { year, quarter } of candidatePeriods(latest)) {
      const f = reportOf(row, year, quarter, { reportId: row.reportType });
      if (saved.has(f.accession)) filings.push(saved.get(f.accession));
      else if (!knownMissing(f.accession)) filings.push(f);
      saved.delete(f.accession);
    }
  }
  filings.push(...saved.values());
  filings.sort(byPeriodDesc);
  return { ...companyRecord(row, filings), filingsUpdatedAt: new Date().toISOString(), filingsStale: false };
}
