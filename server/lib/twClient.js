// HTTP client for MOPS (公開資訊觀測站) and the TWSE OpenAPI: a few requests
// in flight at once, spaced out, with retries, and a small TTL cache so the
// UI can flip between reports without downloading them again. MOPS serves
// each connection at only ~30 KB/s (a report page is 0.5-2 MB), so the
// parallelism is what decides how fast a backfill goes - and also what
// MOPS sees: STOCKSCAN_MOPS_PARALLEL (default 6) keeps it polite.
//
// Background work (crawler, prefetch) asks with priority 'low' and waits
// while the user is waiting for something.

const MIN_INTERVAL_MS = 250;
const MAX_IN_FLIGHT = Math.max(1, Number(process.env.STOCKSCAN_MOPS_PARALLEL) || 6);
const IDLE_MS = 3000; // low-priority requests wait for this much user quiet
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TwClient {
  constructor({ timeoutMs = 180_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
    this.lastRequest = 0;
    this.inFlight = 0;
    this.waiters = [];
    this.userInFlight = 0;
    this.lastUserActivity = 0;
    this.cache = new Map(); // url -> { expires, value }
    this.parallel = MAX_IN_FLIGHT;
  }

  // Mark user activity (also called by the API layer for cache hits).
  touch() {
    this.lastUserActivity = Date.now();
  }

  get idle() {
    return this.userInFlight === 0 && Date.now() - this.lastUserActivity > IDLE_MS;
  }

  // Serialise request starts so they stay MIN_INTERVAL_MS apart.
  _slot() {
    const run = this.queue.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastRequest);
      if (wait > 0) await sleep(wait);
      this.lastRequest = Date.now();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async _acquire() {
    if (this.inFlight < this.parallel) {
      this.inFlight++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.inFlight++;
  }

  _release() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  // -> the body as bytes (MOPS pages are Big5: the caller decodes)
  async fetch(url, { retries = 4, priority = 'high', headers = {} } = {}) {
    if (priority === 'low') {
      while (!this.idle) await sleep(500);
    } else {
      this.touch();
      this.userInFlight++;
    }
    await this._acquire();
    try {
      return await this._fetchWithRetry(url, retries, headers);
    } finally {
      this._release();
      if (priority !== 'low') {
        this.userInFlight--;
        this.touch();
      }
    }
  }

  async _fetchWithRetry(url, retries, headers) {
    const host = new URL(url).host;
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      await this._slot();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        let res;
        try {
          res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, signal: ctrl.signal });
          if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`${host} returned ${res.status} for ${url}`);
            await sleep(3000 * (attempt + 1));
            continue;
          }
          if (res.status === 404) throw Object.assign(new Error(`Not found: ${url}`), { status: 404 });
          if (!res.ok) throw Object.assign(new Error(`${host} returned ${res.status} for ${url}`), { status: res.status });
          return Buffer.from(await res.arrayBuffer());
        } catch (err) {
          if (err.status) throw err;
          // network hiccup / timeout / a body cut off half way: back off and try again
          lastErr = new Error(`${err.cause?.message || err.message} while fetching ${url}`);
          await sleep(2000 * (attempt + 1));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async _cached(url, ttlMs, loader) {
    if (ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value;
    }
    const value = await loader();
    if (ttlMs > 0) {
      this.cache.set(url, { expires: Date.now() + ttlMs, value });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  buffer(url, { ttlMs = 0, priority } = {}) {
    return this._cached(url, ttlMs, () => this.fetch(url, { priority }));
  }

  text(url, { ttlMs = 0, priority } = {}) {
    return this._cached(url, ttlMs, async () => (await this.fetch(url, { priority })).toString('utf8'));
  }

  json(url, { ttlMs = 0, priority } = {}) {
    return this._cached(url, ttlMs, async () => JSON.parse((await this.fetch(url, { priority })).toString('utf8')));
  }

  // Same client, but every request is low priority.
  lowPriority() {
    return {
      buffer: (url, opts = {}) => this.buffer(url, { ...opts, priority: 'low' }),
      text: (url, opts = {}) => this.text(url, { ...opts, priority: 'low' }),
      json: (url, opts = {}) => this.json(url, { ...opts, priority: 'low' }),
    };
  }
}
