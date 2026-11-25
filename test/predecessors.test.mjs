// A holding company set up by share exchange has its predecessor's reports
// for the quarters before it existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, store } from '../server/lib/store.js';
import { PREDECESSORS, asSuccessors, reportOf, unmapped } from '../server/lib/predecessors.js';
import { savedFilings } from '../server/lib/companies.js';
import { planPass } from '../server/lib/crawler.js';
import { purgeDelisted } from '../server/lib/twse.js';
import { accessionOf, formOf, periodEndOf, periodOf } from '../server/lib/filings.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockscan-tw-predecessors-'));
openStore(path.join(tmp, 'store'), path.join(tmp, 'cache.sqlite'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// as TWSE's table has them
const row = (ticker, name, foundedDate, listedDate = foundedDate, extra = {}) => ({ cik: Number(ticker), ticker, name, foundedDate, listedDate, industry: '22', reportType: 'C', capital: 1, par: 10, ...extra });
const HOLDING = row('3716', '中化控股', '2024-09-02');
const PLAIN = row('2330', '台積電', '1987-02-21', '1994-09-05');

// a saved report, as small as they come
const report = (code, year, quarter, { eps = 0.27, shares = 298081100 } = {}) => {
  const value = (v, unit) => ({ c1: { value: v, raw: String(v), unit } });
  const st = (type, lineItems) => ({ type, title: type, role: type, parenthetical: false, axes: {}, columns: [{ id: 'c1', period: { instant: periodEndOf(year, quarter) }, dimensions: {} }], lineItems });
  const line = (concept, v, unit) => ({ concept, label: concept, depth: 0, abstract: false, negated: false, values: value(v, unit) });
  const allStatements = [st('balance_sheet', [line('ifrs-full:Assets', 12556303000, 'TWD')]), st('income_statement', [line('ifrs-full:BasicEarningsLossPerShare', eps, 'TWD/shares'), line('tw:PendingShares', 100, 'shares')])];
  return {
    fetchedAt: '2026-01-01T00:00:00Z',
    documents: 1,
    filing: { cik: Number(code), companyName: '中國化學製藥股份有限公司', form: formOf(quarter), filingDate: '2024-08-06', periodEnd: periodEndOf(year, quarter), fiscalYear: String(year), fiscalPeriod: periodOf(quarter), accession: accessionOf(code, year, quarter), reportId: 'C' },
    dei: {},
    coverShares: [{ end: periodEndOf(year, quarter), value: shares, concept: 'tifrs-bsci-ci:OrdinaryShare', basis: 'capital', par: 10, classes: 1 }],
    units: {},
    statements: { balance_sheet: allStatements[0], income_statement: allStatements[1], cash_flow: null, equity: null },
    allStatements,
    stats: { facts: 3, contexts: 1, statementRoles: 2 },
  };
};

test('a quarter that ended before the company existed is its predecessor’s report', () => {
  const q2 = reportOf(HOLDING, 2024, 2);
  assert.equal(q2.accession, '1701-2024Q2');
  assert.equal(q2.cik, 3716, 'in the holding company’s list');
  assert.match(q2.documentUrl, /CO_ID=1701&SYEAR=2024&SSEASON=2/, 'where MOPS has it');
  assert.equal(reportOf(HOLDING, 2024, 3).accession, '3716-2024Q3', 'the quarter it was set up in is its own');
  assert.equal(reportOf(PLAIN, 1990, 1).accession, '2330-1990Q1', 'a company founded and listed the usual way is left alone');
  assert.equal(reportOf(PLAIN, 2024, 2).cik, 2330);
});

test('per-share amounts and share counts go over to the new share; money does not change', () => {
  const r = asSuccessors(report('1701', 2024, 2), 3716);
  assert.deepEqual(r.filing.predecessor, { code: '1701', name: '中國化學製藥股份有限公司', per: 2 });
  assert.equal(r.filing.cik, 3716);
  const is = r.statements.income_statement.lineItems;
  assert.equal(is[0].values.c1.value, 0.54, 'two old shares for one new');
  assert.equal(is[1].values.c1.value, 50);
  assert.equal(r.coverShares[0].value, 149040550);
  assert.equal(r.statements.balance_sheet.lineItems[0].values.c1.value, 12556303000);
  // 中化: six months at 0.63 and three at 0.49 are the 1.75 the holding company reports for nine
  assert.equal(0.63 * PREDECESSORS[3716].per + 0.49, 1.75);
  assert.equal(asSuccessors(r, 3716).statements.income_statement.lineItems[0].values.c1.value, 0.54, 'not twice');
  const even = asSuccessors(report('6288', 2025, 2, { eps: -0.53 }), 3717);
  assert.equal(even.statements.income_statement.lineItems[0].values.c1.value, -0.53, 'one for one');
  const own = report('2330', 2024, 2);
  assert.equal(asSuccessors(own, 2330).filing.predecessor, undefined);
});

test('the crawler asks for the predecessor’s reports, and lists them when they are saved', () => {
  const plan = planPass([HOLDING], { 3716: { year: 2024, quarter: 4 } }, { depth: 5 }).map((t) => t.filing.accession);
  assert.deepEqual(plan, ['3716-2024Q4', '3716-2024Q3', '1701-2024Q2', '1701-2024Q1', '1701-2023Q4']);
  store.putFiling('1701-2024Q1', 3716, asSuccessors(report('1701', 2024, 1), 3716), 1);
  assert.ok(!planPass([HOLDING], { 3716: { year: 2024, quarter: 4 } }, { depth: 5 }).some((t) => t.filing.accession === '1701-2024Q1'), 'saved: not asked for again');
  assert.deepEqual(savedFilings(3716).map((f) => [f.accession, f.cik, f.fiscalPeriod]), [['1701-2024Q1', 3716, 'Q1']]);
});

test('a predecessor that leaves the table hands its reports over; any other is dropped', () => {
  store.putFiling('1701-2023Q4', 1701, report('1701', 2023, 4), 1);
  store.putFiling('9999-2023Q4', 9999, report('9999', 2023, 4), 1);
  // a full table (a short one purges nothing), the predecessor still in it
  const others = Array.from({ length: 900 }, (_, i) => row(String(10000 + i), 'x', '1990-01-01', '2000-01-01'));
  purgeDelisted([...others, HOLDING, row('1701', '中化', '1952-01-01', '1962-01-01')]);
  assert.ok(store.filingIndex(1701).length, 'listed: its own');
  assert.equal(store.filingIndex(9999).length, 0);
  purgeDelisted([...others, HOLDING]);
  assert.equal(store.filingIndex(1701).length, 0);
  assert.deepEqual(store.filingIndex(3716).map((r) => r.accession).sort(), ['1701-2023Q4', '1701-2024Q1']);
  const h = store.filingHeader('1701-2023Q4');
  assert.deepEqual([h.cik, h.predecessor.code], [3716, '1701']);
  assert.equal(store.getFiling('1701-2023Q4').coverShares[0].value, 149040550, 'on the new share’s basis');
});

test('a company listed the day it was set up, with no predecessor written down, is named', () => {
  const now = Date.parse('2027-02-01');
  const fresh = row('3718', '某某投控', '2027-01-04');
  const rows = [HOLDING, PLAIN, fresh, row('3711', '日月光投控', '2018-04-30'), row('6863', '永道-KY', '2021-10-21', '2023-03-21'), row('910322', 'DR', '2026-12-01', '2026-12-01', { industry: '91' })];
  assert.deepEqual(unmapped(rows, now).map((r) => r.ticker), ['3718']);
});
