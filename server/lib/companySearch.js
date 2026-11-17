// Code / company-name suggestions over the listed-company table (no I/O:
// the browser build searches the same rows).

// code prefix first, then the short name, full name or English name
export function searchListed(rows, q, limit = 10) {
  const needle = String(q).trim().toUpperCase();
  if (!needle) return [];
  const starts = rows.filter((r) => r.ticker.startsWith(needle));
  const names = rows.filter((r) => !r.ticker.startsWith(needle) && (r.name.includes(needle) || (r.fullName || '').includes(needle) || (r.nameEn || '').toUpperCase().includes(needle)));
  return [...starts, ...names].slice(0, limit).map((r) => ({ cik: r.cik, ticker: r.ticker, name: r.name, fullName: r.fullName || null, nameEn: r.nameEn || null }));
}
