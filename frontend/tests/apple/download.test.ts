import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const account = {
  email: 'test@example.com', store: '143465', pod: '25',
  directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', cookies: [],
} as unknown as Account;
const app = { id: 1054598922, version: '7.0.41.1' } as Software;
const success = {
  songList: [{
    URL: 'https://example.apple.com/app.ipa',
    metadata: { bundleShortVersionString: '7.0.41.1', bundleVersion: '123' },
    sinfs: [{ id: 0, sinf: new Uint8Array([1, 2, 3]) }],
  }],
};

function response(data: Record<string, unknown>, status = 200) {
  return {
    status, statusText: '', headers: {} as Record<string, string>,
    rawHeaders: [] as [string, string][], body: buildPlist(data),
  };
}

describe('download endpoint fallback', () => {
  beforeEach(() => vi.resetAllMocks());

  it('keeps a successful primary download to one request', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response(success));
    await expect(getDownloadInfo(account, app)).resolves.toMatchObject({
      output: { downloadURL: success.songList[0].URL, sinfs: [{ id: 0, sinf: 'AQID' }] },
    });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { songList: [] }, { failureType: '5002' }])(
    'retries the same latest app through dispatch after %j', async (empty) => {
      const first = response(empty);
      first.rawHeaders = [['set-cookie', 'session=updated; Domain=.itunes.apple.com; Path=/; Secure']];
      vi.mocked(appleRequest).mockResolvedValueOnce(first).mockResolvedValueOnce(response(success));
      await expect(getDownloadInfo(account, app)).resolves.toMatchObject({
        output: { bundleShortVersionString: '7.0.41.1' },
      });
      const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
      expect(requests).toHaveLength(2);
      expect(requests[1].host).toBe('downloaddispatch.itunes.apple.com');
      expect(parsePlist(requests[1].body!)).toEqual(parsePlist(requests[0].body!));
      expect(requests[1].cookies).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'session', value: 'updated' }),
      ]));
    },
  );

  it('preserves a selected historical version across fallback and pod redirect', async () => {
    const redirect = response({}, 302);
    redirect.headers.location = 'https://p25-buy.itunes.apple.com/r/redownload';
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(response(success));
    await getDownloadInfo(account, app, '987654');
    const payloads = vi.mocked(appleRequest).mock.calls.map(([request]) => parsePlist(request.body!));
    expect(payloads[0].externalVersionId).toBe('987654');
    for (const payload of payloads.slice(1)) {
      expect(payload.appExtVrsId).toBe('987654');
      expect(payload.externalVersionId).toBeUndefined();
    }
  });

  it('stops when both endpoints return no items', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ songList: [] }));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'NO_ITEMS' });
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it.each(['2034', '2042', '9610'])('does not retry explicit Apple error %s', async (code) => {
    vi.mocked(appleRequest).mockResolvedValue(response({ failureType: code }));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves Apple messages without a failure code instead of hiding them', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ customerMessage: 'Item unavailable' }));
    await expect(getDownloadInfo(account, app)).rejects.toThrow('Item unavailable');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry an action response as an empty success', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ action: { url: 'https://buy.itunes.apple.com/termsPage' } }));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'NO_ITEMS' });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('reports HTTP failures without masking them as an empty list', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({}, 503));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'HTTP_503' });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});
