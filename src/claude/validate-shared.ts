// Pieces every request check shares: the error type, the running size budget, and two small
// helpers. Kept apart so validate.ts (requests and blocks) and validate-replay.ts (Claude's earlier
// search results and citations) stay small. Pure functions.

export class Invalid extends Error {}

export type Budget = {
  textChars: number;
  opaqueChars: number;
  images: number;
  documents: number;
  searchResults: number;
  citations: number;
};

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function text(value: unknown, budget: { textChars: number }): string {
  if (typeof value !== 'string') throw new Invalid('Text blocks need text.');
  budget.textChars += value.length;
  return value;
}
