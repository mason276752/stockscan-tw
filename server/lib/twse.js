// The TWSE listed-company table and which quarter each company has reported
// last, from the TWSE OpenAPI (openapi.twse.com.tw, no key needed):
//
//   t187ap03_L        上市公司基本資料: every company listed on TWSE right now -
//                     code, names, industry, listing date, par value, shares,
//                     consolidated or individual statements. This IS the
//                     universe: a new listing appears here the day it lists
//                     and a delisted company drops out, and every refresh
//                     (daily on the server, every scheduled CI run) follows it.
//   t187ap06_L_<type> 綜合損益表 of the latest reported quarter, one per
//                     industry template (ci 一般業, basi 銀行, bd 證券, fh 金控,
//                     ins 保險, mim 異業): only its 年度 / 季別 are used, to know
//                     which quarter is out for which company.
//
// The table is kept in the kv cache and as data/store/listed.json (in the
// data ref, so a fresh clone or a CI runner that cannot reach TWSE still
// has it).

import { store } from './store.js';

const API = 'https://openapi.twse.com.tw/v1/opendata/';
const LISTED_TTL = 24 * 3600 * 1000;
const LATEST_TTL = 6 * 3600 * 1000;
const LISTED_DOC = 'listed.json';
const TEMPLATES = ['ci', 'basi', 'bd', 'fh', 'ins', 'mim'];

let memo = null;

const date8 = (s) => (/^\d{8}$/.test(String(s || '').trim()) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null);
const num = (s) => {
  const n = Number(String(s ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// "新台幣                 10.0000元" -> 10; a foreign currency par (DRs) -> null
const parOf = (s) => {
  const t = String(s || '').replace(/\s+/g, '');
  const m = /([\d.]+)元/.exec(t);
  return m && /^(新台幣|新臺幣)/.test(t) ? Number(m[1]) : null;
};

function rowOf(r) {
  const code = String(r['公司代號'] || '').trim();
  const foreign = String(r['外國企業註冊地國'] || '').replace(/[－\s-]/g, '') || null;
  return {
    cik: Number(code),
    ticker: code,
    tickers: [code],
    name: String(r['公司簡稱'] || '').trim(),
    fullName: String(r['公司名稱'] || '').trim(),
    nameEn: String(r['英文簡稱'] || '').trim() || null,
    industry: String(r['產業別'] || '').trim().padStart(2, '0') || null,
    listedDate: date8(r['上市日期']),
    foundedDate: date8(r['成立日期']),
    par: parOf(r['普通股每股面額']),
    capital: num(r['實收資本額']),
    shares: num(r['已發行普通股數或TDR原股發行股數']),
    // 編制財務報表類型: 1 = consolidated statements, 2 = individual (no subsidiaries)
    reportType: String(r['編制財務報表類型'] || '').trim() === '2' ? 'A' : 'C',
    foreign,
    chairman: String(r['董事長'] || '').trim() || null,
    website: String(r['網址'] || '').trim() || null,
    auditor: String(r['簽證會計師事務所'] || '').trim() || null,
  };
}

export async function refreshListed(client) {
  const data = await client.json(`${API}t187ap03_L`);
  const rows = data.map(rowOf).filter((r) => /^\d{4,6}$/.test(r.ticker));
  if (!rows.length) throw new Error('TWSE listed-company table is empty');
  rows.sort((a, b) => a.cik - b.cik);
  const updatedAt = new Date().toISOString();
  store.putKV('listed', rows);
  store.putDoc(LISTED_DOC, { updatedAt, companies: rows });
  memo = rows;
  return rows;
}

// The saved table without going to TWSE: the cache first, else the store's
// copy (its age from the updatedAt inside - a git checkout resets mtimes).
export function savedListed() {
  const kv = store.getKV('listed');
  if (kv) return kv;
  const doc = store.getDoc(LISTED_DOC)?.value;
  const rows = Array.isArray(doc?.companies) ? doc.companies : null;
  if (!rows?.length) return null;
  return { value: rows, ageMs: Date.now() - (Date.parse(doc.updatedAt || '') || 0), updatedAt: doc.updatedAt || null };
}

export async function listedTable(client) {
  if (memo) return memo;
  const saved = savedListed();
  if (saved) {
    memo = saved.value;
    if (saved.ageMs > LISTED_TTL && client) refreshListed(client).catch(() => {});
    return memo;
  }
  return refreshListed(client);
}

// code -> { year, quarter } of the latest report TWSE lists for it
export async function latestPeriods(client, { refresh = false } = {}) {
  const saved = store.getKV('latest-periods');
  if (saved && !refresh && saved.ageMs < LATEST_TTL) return saved.value;
  const out = {};
  let ok = 0;
  for (const t of TEMPLATES) {
    try {
      for (const r of await client.json(`${API}t187ap06_L_${t}`)) {
        const code = String(r['公司代號'] || '').trim();
        const roc = Number(r['年度']);
        const quarter = Number(r['季別']);
        if (!code || !roc || !(quarter >= 1 && quarter <= 4)) continue;
        const year = roc + 1911;
        const prev = out[code];
        if (!prev || year * 10 + quarter > prev.year * 10 + prev.quarter) out[code] = { year, quarter };
      }
      ok++;
    } catch (err) {
      console.warn(`twse: t187ap06_L_${t}: ${err.message}`);
    }
  }
  if (!ok) {
    if (saved) return saved.value;
    throw new Error('TWSE latest-quarter tables unavailable');
  }
  store.putKV('latest-periods', out);
  return out;
}

// Delisted companies (no longer in the table) are nothing to buy: throw
// their saved reports and scores away. Only after a fresh, plausible table -
// a truncated download must not empty the store.
const MIN_LISTED = 800;
export function purgeDelisted(rows) {
  if (!Array.isArray(rows) || rows.length < MIN_LISTED) return null;
  const r = store.purgeExcept(rows.map((c) => c.cik));
  if (r.companies) console.log(`store: 移除 ${r.companies} 家已下市公司的 ${r.filings} 份財報（TWSE 上市公司表已無此公司）`);
  return r;
}
