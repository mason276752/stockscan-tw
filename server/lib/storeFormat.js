// The shape of a saved filing file, and how it is turned back into the
// parsed result (shared with the browser build, which reads the same files).

import { pickPrimary } from './statementTypes.js';

// what goes into a filing file: no `statements` (rebuilt from allStatements)
export function slim(result) {
  const { statements, ...rest } = result;
  return rest;
}
export function fatten(result) {
  if (!result.statements) result.statements = pickPrimary(result.allStatements || []);
  return result;
}
