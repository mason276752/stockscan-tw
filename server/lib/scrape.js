// Fetch one MOPS report and turn it into the statements JSON.

import { parseMopsFiling, decodeMops, isMissing } from './mopsFiling.js';
import { mopsUrls, parseAccession } from './filings.js';
import { reclassify } from './statementTypes.js';
import { store } from './store.js';
import { markMissing, clearMissing } from './companies.js';

// Bump whenever the parser output changes: saved reports from older versions
// are discarded at startup and fetched again.
export const SCRAPE_VERSION = 1;

export const emptyStatements = (saved) => !(saved.allStatements || []).some((st) => st.lineItems?.some((li) => !li.abstract));

// Parsed reports are cached by accession (small); the raw pages are not kept.
const RESULT_TTL = 24 * 3600 * 1000;
const RESULT_CAP = 400;
const results = new Map(); // accession -> { expires, promise }

export function isCached(accession) {
  const hit = results.get(accession);
  return !!hit && hit.expires > Date.now();
}

export function scrapeFiling(client, filing, company = null) {
  const hit = results.get(filing.accession);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = loadOrScrape(client, filing, company).catch((err) => {
    results.delete(filing.accession);
    throw err;
  });
  results.set(filing.accession, { expires: Date.now() + RESULT_TTL, promise });
  if (results.size > RESULT_CAP) results.delete(results.keys().next().value);
  return promise;
}

// For the background crawler: parse and save a report without pinning the
// result in the in-memory cache. Returns true when something was downloaded.
export async function ensureStored(client, filing, company) {
  if (store.hasFiling(filing.accession)) return false;
  const result = await scrapeUncached(client, filing, company);
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return true;
}

async function loadOrScrape(client, filing, company) {
  const saved = store.getFiling(filing.accession);
  if (saved && !emptyStatements(saved)) return reclassify(saved);
  const result = await scrapeUncached(client, filing, company);
  store.putFiling(filing.accession, filing.cik, result, SCRAPE_VERSION);
  return result;
}

// Consolidated report first (individual first for a company that has no
// subsidiaries); MOPS answers "檔案不存在" for the one that does not exist.
async function scrapeUncached(client, filing, company) {
  const p = parseAccession(filing.accession);
  if (!p) throw Object.assign(new Error(`Not a MOPS report id: ${filing.accession}`), { status: 400 });
  const order = (company?.reportType || filing.reportId) === 'A' ? ['A', 'C'] : ['C', 'A'];
  for (const reportId of order) {
    const html = decodeMops(await client.buffer(mopsUrls(p.code, p.year, p.quarter, reportId).documentUrl));
    if (isMissing(html)) continue;
    const result = parseMopsFiling(html, { code: p.code, year: p.year, quarter: p.quarter, reportId, par: company?.par || 10 });
    clearMissing(filing.accession);
    return result;
  }
  markMissing(filing.accession);
  throw Object.assign(new Error(`MOPS 沒有 ${p.code} ${p.year} 年第 ${p.quarter} 季的 XBRL 財報`), { status: 404, missing: true });
}
