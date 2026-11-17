// One pass of the MOPS crawler, then exit: refresh the TWSE listed-company
// table (a new listing joins the universe, a delisted company's reports are
// dropped), fetch the reports that are out and not saved yet - every listed
// company's newest quarter first, then older ones back to STOCKSCAN_DEPTH
// quarters - until the time budget runs out, and score what came in. The
// scheduled GitHub Actions job runs this and pushes data/store to the data
// ref (refs/data/main) before publishing the static site; it is also how a
// local store is filled:
//
//   npm run fetch:new                     # 40-minute budget
//   npm run fetch:new -- --budget 0       # until everything wanted is saved
//   npm run fetch:new -- --budget 15 --depth 4
import { TwClient } from '../lib/twClient.js';
import { openStore, requireVersion, store } from '../lib/store.js';
import { SCRAPE_VERSION } from '../lib/scrape.js';
import { createCrawler, DEPTH } from '../lib/crawler.js';
import { refreshListed, savedListed, purgeDelisted } from '../lib/twse.js';
import { scoreUnscored } from '../lib/score.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : dflt;
};
const budgetMin = opt('--budget', Number(process.env.STOCKSCAN_FETCH_BUDGET) || 40);
const depth = opt('--depth', DEPTH);

const t0 = Date.now();
const client = new TwClient();
openStore();
requireVersion(SCRAPE_VERSION);
const before = store.filingCount();
try {
  const rows = await refreshListed(client);
  console.log(`fetch-new: TWSE listed companies ${rows.length}`);
  purgeDelisted(rows);
} catch (err) {
  // the saved table still says who is listed; nothing is purged on a failed download
  console.warn(`fetch-new: TWSE listed-company table: ${err.message} - using the saved one (${savedListed()?.value.length ?? 0})`);
  if (!savedListed()) process.exit(1);
}
const crawler = createCrawler(client, { enabled: false });
const r = await crawler.runOnce({ budgetMs: budgetMin * 60_000, depth });
for (const f of r.log.slice(0, 30)) console.log(`fetch-new: ${f.ticker} ${f.name} ${f.fiscalYear} ${f.fiscalPeriod}`);
console.log(
  `fetch-new: ${r.saved} reports saved, ${r.missing} not on MOPS, ${r.failed} failed; ${r.done} of ${r.planned} planned` +
    `${r.budgetExhausted ? ` (budget of ${budgetMin} min used up - the next run continues)` : ''}; store ${before} -> ${store.filingCount()}, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
);
await scoreUnscored({ budgetMs: 5000, log: (m) => console.log(`fetch-new: ${m}`) });
console.log(`fetch-new: done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
