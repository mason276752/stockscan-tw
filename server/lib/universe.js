// The browse universe: every TWSE-listed company with its industry, straight
// from the listed-company table (twse.js) - biggest first, by market value
// when the market snapshot has it, else by paid-in capital.

import { listedTable } from './twse.js';
import { INDUSTRY, industryInfo } from './industry.js';

export { INDUSTRY, industryInfo };

let memo = null; // { rows, market, value }

export function universeOf(listed, marketByTicker = null, updatedAt = null) {
  const companies = listed.map((r) => ({
    cik: r.cik,
    ticker: r.ticker,
    tickers: [r.ticker],
    name: r.name,
    fullName: r.fullName,
    nameEn: r.nameEn,
    industry: r.industry,
    listedDate: r.listedDate,
    capital: r.capital,
    shares: r.shares,
    par: r.par,
    foreign: r.foreign,
    marketCap: marketByTicker?.[r.ticker]?.marketCap ?? null,
  }));
  companies.sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1) || (b.capital ?? 0) - (a.capital ?? 0) || a.cik - b.cik);
  return { updatedAt: updatedAt || new Date().toISOString(), companies };
}

// the same object back until the listed table or the snapshot changes
export async function getUniverse(client, market = null) {
  const rows = await listedTable(client);
  const byTicker = market?.byTicker || null;
  if (!memo || memo.rows !== rows || memo.market !== byTicker) memo = { rows, market: byTicker, value: universeOf(rows, byTicker) };
  return memo.value;
}
