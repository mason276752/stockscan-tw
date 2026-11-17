// One MOPS financial report (the Inline XBRL page of 公開資訊觀測站's
// t164sb01) -> the statements JSON the rest of the app reads.
//
// Unlike an SEC filing, the page carries its own layout: each of the four
// primary statements is an HTML table right after <div id="BalanceSheet">
// (StatementOfComprehensiveIncome, StatementsOfCashFlows,
// StatementsOfChangeInEquity) with one row per line - account code, the
// Chinese and English titles (indented with full-width spaces) and an
// ix:nonFraction per column. So there is no taxonomy to download: the row
// order, labels and depth come from the table, the values and periods from
// the facts in its cells and the contexts in the ix:header.
//
// Two Taiwan conventions are normalised into what the statement views
// expect (current.js / quarters.js, written for SEC filings):
//   - the cash flow statement's opening cash (…AtBeginningOfPeriod) is tagged
//     with the period's closing date; it moves to the day before the period
//   - the equity statement opens at the period's first day (AsOf20260101):
//     moved to the day before as well, and its total-equity column
//     (TotalEquityMember) becomes the undimensioned column

import { loadXml, prefixMap, contextsAndUnits, parseNumber, finalizeNumber } from './ixbrl.js';
import { pickPrimary } from './statementTypes.js';
import { accessionOf, formOf, periodOf, periodEndOf, deadlineOf, mopsUrls } from './filings.js';

export const SECTIONS = [
  { id: 'BalanceSheet', type: 'balance_sheet', title: 'Balance Sheet', titleZh: '資產負債表' },
  { id: 'StatementOfComprehensiveIncome', type: 'income_statement', title: 'Statement of Comprehensive Income', titleZh: '綜合損益表' },
  { id: 'StatementsOfCashFlows', type: 'cash_flow', title: 'Statements of Cash Flows', titleZh: '現金流量表' },
  { id: 'StatementsOfChangeInEquity', type: 'equity', title: 'Statements of Change in Equity', titleZh: '權益變動表' },
];

const EQUITY_AXIS = 'ifrs-full:ComponentsOfEquityAxis';
// the equity statement's subtotal rows (D5 本期綜合損益總額 = D1 + D3, Y1
// 權益增加(減少)總額 = every movement): a roll-forward must not add them again
const EQUITY_TOTALS = new Set(['ifrs-full:ComprehensiveIncome', 'ifrs-full:ChangesInEquity']);
const FULL_SPACE = '　';

// MOPS answers a report it does not have with a few bytes of "檔案不存在!"
export const isMissing = (html) => html.length < 4000 && /檔案不存在|查無|不存在/.test(html);

// The page is Big5 (its <meta> says so, whatever the XML declaration claims).
export const decodeMops = (buf) => new TextDecoder('big5').decode(buf);

const clean = (s) => (s || '').replace(/&nbsp;/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
const depthOf = (s) => {
  let n = 0;
  while (s[n] === FULL_SPACE) n++;
  return n;
};
const ymd = (d) => d.replace(/-/g, '');
function prevDay(d) {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
const dateNum = (d) => (d ? Number(d.replace(/-/g, '')) : 0);

// Undimensioned columns first, then grouped by dimension, newest period first.
const dimKey = (c) =>
  Object.entries(c.dimensions)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
function compareContexts(a, b) {
  const da = Object.keys(a.dimensions).length;
  const db = Object.keys(b.dimensions).length;
  if (da !== db) return da - db;
  const ka = dimKey(a);
  const kb = dimKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  const ea = dateNum(a.instant || a.end);
  const eb = dateNum(b.instant || b.end);
  if (ea !== eb) return eb - ea;
  if (!a.instant !== !b.instant) return a.instant ? -1 : 1;
  return dateNum(b.start) - dateNum(a.start);
}

// "115年8月11日", "民國一一五年七月三十日", "2026年2月24日" -> '2026-08-11'
const ZH_DIGIT = { '〇': 0, '○': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
function zhNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  if (!s.includes('十')) return Number([...s].map((c) => ZH_DIGIT[c] ?? '').join('')) || null;
  const [tens, ones] = s.split('十');
  return (tens ? ZH_DIGIT[tens] ?? 0 : 1) * 10 + (ones ? ZH_DIGIT[ones] ?? 0 : 0);
}
export function datesIn(text) {
  const out = [];
  const re = /(?:民國)?\s*([0-9０-９〇○零一二三四五六七八九]{2,4})\s*年\s*([0-9０-９十一二三四五六七八九]{1,3})\s*月\s*([0-9０-９十一二三四五六七八九]{1,3})\s*日/g;
  const half = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  for (const m of text.matchAll(re)) {
    let y = zhNumber(half(m[1]));
    const mo = zhNumber(half(m[2]));
    const d = zhNumber(half(m[3]));
    if (!y || !mo || !d || mo > 12 || d > 31) continue;
    if (y < 1911) y += 1911;
    out.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

// The board's approval date (note 二「通過財務報告之日期及程序」): the first
// date after the period end and within a year of it.
function approvalDate($, periodEnd) {
  const text = $('div[id="DateAndProceduresOfAuthorisationForIssueOfFinancialStatements"]').first().text();
  if (!text) return null;
  const limit = `${Number(periodEnd.slice(0, 4)) + 1}${periodEnd.slice(4)}`;
  return datesIn(text.replace(/\s+/g, '')).find((d) => d > periodEnd && d <= limit) || null;
}

function cellFacts($, td) {
  const out = [];
  $(td)
    .find('ix\\:nonFraction')
    .each((_, el) => {
      const a = el.attribs;
      if (!a.name || !a.contextRef) return;
      const nil = a['xsi:nil'] === 'true';
      const raw = nil ? '' : $(el).text().replace(/\s+/g, ' ').trim();
      out.push({ name: a.name, contextRef: a.contextRef, unitRef: a.unitRef || null, raw, nil, decimals: a.decimals ?? null, scale: a.scale ?? null, sign: a.sign ?? null, format: a.format ?? null, value: nil ? null : finalizeNumber(parseNumber(raw, a.format), a.scale, a.sign) });
    });
  return out;
}

const factJson = (f, units) => {
  const j = { value: f.value, raw: f.raw, unit: f.unitRef ? units[f.unitRef] || f.unitRef : null, decimals: f.decimals, scale: f.scale, sign: f.sign, format: f.format };
  if (f.nil) j.nil = true;
  return j;
};

const spanText = ($, el, lang) => clean($(el).find(`span[class="${lang}"]`).first().text());

function buildStatement($, section, contexts, units) {
  const anchor = $(`div[id="${section.id}"]`).first();
  if (!anchor.length) return null;
  // the section's tables: up to the next anchor (the equity statement has two,
  // this year's and the same period a year earlier)
  const tables = [];
  for (let el = anchor.next(); el.length && !(el.is('div') && el.attr('id')); el = el.next()) if (el.is('table')) tables.push(el);
  if (!tables.length) return null;
  const rows = tables.flatMap((t) => t.children('tr').toArray());
  const dataRows = rows.filter((tr) => $(tr).children('td').length >= 2);

  // equity: the component columns' titles from the header row of titles
  const memberTitles = [];
  if (section.type === 'equity') {
    const titleRow = rows.find((tr) => $(tr).children('th').length > 2 && $(tr).find('span[class="zh"]').length > 2);
    if (titleRow) $(titleRow).children('th').each((_, th) => memberTitles.push({ zh: spanText($, th, 'zh').trim(), en: spanText($, th, 'en').trim() }));
  }

  // pass 1: the facts of every row, and what the remapping needs (each
  // column's duration; every duration start of the equity statement)
  const parsed = dataRows.map((tr) => {
    const tds = $(tr).children('td').toArray();
    const zh = spanText($, tds[1], 'zh') || clean($(tds[1]).text());
    const en = spanText($, tds[1], 'en');
    return { code: clean($(tds[0]).text()).trim(), zh, en, cells: tds.slice(2).map((td) => cellFacts($, td)) };
  });
  const columnDuration = [];
  const durationStarts = new Set();
  for (const r of parsed) {
    r.cells.forEach((facts, j) => {
      for (const f of facts) {
        const c = contexts[f.contextRef];
        if (!c || c.instant) continue;
        columnDuration[j] ||= c;
        durationStarts.add(c.start);
      }
    });
  }

  const memberLabels = {};
  const ctxFor = (f, j, role) => {
    const c = contexts[f.contextRef];
    if (!c) return null;
    let dimensions = { ...c.dimensions };
    if (section.type === 'equity') {
      const m = dimensions[EQUITY_AXIS];
      if (m && /:TotalEquityMember$/.test(m)) delete dimensions[EQUITY_AXIS];
      else if (m && memberTitles[j]) memberLabels[m] ||= memberTitles[j];
    }
    let instant = c.instant;
    if (instant && role === 'start') {
      if (section.type === 'cash_flow' && columnDuration[j]) instant = prevDay(columnDuration[j].start);
      else if (section.type === 'equity' && durationStarts.has(instant)) instant = prevDay(instant);
    }
    const sfx = Object.values(dimensions)
      .map((v) => `_${v.split(':').pop()}`)
      .join('');
    const id = instant ? `AsOf${ymd(instant)}${sfx}` : `From${ymd(c.start)}To${ymd(c.end)}${sfx}`;
    contexts[id] ||= { id, entity: c.entity, instant: instant || null, start: instant ? null : c.start, end: instant ? null : c.end, dimensions };
    return contexts[id];
  };

  // pass 2: line items (equity rows of the comparative year merge into the
  // current year's rows with the same code; a row only the comparative year
  // has goes in after the row before it)
  const items = [];
  const byKey = new Map();
  const used = {};
  let cursor = -1;
  parsed.forEach((r) => {
    const facts = r.cells.flatMap((fs, j) => fs.map((f) => ({ f, j })));
    const concept = facts[0]?.f.name || null;
    const depth = depthOf(r.zh);
    let role = null;
    if (concept && /AtBeginningOfPeriod$/.test(concept)) role = 'start';
    else if (concept && /AtEndOfPeriod$/.test(concept)) role = 'end';
    else if (section.type === 'equity' && facts.length && facts.every(({ f }) => contexts[f.contextRef]?.instant)) {
      role = facts.some(({ f }) => durationStarts.has(contexts[f.contextRef].instant)) ? 'start' : 'end';
    }
    const values = {};
    for (const { f, j } of facts) {
      const ctx = ctxFor(f, j, role);
      if (!ctx) continue;
      used[ctx.id] = ctx;
      values[ctx.id] ??= factJson(f, units);
    }
    const abstract = !concept;
    if (abstract && r.code) return; // a coded line with no amounts in this report
    const key = abstract ? null : `${r.code}|${concept}`;
    const hit = key ? byKey.get(key) : null;
    if (hit) {
      Object.assign(hit.values, values);
      cursor = items.indexOf(hit);
      return;
    }
    const item = {
      concept: concept || `tw:${r.code || 'Heading'}`,
      code: r.code || null,
      label: r.en.trim() || r.zh.trim(),
      labelZh: r.zh.trim(),
      preferredLabel: role === 'start' ? 'periodStartLabel' : role === 'end' ? 'periodEndLabel' : section.type === 'equity' && EQUITY_TOTALS.has(concept) ? 'totalLabel' : null,
      negated: false,
      depth,
      abstract,
      values,
    };
    items.splice(cursor + 1, 0, item);
    cursor++;
    if (key) byKey.set(key, item);
  });

  const columns = Object.values(used)
    .sort(compareContexts)
    .map((c) => ({ id: c.id, period: c.instant ? { instant: c.instant } : { start: c.start, end: c.end }, dimensions: c.dimensions }));
  const members = [...new Set(columns.flatMap((c) => Object.values(c.dimensions)))].sort();
  return {
    type: section.type,
    title: section.title,
    titleZh: section.titleZh,
    role: `tw:${section.id}`,
    parenthetical: false,
    axes: members.length ? { [EQUITY_AXIS]: members } : {},
    memberLabels,
    columns,
    lineItems: items,
  };
}

// Shares from the share capital on the balance sheet (普通股股本 ÷ par value):
// the report has no cover-page share count like an SEC filing's.
function capitalShares(bs, periodEnd, par) {
  if (!bs || !(par > 0)) return [];
  const row = bs.lineItems.find((li) => /:OrdinaryShare$/.test(li.concept)) || bs.lineItems.find((li) => li.concept === 'ifrs-full:IssuedCapital');
  const col = bs.columns.find((c) => c.period.instant === periodEnd && !Object.keys(c.dimensions).length);
  const v = col && row?.values[col.id]?.value;
  return typeof v === 'number' && v > 0 ? [{ end: periodEnd, value: Math.round(v / par), concept: row.concept, basis: 'capital', par, classes: 1 }] : [];
}

// html: the decoded page; { code, year, quarter, reportId } as requested
// from MOPS; par: the company's par value per share (NT$10 for nearly all).
export function parseMopsFiling(html, { code, year, quarter, reportId = 'C', par = 10 }) {
  const start = html.search(/<html\s+xmlns/i);
  const $ = loadXml(start > 0 ? html.slice(start) : html);
  const p = prefixMap($);
  const { contexts, units } = contextsAndUnits($, p);
  const nContexts = Object.keys(contexts).length;
  const allStatements = SECTIONS.map((s) => buildStatement($, s, contexts, units)).filter(Boolean);
  if (!allStatements.some((s) => s.lineItems.some((li) => !li.abstract))) throw Object.assign(new Error(`${code} ${year}Q${quarter}: no statements in the MOPS report`), { status: 502 });

  const header = $('div[class="header"]').first();
  const zhHead = clean(header.find('span[class="zh"]').first().text());
  const enHead = clean(header.find('span[class="en"]').first().text());
  const nameOf = (s) => s.replace(new RegExp(`^\\s*${code}\\s*`), '').replace(/\s*\d{4}(年第\d季|Q\d).*$/, '').trim() || null;
  const periodEnd = periodEndOf(year, quarter);
  const filingDate = approvalDate($, periodEnd) || deadlineOf(year, quarter);
  const facts = allStatements.reduce((n, s) => n + s.lineItems.reduce((m, li) => m + Object.keys(li.values).length, 0), 0);
  const bs = allStatements.find((s) => s.type === 'balance_sheet');
  return {
    fetchedAt: new Date().toISOString(),
    documents: 1,
    filing: {
      cik: Number(code),
      companyName: nameOf(zhHead),
      companyNameEn: nameOf(enHead),
      form: formOf(quarter),
      filingDate,
      periodEnd,
      fiscalYear: String(year),
      fiscalPeriod: periodOf(quarter),
      accession: accessionOf(code, year, quarter),
      reportId,
      consolidated: reportId === 'C',
      unit: clean(anchorUnit($)) || null,
      ...mopsUrls(code, year, quarter, reportId),
    },
    dei: {},
    coverShares: capitalShares(bs, periodEnd, par),
    units,
    statements: pickPrimary(allStatements),
    allStatements,
    stats: { facts, contexts: nContexts, statementRoles: allStatements.length },
  };
}

// "單位：新臺幣仟元" above the balance sheet
const anchorUnit = ($) => $('div[id="BalanceSheet"]').first().next('div').find('span[class="zh"]').first().text();
