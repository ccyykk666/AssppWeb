import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { lookupLatestAppVersion } from '../../src/api/search';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/api/search', () => ({ lookupLatestAppVersion: vi.fn() }));

const account = {
  email: 'test@example.com', store: '143465', pod: '25',
  directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', cookies: [],
} as unknown as Account;
const app = { id: 1054598922, bundleID: 'com.mcdonalds.gma.cn', version: '7.0.41.1' } as Software;
const success = {
  songList: [{
    URL: 'https://example.apple.com/app.ipa',
    metadata: {
      bundleShortVersionString: '7.0.41.1', bundleVersion: '123',
      itemId: app.id, softwareVersionBundleId: app.bundleID,
      softwareVersionExternalIdentifier: '890951385',
    },
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
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(lookupLatestAppVersion).mockResolvedValue({
      externalVersionId: '890951385', version: app.version, bundleID: app.bundleID,
    });
    vi.mocked(fetchBag).mockResolvedValue({
      updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
    } as Awaited<ReturnType<typeof fetchBag>>);
  });

  it('keeps a successful primary download to one request', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response(success));
    await expect(getDownloadInfo(account, app)).resolves.toMatchObject({
      output: { downloadURL: success.songList[0].URL, sinfs: [{ id: 0, sinf: 'AQID' }] },
    });
    expect(appleRequest).toHaveBeenCalledTimes(1);
    expect(lookupLatestAppVersion).not.toHaveBeenCalled();
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
      expect(parsePlist(requests[1].body!)).toEqual({
        ...parsePlist(requests[0].body!), appExtVrsId: '890951385',
      });
      expect(lookupLatestAppVersion).toHaveBeenCalledWith(app.id, 'CN');
      expect(requests[1].cookies).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'session', value: 'updated' }),
      ]));
    },
  );

  it('preserves a selected historical version across fallback and pod redirect', async () => {
    const redirect = response({}, 302);
    redirect.headers.location = 'https://p25-buy.itunes.apple.com/r/redownload';
    const historical = { songList: [{ ...success.songList[0], metadata: {
      ...success.songList[0].metadata, softwareVersionExternalIdentifier: '987654',
    } }] };
    vi.mocked(appleRequest).mockReset()
      .mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(response(historical));
    await getDownloadInfo(account, app, '987654');
    expect(lookupLatestAppVersion).not.toHaveBeenCalled();
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

  it('recovers empty redownload HTTP 500 through the bag update endpoint', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ authorized: false, songList: [] }))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(response(success));
    await expect(getDownloadInfo(account, app)).resolves.toHaveProperty('output.downloadURL');
    const requests = vi.mocked(appleRequest).mock.calls.map(([r]) => r);
    expect(requests).toHaveLength(3);
    expect(requests[2].path).toBe('/up/updateProduct?guid=AABBCCDDEEFF');
    expect(parsePlist(requests[2].body!)).toMatchObject({
      appExtVrsId: '890951385', serialNumber: '0', salableAdamId: app.id,
    });
    expect(parsePlist(requests[2].body!)).toEqual(parsePlist(requests[1].body!));
  });

  it('keeps an explicitly selected history build through update fallback', async () => {
    const historical = { songList: [{ ...success.songList[0], metadata: {
      ...success.songList[0].metadata, softwareVersionExternalIdentifier: '987654',
    } }] };
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(response(historical));
    await getDownloadInfo(account, app, '987654');
    expect(lookupLatestAppVersion).not.toHaveBeenCalled();
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[2][0].body!).appExtVrsId).toBe('987654');
  });

  it.each([403, 429, 503])('never uses update for redownload HTTP %s', async (status) => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce({ ...response({}, status), body: '' });
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: `HTTP_${status}` });
    expect(fetchBag).not.toHaveBeenCalled();
  });

  it('does not retry nonempty HTTP 500 responses', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce(response({ customerMessage: 'Maintenance' }, 500));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'HTTP_500' });
    expect(fetchBag).not.toHaveBeenCalled();
  });

  it('stops after one update attempt', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValue({ ...response({}, 500), body: '' });
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'HTTP_500' });
    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(fetchBag).toHaveBeenCalledTimes(1);
  });

  it('does not use an update endpoint absent from the validated bag', async () => {
    vi.mocked(fetchBag).mockResolvedValue({} as Awaited<ReturnType<typeof fetchBag>>);
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValue({ ...response({}, 500), body: '' });
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'HTTP_500' });
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it.each(['itemId', 'softwareVersionBundleId', 'softwareVersionExternalIdentifier'])(
    'rejects a mismatched %s from update', async (key) => {
      const wrong = structuredClone(success);
      (wrong.songList[0].metadata as Record<string, unknown>)[key] = 'wrong';
      vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
        .mockResolvedValueOnce({ ...response({}, 500), body: '' })
        .mockResolvedValueOnce(response(wrong));
      await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'MISMATCHED_ITEM' });
    },
  );

  it('preserves structured Apple errors from update', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(response({ failureType: '9610' }));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: '9610' });
  });

  it('stops instead of guessing a current build if the catalog has no entry', async () => {
    vi.mocked(lookupLatestAppVersion).mockResolvedValue(null);
    vi.mocked(appleRequest).mockResolvedValue(response({ songList: [] }));
    await expect(getDownloadInfo(account, app)).rejects.toMatchObject({ code: 'LATEST_VERSION_UNAVAILABLE' });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});
