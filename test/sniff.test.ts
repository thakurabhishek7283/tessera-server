import { describe, expect, it } from 'vitest';
import { sniffType } from '../src/modules/uploads/sniff.js';

/** A real 3x2 PNG: file-type reads past the signature to tell PNG from APNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAhNwEA3b0hxgAAAABJRU5ErkJggg==',
  'base64',
);
const latin1 = (s: string) => Buffer.from(s, 'latin1');

describe('sniffType', () => {
  it('recognises common formats by signature', async () => {
    expect(await sniffType(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(
      await sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])),
    ).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
    });
    expect(await sniffType(latin1('GIF89a\u0001\u0000\u0001\u0000'))).toEqual({
      mime: 'image/gif',
      ext: 'gif',
    });
    expect(await sniffType(latin1('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toEqual({
      mime: 'image/webp',
      ext: 'webp',
    });
    expect(await sniffType(latin1('%PDF-1.7\n'))).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('returns undefined for text, scripts and empty input', async () => {
    expect(await sniffType(latin1('<html><script>alert(1)</script></html>'))).toBeUndefined();
    expect(await sniffType(latin1('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(await sniffType(latin1('plain text'))).toBeUndefined();
    expect(await sniffType(Buffer.alloc(0))).toBeUndefined();
  });

  it('is not fooled by a signature that is not at the start', async () => {
    expect(await sniffType(latin1('hello \x89PNG\r\n\x1a\n'))).toBeUndefined();
  });
});
