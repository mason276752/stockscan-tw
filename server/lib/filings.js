// Filing-list helpers with no I/O (the browser build of the app uses them
// too). A Taiwan listed company files one financial report per quarter on
// MOPS (公開資訊觀測站): Q1-Q3 are the quarterly reports (form 'QR'), Q4 the
// annual report (form 'AR', fiscal period 'FY'). Every listed company's
// fiscal year is the calendar year, so a report is fully named by company
// code, year and quarter - that is its "accession" here: '2330-2026Q2'.
// The company code is also what the rest of the app calls `cik` (a number:
// TWSE codes have no leading zero) and `ticker` (the same code as text).

const MOPS = 'https://mopsov.twse.com.tw/server-java/t164sb01';

export const FORMS = ['QR', 'AR'];
export const formOf = (quarter) => (Number(quarter) === 4 ? 'AR' : 'QR');
export const periodOf = (quarter) => (Number(quarter) === 4 ? 'FY' : `Q${quarter}`);
export const quarterOf = (period) => (period === 'FY' ? 4 : Number(String(period).slice(1)));
export const accessionOf = (code, year, quarter) => `${code}-${year}Q${quarter}`;

// '2330-2026Q2' -> { code: '2330', year: 2026, quarter: 2 }
export function parseAccession(accession) {
  const m = /^(\d+)-(\d{4})Q([1-4])$/.exec(String(accession));
  return m ? { code: m[1], year: Number(m[2]), quarter: Number(m[3]) } : null;
}

const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'];
export const periodEndOf = (year, quarter) => `${year}-${QUARTER_END[quarter - 1]}`;

// The statutory deadline (證券交易法第 36 條, general companies): Q1 by May
// 15, Q2 by Aug 14, Q3 by Nov 14, the annual report by Mar 31 of the next
// year - the filing date when the report itself does not say.
export function deadlineOf(year, quarter) {
  return quarter === 4 ? `${year + 1}-03-31` : `${year}-${['05-15', '08-14', '11-14'][quarter - 1]}`;
}

// REPORT_ID: C = consolidated (合併), A = individual (個別 / 個體)
export function mopsUrls(code, year, quarter, reportId = 'C') {
  const q = new URLSearchParams({ step: '1', CO_ID: String(code), SYEAR: String(year), SSEASON: String(quarter), REPORT_ID: reportId });
  const documentUrl = `${MOPS}?${q}`;
  return { documentUrl, viewerUrl: documentUrl, indexUrl: documentUrl };
}

// One entry of a company's filing list.
export function filingRecord(code, year, quarter, extra = {}) {
  return {
    cik: Number(code),
    accession: accessionOf(code, year, quarter),
    form: formOf(quarter),
    reportDate: periodEndOf(year, quarter),
    filingDate: extra.filingDate || null,
    fiscalYear: year,
    fiscalPeriod: periodOf(quarter),
    reportId: extra.reportId || null,
    ...mopsUrls(code, year, quarter, extra.reportId || 'C'),
  };
}

// Newest first (year, then quarter).
export const byPeriodDesc = (a, b) => b.fiscalYear - a.fiscalYear || quarterOf(b.fiscalPeriod) - quarterOf(a.fiscalPeriod);

export function pickFiling(filings, { year, period } = {}) {
  let list = filings;
  if (year) list = list.filter((f) => f.fiscalYear === Number(year));
  if (period) list = list.filter((f) => f.fiscalPeriod === period.toUpperCase());
  return list[0] || null;
}

// The store's file names of a filing and its score (store.js's naming, here
// so the static build and its browser can derive them instead of shipping
// every path in the company index).
const safeName = (s) => String(s ?? '-').replace(/\//g, '~').replace(/[^A-Za-z0-9.~-]/g, '_') || '-';
export const filingFile = (cik, f, version) => `filings/${cik}/${f.accession}__${safeName(f.reportDate)}__${safeName(f.form)}__v${version}.json.zst`;
export const scoreFile = (cik, f, version) => `scores/${cik}/${f.accession}__${safeName(f.reportDate)}__v${version}.json.zst`;
