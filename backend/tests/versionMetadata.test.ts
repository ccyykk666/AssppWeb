import { afterEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import plist from 'plist';
import { readVersionMetadataFromIpa } from '../src/services/versionMetadata.js';

function createIpa(info: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile('Payload/Test.app/Info.plist', Buffer.from(plist.build(info)));
  zip.addFile('Payload/Test.app/Test', Buffer.from('executable'));
  return zip.toBuffer();
}

function mockRangeFetch(ipa: Buffer) {
  const ranges: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const range = headers.get('range');
      if (!range) return new Response(null, { status: 400 });
      ranges.push(range);

      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) return new Response(null, { status: 416 });
      const start = Number(match[1]);
      const requestedEnd = Number(match[2]);
      const end = Math.min(requestedEnd, ipa.length - 1);
      if (start >= ipa.length) return new Response(null, { status: 416 });

      return new Response(ipa.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${ipa.length}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }),
  );
  return ranges;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('historical IPA version metadata', () => {
  it('reads the version and package release date using HTTP ranges', async () => {
    const ipa = createIpa({
      CFBundleShortVersionString: '14.7.3',
      releaseDate: '2025-06-18T03:04:05Z',
    });
    const ranges = mockRangeFetch(ipa);

    const result = await readVersionMetadataFromIpa(
      'https://cdn.apple.com/path/Test.ipa',
    );

    expect(result).toEqual({
      displayVersion: '14.7.3',
      releaseDate: '2025-06-18T03:04:05.000Z',
      releaseDateSource: 'plist',
    });
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every((range) => range.startsWith('bytes='))).toBe(true);
  });

  it('falls back to the Info.plist archive timestamp', async () => {
    const ipa = createIpa({ CFBundleShortVersionString: '2.1.0' });
    mockRangeFetch(ipa);

    const result = await readVersionMetadataFromIpa(
      'https://updates.apple.com/path/Test.ipa',
    );

    expect(result.displayVersion).toBe('2.1.0');
    expect(result.releaseDateSource).toBe('archive');
    expect(Number.isNaN(Date.parse(result.releaseDate))).toBe(false);
  });

  it('rejects non-Apple URLs before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readVersionMetadataFromIpa('https://example.com/Test.ipa'),
    ).rejects.toThrow('Apple domain');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
