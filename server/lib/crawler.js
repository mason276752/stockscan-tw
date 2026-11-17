// Background fetch of every listed company's reports from MOPS, so a report
// page opens instantly and the screener / static site have them.
//
// A pass (runOnce) plans every report wanted - each listed company's newest
// DEPTH quarters, counted back from its latest report on TWSE's table - that
// is neither saved nor known to be missing, newest quarter first across all
// companies (a short pass gets everyone's latest report before anyone's
// older ones; the biggest companies first within a quarter), and fetches
// them a few at a time until the plan or the time budget runs out. So a new
// listing is picked up by the first pass after it appears on TWSE's table,
// a new quarter by the first pass after TWSE lists it, and a fresh store
// fills up over a few passes.
//
// The server runs a pass every half hour at low priority (it waits whenever
// the user is asking for something); the scheduled CI job runs one per run
// with a budget (npm run fetch:new).
//
// MOPS's firewall shuts out a client that asks too fast (a GitHub runner
// downloads ~70 reports a minute and is answered "307" to everything within
// the first minute): reports are started at most one per
// STOCKSCAN_MOPS_INTERVAL ms (default 4000 - 15 a minute, which runs for
// hours untouched), and a refusal pauses the pass (2 minutes, doubling while
// it continues, up to 15) and slows it by half; the refused report goes to
// the back of the queue and is not counted as a failure.

import { store } from './store.js';
import { listedTable, latestPeriods, refreshListed, purgeDelisted } from './twse.js';
import { newestPeriod, candidatePeriods, knownMissing, companyRecord } from './companies.js';
import { filingRecord } from './filings.js';
import { ensureStored } from './scrape.js';
import { scoreAccession } from './score.js';

// quarters per company: three years - the latest, the one before, the same
// quarter a year earlier, whole years for Q4 and the yearly indicators
export const DEPTH = Math.max(1, Number(process.env.STOCKSCAN_DEPTH) || 12);
const PASS_EVERY = 30 * 60 * 1000;
const LISTED_EVERY = 24 * 3600 * 1000;
const MAX_FAILS = 3; // give up on a report that keeps failing to parse
const LOG_EVERY = 60_000;
const INTERVAL = Math.max(0, Number(process.env.STOCKSCAN_MOPS_INTERVAL ?? 4000));
const MAX_INTERVAL = 20_000;
const FIRST_PAUSE = 2 * 60_000;
const MAX_PAUSE = 15 * 60_000;
const MAX_REFUSED_TRIES = 3; // a report refused this many times waits for the next pass
const GIVE_UP_REFUSALS = 60; // refusals in a row without a single download: end the pass

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (p) => p.year * 10 + p.quarter;

// The reports a pass wants, in the order to fetch them.
export function planPass(listed, latest, { depth = DEPTH, fails = {} } = {}) {
  const fallback = newestPeriod();
  const rounds = [];
  for (const c of [...listed].sort((a, b) => (b.capital || 0) - (a.capital || 0))) {
    if (c.industry === '91') continue; // depositary receipts: no Taiwan IFRS reports
    const lp = latest[c.ticker];
    const top = lp || fallback;
    const periods = candidatePeriods(top, top.year - Math.ceil(depth / 4) - 1).slice(0, depth);
    periods.forEach((p, i) => {
      const filing = filingRecord(c.ticker, p.year, p.quarter, { reportId: c.reportType });
      if (store.hasFiling(filing.accession) || (fails[filing.accession] || 0) >= MAX_FAILS) return;
      // a quarter TWSE says is out is asked for even when MOPS said no lately
      if (knownMissing(filing.accession) && !(lp && key(p) === key(lp))) return;
      (rounds[i] ||= []).push({ row: c, filing });
    });
  }
  return rounds.flat();
}

export function createCrawler(client, { prefetcher, enabled = true } = {}) {
  const low = client.lowPriority();
  const state = {
    enabled,
    phase: 'waiting', // waiting | pass | idle
    round: 0,
    total: 0,
    position: 0,
    saved: 0,
    missing: 0,
    failed: 0,
    refused: 0, // MOPS rate-limit answers this pass
    interval: INTERVAL,
    pausedUntil: null,
    current: null,
    lanes: client.parallel || 4,
    depth: DEPTH,
    startedAt: null,
    lastPass: null,
    log: [], // the last reports saved
  };
  const fails = store.getKV('crawl:fails')?.value || {};
  const inFlight = new Set();
  const setCurrent = () => (state.current = inFlight.size ? [...inFlight].join(', ') : null);

  // wait while the user is active or the neighbour prefetcher has work
  async function yieldToUser() {
    while (!client.idle || prefetcher?.status().queued || prefetcher?.status().current) await sleep(1000);
  }

  const n = (x) => x.toLocaleString('en-US');
  const progress = () =>
    console.log(`crawl: 第 ${state.round} 輪 ${n(state.position)} / ${n(state.total)}，新存 ${n(state.saved)}、MOPS 沒有 ${n(state.missing)}、失敗 ${n(state.failed)}${state.refused ? `、被 MOPS 擋 ${n(state.refused)}` : ''}${state.current ? `，目前 ${state.current}` : ''}`);

  // one pass; budgetMs = 0: until the plan is done
  async function runOnce({ budgetMs = 0, depth = DEPTH } = {}) {
    state.phase = 'pass';
    state.round++;
    Object.assign(state, { position: 0, saved: 0, missing: 0, failed: 0, refused: 0, pausedUntil: null });
    const listed = await listedTable(client);
    let latest = {};
    try {
      latest = await latestPeriods(client);
    } catch (err) {
      console.warn(`crawl: TWSE latest quarters unavailable (${err.message}) - using the calendar`);
    }
    const todo = planPass(listed, latest, { depth, fails });
    state.total = todo.length;
    const deadline = budgetMs > 0 ? Date.now() + budgetMs : Infinity;
    const touched = new Set();
    const timer = setInterval(progress, LOG_EVERY);
    let next = 0;
    // pacing: the next report may start at nextStart; a refusal from MOPS
    // pauses everything until pausedUntil
    let nextStart = 0;
    let pausedUntil = 0;
    let pause = 0;
    let refusedInARow = 0;
    const pace = async () => {
      for (;;) {
        const now = Date.now();
        const at = Math.max(nextStart, pausedUntil);
        if (now >= deadline) return false;
        if (at <= now) {
          nextStart = now + state.interval;
          return true;
        }
        if (at >= deadline) return false;
        await sleep(Math.min(at - now, 5000));
      }
    };
    const refused = (task, err) => {
      state.refused++;
      refusedInARow++;
      task.refusals = (task.refusals || 0) + 1;
      if (task.refusals < MAX_REFUSED_TRIES) todo.push(task);
      if (Date.now() < pausedUntil) return; // the other lanes' requests of the same episode
      pause = pause ? Math.min(pause * 2, MAX_PAUSE) : FIRST_PAUSE;
      pausedUntil = Date.now() + pause;
      state.pausedUntil = new Date(pausedUntil).toISOString();
      state.interval = Math.min(Math.round(state.interval * 1.5) || 1000, MAX_INTERVAL);
      console.warn(`crawl: MOPS 拒絕請求（${err.status}），暫停 ${pause / 60000} 分鐘，之後每 ${(state.interval / 1000).toFixed(1)} 秒一份`);
    };
    const lane = async () => {
      while (next < todo.length && Date.now() < deadline && refusedInARow < GIVE_UP_REFUSALS) {
        const task = todo[next++];
        const { row, filing } = task;
        state.position++;
        await yieldToUser();
        if (store.hasFiling(filing.accession)) continue;
        if (!(await pace())) break;
        const label = `${row.ticker} ${filing.fiscalYear} ${filing.fiscalPeriod}`;
        inFlight.add(label);
        setCurrent();
        try {
          if (await ensureStored(low, filing, companyRecord(row, []))) {
            state.saved++;
            refusedInARow = 0;
            pause = 0;
            touched.add(row.cik);
            state.log.unshift({ at: new Date().toISOString(), ticker: row.ticker, name: row.name, cik: row.cik, form: filing.form, fiscalYear: filing.fiscalYear, fiscalPeriod: filing.fiscalPeriod });
            state.log.length = Math.min(state.log.length, 50);
            await scoreAccession(filing.accession, { redoPartial: true }).catch((err) => console.warn(`score ${filing.accession}: ${err.message}`));
          }
        } catch (err) {
          if (err.missing) {
            state.missing++;
            refusedInARow = 0;
          } else if (err.blocked) refused(task, err);
          else {
            state.failed++;
            fails[filing.accession] = (fails[filing.accession] || 0) + 1;
            store.putKV('crawl:fails', fails);
            console.warn(`crawl ${filing.accession} (${row.name}) failed: ${err.message}`);
          }
        } finally {
          inFlight.delete(label);
          setCurrent();
        }
      }
    };
    await Promise.all(Array.from({ length: state.lanes }, lane));
    clearInterval(timer);
    if (refusedInARow >= GIVE_UP_REFUSALS) console.warn(`crawl: MOPS 連續拒絕 ${refusedInARow} 次，這一輪先停，下一輪再接著抓`);
    state.pausedUntil = null;
    // a score that had to do without a neighbouring quarter is redone now
    // that older quarters may have arrived
    for (const cik of touched) {
      for (const r of store.filingIndex(cik)) await scoreAccession(r.accession, { redoPartial: true }).catch(() => {});
    }
    state.lastPass = new Date().toISOString();
    state.phase = 'idle';
    progress();
    return { planned: state.total, done: state.position, saved: state.saved, missing: state.missing, failed: state.failed, refused: state.refused, log: state.log, budgetExhausted: next < todo.length };
  }

  async function run() {
    state.startedAt = new Date().toISOString();
    let listedAt = 0;
    for (;;) {
      try {
        if (Date.now() - listedAt > LISTED_EVERY) {
          purgeDelisted(await refreshListed(client));
          listedAt = Date.now();
        }
        await runOnce();
      } catch (err) {
        console.warn(`crawl pass failed: ${err.message}`);
      }
      await sleep(PASS_EVERY);
    }
  }

  return {
    start() {
      if (enabled) run();
    },
    runOnce,
    status: () => ({ ...state }),
  };
}
