// Holding companies set up by share exchange. The company that used to be
// listed is delisted the day the holding company takes its place, under a new
// code - and the new code has no reports from before that day: MOPS files
// them under the old one. The business is the same, though, and so are the
// books (a reorganisation under common control): the first report of the
// holding company opens with the balance sheet the old one closed with, and
// its nine months are the old one's six plus its own three, to the thousand.
// So the quarters before the exchange are the old code's reports, filed here
// as the holding company's.
//
// What does not carry over is the share: the exchange may be at a ratio
// (two old shares for one new), and then an amount per old share is not an
// amount per new one. The holding company restates its own comparatives; the
// reports taken over are restated the same way here (asSuccessors), and the
// page says so.
//
// TWSE's table does not say who a holding company used to be, so the pairs
// are kept by hand; unmapped() names the ones that are missing.

import { filingRecord, periodEndOf } from './filings.js';
import { store } from './store.js';

// code -> the company it took the place of; `per`: old shares for one new
// (the paid-in capitals before and after say: 中化 298,081,100 -> 149,040,500)
export const PREDECESSORS = {
  3715: { code: '6251', per: 1 }, // 定穎電子 -> 定穎投控, 2022-08-25
  3716: { code: '1701', per: 2 }, // 中國化學製藥 -> 中化控股, 2024-09-02
  3717: { code: '6288', per: 1 }, // 聯嘉光電 -> 聯嘉投控, 2025-08-15
};

// The report of a listed company for a quarter: its own, or - for a quarter
// that ended before the company existed - its predecessor's.
export function reportOf(row, year, quarter, extra = {}) {
  const was = PREDECESSORS[row.ticker];
  const before = was && periodEndOf(year, quarter) < (row.foundedDate || row.listedDate || '');
  return filingRecord(before ? was.code : row.ticker, year, quarter, { cik: row.cik, ...extra });
}

// A predecessor's report as its successor's: same numbers, per-share amounts
// and share counts on the basis of the new share.
export function asSuccessors(result, cik) {
  const was = PREDECESSORS[cik];
  if (!was || result.filing.predecessor) return result;
  result.filing.cik = Number(cik);
  result.filing.predecessor = { code: was.code, name: result.filing.companyName, per: was.per };
  if (was.per === 1) return result;
  const exact = (x) => Number(x.toPrecision(12));
  for (const st of result.allStatements) {
    for (const li of st.lineItems) {
      for (const cell of Object.values(li.values)) {
        if (typeof cell.value !== 'number') continue;
        if (cell.unit?.includes('/')) cell.value = exact(cell.value * was.per);
        else if (cell.unit === 'shares') cell.value = exact(cell.value / was.per);
      }
    }
  }
  for (const c of result.coverShares || []) c.value = exact(c.value / was.per);
  return result;
}

// A predecessor that has left the table: what is saved of it goes over to
// its successor instead of being thrown away (twse.js purgeDelisted).
export function adoptPredecessors(rows) {
  const listed = new Set(rows.map((r) => r.ticker));
  let adopted = 0;
  for (const row of rows) {
    const was = PREDECESSORS[row.ticker];
    if (!was || listed.has(was.code)) continue;
    for (const f of store.allFilings()) {
      if (f.cik !== Number(was.code)) continue;
      const saved = store.getFiling(f.accession);
      if (!saved) continue;
      store.putFiling(f.accession, row.cik, asSuccessors(saved, row.cik), f.version);
      adopted++;
    }
  }
  return adopted;
}

// Companies that listed the day they were set up, not long ago, and whose
// predecessor nobody has written down yet.
const DAY = 86400000;
export function unmapped(rows, now = Date.now()) {
  return rows.filter((r) => {
    if (PREDECESSORS[r.ticker] || r.industry === '91' || !r.foundedDate || !r.listedDate) return false;
    const founded = Date.parse(r.foundedDate);
    const at = Date.parse(r.listedDate);
    return Math.abs(at - founded) <= 31 * DAY && now - at < 3 * 366 * DAY;
  });
}
