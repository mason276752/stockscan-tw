// The valuation page on the server: buildValuation (shared with the static
// build) fed with what only the server can fetch - reports from MOPS, prices
// from the bar sources, FX rates from Yahoo. Share counts travel inside each
// saved report (share capital ÷ par value), so there is no extra index.
import { scrapeFiling } from './scrape.js';
import { history } from './prices.js';
import { priceSeries } from './priceSeries.js';
import { buildValuation } from './valuation.js';

export const serverValuation = (client, company, opts) =>
  buildValuation(company, opts, {
    load: (f) => scrapeFiling(client, f, company),
    shares: async () => ({ version: 2, byAccn: {}, list: [] }),
    prices: priceSeries,
    fx: history,
  });
