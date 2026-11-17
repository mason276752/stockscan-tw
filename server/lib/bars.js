// Daily OHLC bars and the custom-ETF ("basket") index built from them.
//
// Bars come from TradingView's chart websocket first, then the IBKR TWS API
// when TWS / IB Gateway is running, then Yahoo Finance's chart endpoint; all
// three are split-adjusted so a basket's history is continuous. (The
// valuation page keeps its own Yahoo price history in prices.js - it needs
// the unadjusted quotes of the day.)

import { barStore, mergeDays, settledAt } from './barStore.js';
import { ibConnect, ibConnected, ibDailyBars, ibStatus } from './ib.js';
import { tvDailyBars, tvStatus } from './tvws.js';
import { yahooSymbol } from './prices.js';

const BARS_TTL = 30 * 60 * 1000; // a basket of 30 names is 30 TWS requests; IB allows 60 per 10 minutes
const YEARS = 10;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';

async function yahooDailyBars(ticker, since = null) {
  const symbol = yahooSymbol(ticker);
  const span = since ? { period1: String(Math.floor(Date.parse(since) / 1000)), period2: String(Math.floor(Date.now() / 1000) + 86_400) } : { range: `${YEARS}y` };
  const url = `${YAHOO}${encodeURIComponent(symbol)}?${new URLSearchParams({ ...span, interval: '1d' })}`;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 || attempt >= 2) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res.ok) throw Object.assign(new Error(`Yahoo Finance returned ${res.status} for ${symbol}`), { status: res.status === 404 ? 404 : 502 });
  const body = await res.json();
  const r = body.chart?.result?.[0];
  if (!r) throw Object.assign(new Error(body.chart?.error?.description || `No price data for ${symbol}`), { status: 404 });
  const q = r.indicators?.quote?.[0] || {};
  const days = [];
  (r.timestamp || []).forEach((t, i) => {
    const c = q.close?.[i];
    if (typeof c !== 'number' || c <= 0) return;
    days.push({ date: new Date(t * 1000).toISOString().slice(0, 10), open: q.open?.[i] ?? c, high: q.high?.[i] ?? c, low: q.low?.[i] ?? c, close: c, volume: q.volume?.[i] ?? null });
  });
  return { days, currency: r.meta?.currency || null };
}

// Which sources to try, in order, right now. Probing an absent TWS costs a
// 1.5 s wait, so the answer is kept for a minute - not once per symbol.
let ibProbe = { at: 0, ok: false };
async function sources() {
  const out = [];
  if (tvStatus().enabled) out.push('tv');
  if (ibStatus().enabled) {
    if (!ibConnected() && Date.now() - ibProbe.at > 60_000) ibProbe = { at: Date.now(), ok: await ibConnect(1500) };
    if (ibConnected() || ibProbe.ok) out.push('ib');
  }
  out.push('yahoo');
  return out;
}
const enabledSources = () => [...(tvStatus().enabled ? ['tv'] : []), ...(ibStatus().enabled ? ['ib'] : []), 'yahoo'];

// Daily bars only change while TWSE trades (today's bar is forming); after
// the close nothing moves until the next open. A saved series is fresh for
// BARS_TTL, or - when it was fetched after the last close - until the next
// session opens. (Weekends handled; holidays just refetch once.)
function barsFresh(saved) {
  const fetchedAt = Date.parse(saved?.fetchedAt || 0);
  if (!fetchedAt) return false;
  const now = Date.now();
  if (now - fetchedAt < BARS_TTL) return true;
  // fetched after the last settled close, and no session has opened since then
  return fetchedAt >= lastClose(now) + 15 * 60_000 && now < nextOpen(fetchedAt);
}
// TWSE session bounds: 09:00-13:30 Taipei (UTC+8 all year)
const TPE = 8 * 3_600_000;
function tpeDay(t) {
  const local = t + TPE;
  return { dayStart: local - (local % 86_400_000) - TPE, weekday: new Date(local).getUTCDay() };
}
// the most recent 13:30 Taipei on a weekday at or before t (as a UTC timestamp)
export function lastClose(t) {
  for (let back = 0; back < 7; back++) {
    const { dayStart, weekday } = tpeDay(t - back * 86_400_000);
    if (weekday === 0 || weekday === 6) continue;
    const close = dayStart + 13.5 * 3_600_000;
    if (close <= t) return close;
  }
  return t;
}
// the next 09:00 Taipei on a weekday after t
export function nextOpen(t) {
  for (let ahead = 0; ahead < 7; ahead++) {
    const { dayStart, weekday } = tpeDay(t + ahead * 86_400_000);
    if (weekday === 0 || weekday === 6) continue;
    const open = dayStart + 9 * 3_600_000;
    if (open > t) return open;
  }
  return t;
}
const SOURCE_NAME = { tv: 'TradingView', ib: 'IBKR', yahoo: 'Yahoo Finance' };
const CACHE_KEY = { tv: 'tv2', ib: 'ib', yahoo: 'yahoo' }; // directory per source under data/bars
const OVERLAP = 7; // calendar days re-fetched behind the last saved bar, to check the history still lines up

// the whole series, or (since = 'yyyy-mm-dd') only the bars from that day on
async function fetchFrom(source, symbol, since = null) {
  const calendarDays = since ? Math.ceil((Date.now() - Date.parse(since)) / 86_400_000) + 2 : null;
  if (source === 'tv') {
    const r = await tvDailyBars(symbol, since ? { bars: calendarDays } : {});
    return { symbol, source: 'TradingView', currency: r.currency || 'TWD', resolved: r.resolved, days: since ? r.days.filter((d) => d.date >= since) : r.days };
  }
  if (source === 'ib') return { symbol, source: 'IBKR', currency: 'TWD', days: await ibDailyBars(symbol, since ? { days: calendarDays } : { years: YEARS }) };
  const { days, currency } = await yahooDailyBars(symbol, since);
  return { symbol, source: 'Yahoo Finance', currency, days };
}

// bring a saved series up to date: fetch the tail (with overlap) and splice
// it on; a history that no longer lines up (split since) is fetched whole -
// the store then keeps the old files and records the split (barStore.put)
async function refresh(src, symbol, saved) {
  const last = saved?.days?.at(-1)?.date;
  if (last) {
    const since = new Date(Date.parse(last) - OVERLAP * 86_400_000).toISOString().slice(0, 10);
    const tail = await fetchFrom(src, symbol, since);
    // the last saved bar was still forming if it was fetched during its session (a stop mid-day)
    const unsettled = Date.parse(saved.fetchedAt || 0) < settledAt(last) ? last : null;
    const days = mergeDays(saved.days, tail.days, unsettled);
    if (days) return { ...saved, ...tail, days, fetchedAt: new Date().toISOString(), incremental: tail.days.length };
  }
  const value = await fetchFrom(src, symbol);
  if (!value.days.length) throw Object.assign(new Error(`${SOURCE_NAME[src]}: no daily bars for ${symbol}`), { status: 404 });
  value.fetchedAt = new Date().toISOString();
  return value;
}

// { symbol, source: 'TradingView' | 'IBKR' | 'Yahoo Finance', currency, days: [{ date, open, high, low, close, volume }], fetchedAt }
// A symbol unknown to one source (404) is tried on the next as well: tickers
// differ a little between them.
export async function dailyBars(ticker) {
  const symbol = String(ticker).toUpperCase();
  // a fresh copy from any enabled source answers without touching the network (or TWS)
  for (const src of enabledSources()) {
    const saved = barStore.get(CACHE_KEY[src], symbol);
    if (saved && barsFresh(saved)) return saved;
  }
  const order = await sources();
  let lastErr = null;
  for (const src of order) {
    try {
      const value = await refresh(src, symbol, barStore.get(CACHE_KEY[src], symbol));
      return barStore.put(CACHE_KEY[src], symbol, value);
    } catch (err) {
      lastErr = err;
      const next = order[order.indexOf(src) + 1];
      if (next) console.warn(`bars ${symbol}: ${err.message} - trying ${SOURCE_NAME[next]}`);
    }
  }
  // every source failed: a stale copy beats nothing
  for (const src of order) {
    const saved = barStore.get(CACHE_KEY[src], symbol);
    if (saved) return saved;
  }
  throw lastErr;
}

// For the background bar crawl: bring one symbol's TradingView series up to
// date (whole history the first time, the tail after that), no fallback to
// the other sources. Returns the number of bars fetched (0 = was fresh).
export async function syncTvBars(ticker) {
  const symbol = String(ticker).toUpperCase();
  if (barsFresh({ fetchedAt: barStore.fetchedAt('tv2', symbol) })) return 0;
  const value = await refresh('tv', symbol, barStore.get('tv2', symbol, { keep: false }));
  barStore.put('tv2', symbol, value, { keep: false });
  return value.incremental ?? value.days.length;
}

export { RANGES, basketSeries, stats, rebased } from './basket.js';
