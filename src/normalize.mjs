import { clean, graphemeSlice } from './text.mjs';

// One implementation per primitive. The snapshot model, the host task store,
// the evidence adapters and the run summary all read the same producer fields,
// so a value must not mean two different things depending on which module
// normalized it first.

// Host text is cleaned, trimmed, then cut on a grapheme boundary so a
// surrogate pair or ZWJ cluster is never split. Whitespace-only text is
// absent, not an empty string.
export const text = (value, limit = 4096) => {
  if (typeof value !== 'string') return undefined;
  const valueText = clean(value).trim();
  return valueText ? graphemeSlice(valueText, limit) : undefined;
};

export const number = value => (Number.isFinite(value) ? value : undefined);

export const integer = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

export const iso = value => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

export const byteLength = value => Buffer.byteLength(value, 'utf8');

export const defined = object => Object.fromEntries(
  Object.entries(object).filter(([, value]) => value !== undefined),
);
