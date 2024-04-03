import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_KEYS, parseEnv } from '../src/env.js';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const documented = Object.fromEntries(
  example
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

describe('.env.example', () => {
  it('documents every variable the server reads, and nothing else', () => {
    expect(Object.keys(documented).sort()).toEqual([...ENV_KEYS].sort());
  });

  it('is itself a valid configuration whose values are the defaults', () => {
    expect(parseEnv(documented)).toEqual(parseEnv({}));
  });
});
