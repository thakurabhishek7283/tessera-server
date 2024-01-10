/**
 * Parses a query string, turning `where[field]=v` into `{ where: { field: 'v' } }` so the docs
 * list route can validate filters with one zod schema. Fastify's default parser keeps such keys
 * flat, and a general-purpose library (qs) would be a lot of surface for one bracket form.
 */
export function parseQuery(search: string): Record<string, unknown> {
  const out = new Map<string, unknown>();
  const nested = new Map<string, Map<string, string>>();

  for (const [key, value] of new URLSearchParams(search)) {
    const match = /^([A-Za-z0-9_]+)\[([^\]]+)\]$/.exec(key);
    if (match?.[1] && match[2]) {
      const inner = nested.get(match[1]) ?? new Map<string, string>();
      inner.set(match[2], value);
      nested.set(match[1], inner);
    } else {
      out.set(key, value);
    }
  }
  // fromEntries defines own properties, so a field called `__proto__` cannot touch the prototype.
  for (const [key, inner] of nested) out.set(key, Object.fromEntries(inner));
  return Object.fromEntries(out);
}
