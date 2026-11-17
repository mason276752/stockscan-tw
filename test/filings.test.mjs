// The pieces of the MOPS parser and filing helpers that work without a
// downloaded report: dates in a report's notes, report ids, periods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { datesIn, isMissing } from '../server/lib/mopsFiling.js';
import { accessionOf, parseAccession, filingRecord, deadlineOf, byPeriodDesc } from '../server/lib/filings.js';
import { candidatePeriods, newestPeriod } from '../server/lib/companies.js';

test('board approval dates in ROC, Chinese-numeral and Western forms', () => {
  assert.deepEqual(datesIn('本合併財務報告業已於115年8月11日經本公司董事會核准'), ['2026-08-11']);
  assert.deepEqual(datesIn('業經董事會於民國一一五年七月三十日通過發布'), ['2026-07-30']);
  assert.deepEqual(datesIn('已於民國一一五年二月二十四日經董事會通過'), ['2026-02-24']);
  assert.deepEqual(datesIn('於2026年3月10日經董事會通過'), ['2026-03-10']);
});

test('MOPS "file does not exist" page', () => {
  assert.equal(isMissing("<h4 align = 'center'><font color = 'red'>檔案不存在!</font></h4><br>"), true);
  assert.equal(isMissing(`<html>${'x'.repeat(5000)}</html>`), false);
});

test('report ids and list entries', () => {
  assert.equal(accessionOf('2330', 2026, 2), '2330-2026Q2');
  assert.deepEqual(parseAccession('2330-2026Q2'), { code: '2330', year: 2026, quarter: 2 });
  assert.equal(parseAccession('0001652044-26-000048'), null);
  const q4 = filingRecord('3008', 2025, 4);
  assert.equal(q4.form, 'AR');
  assert.equal(q4.fiscalPeriod, 'FY');
  assert.equal(q4.reportDate, '2025-12-31');
  assert.equal(deadlineOf(2025, 4), '2026-03-31');
  const list = [filingRecord('1', 2025, 4), filingRecord('1', 2026, 1), filingRecord('1', 2025, 3)].sort(byPeriodDesc);
  assert.deepEqual(
    list.map((f) => f.accession),
    ['1-2026Q1', '1-2025Q4', '1-2025Q3'],
  );
});

test('which quarters can be out', () => {
  assert.deepEqual(newestPeriod(new Date('2026-11-17T12:00:00')), { year: 2026, quarter: 3 });
  assert.deepEqual(newestPeriod(new Date('2026-10-05T12:00:00')), { year: 2026, quarter: 2 });
  assert.deepEqual(newestPeriod(new Date('2026-02-01T12:00:00')), { year: 2025, quarter: 4 });
  assert.deepEqual(candidatePeriods({ year: 2026, quarter: 2 }, 2025), [
    { year: 2026, quarter: 2 },
    { year: 2026, quarter: 1 },
    { year: 2025, quarter: 4 },
    { year: 2025, quarter: 3 },
    { year: 2025, quarter: 2 },
    { year: 2025, quarter: 1 },
  ]);
});
