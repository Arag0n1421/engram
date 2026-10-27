/** The demo clock is explicit UTC. Reject permissive Date.parse calendar repair. */
export function parseUtcTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) return NaN;
  return parsed;
}

/** A date-only expiry is conservatively interpreted at 00:00 UTC on that date. */
export function parseExpiry(value: string | null): number {
  if (value === null) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return parseUtcTimestamp(`${value}T00:00:00Z`);
  return parseUtcTimestamp(value);
}
