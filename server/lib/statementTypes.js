// Statement classification with no I/O (shared with the browser build): a
// MOPS report has exactly four statements, each in a known section, so the
// parser sets `type` itself; this only picks the four primary ones out.

export const PRIMARY = ['balance_sheet', 'income_statement', 'cash_flow', 'equity'];

// The four primary statements out of every statement in the filing.
export function pickPrimary(all) {
  const primary = Object.fromEntries(PRIMARY.map((k) => [k, null]));
  for (const st of all) if (st.type in primary && !primary[st.type] && !st.parenthetical) primary[st.type] = st;
  return primary;
}

// A saved result whose `statements` are missing (the store keeps only
// allStatements) gets them rebuilt.
export function reclassify(result) {
  if (!result.statements || Object.values(result.statements).some((v) => !v)) result.statements = pickPrimary(result.allStatements || []);
  return result;
}
