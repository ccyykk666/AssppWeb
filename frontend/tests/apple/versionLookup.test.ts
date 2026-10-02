import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPost } from '../../src/api/client';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { getVersionMetadata } from '../../src/apple/versionLookup';
import type { Account, Software, VersionMetadata } from '../../src/types';

vi.mock('../../src/api/client', () => ({ apiPost: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const account = {
  email: 'test@example.com',
  store: '143465',
  pod: '30',
  directoryServicesIdentifier: '123',
  deviceIdentifier: 'AABBCCDDEEFF',
  cookies: [],
} as unknown as Account;
const app = {
  id: 504274740,
  bundleID: 'com.meituan.imovie',
  version: '9.82.1',
} as Software;
const versionId = '890703400';
const success = {
  songList: [{
    URL: 'https://example.apple.com/app.ipa',
    metadata: {
      itemId: app.id,
      softwareVersionBundleId: app.bundleID,
      softwareVersionExternalIdentifier: versionId,
    },
  }],
};
const resolvedMetadata: VersionMetadata = {
  displayVersion: '9.82.2',
  releaseDate: '2026-09-01T00:00:00.000Z',
};

function response(data: Record<string, unknown>, status = 200) {
  return {
    status,
    statusText: '',
    headers: {} as Record<string, string>,
    rawHeaders: [] as [string, string][],
    body: buildPlist(data),
  };
}

describe('historical version detail fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiPost).mockResolvedValue(resolvedMetadata);
    vi.mocked(fetchBag).mockResolvedValue({
      updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
    } as Awaited<ReturnType<typeof fetchBag>>);
  });

  it('keeps a successful primary lookup to one Apple request', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response(success));
    await expect(getVersionMetadata(account, app, versionId)).resolves
      .toMatchObject({ metadata: resolvedMetadata });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { songList: [] }, { failureType: '5002' }])(
    'retries an empty or retryable response through redownload after %j',
    async (empty) => {
      vi.mocked(appleRequest)
        .mockResolvedValueOnce(response(empty))
        .mockResolvedValueOnce(response(success));

      await expect(getVersionMetadata(account, app, versionId)).resolves
        .toMatchObject({ metadata: resolvedMetadata });
      const requests = vi.mocked(appleRequest).mock.calls.map(([value]) => value);
      expect(requests).toHaveLength(2);
      expect(requests[1].host).toBe('downloaddispatch.itunes.apple.com');
      expect(parsePlist(requests[0].body!)).toMatchObject({
        externalVersionId: versionId,
        serialNumber: '0',
      });
      expect(parsePlist(requests[1].body!)).toMatchObject({
        appExtVrsId: versionId,
        serialNumber: '0',
      });
    },
  );

  it('recovers an empty redownload HTTP 500 through updateProduct', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(response(success));

    await expect(getVersionMetadata(account, app, versionId)).resolves
      .toMatchObject({ metadata: resolvedMetadata });
    const requests = vi.mocked(appleRequest).mock.calls.map(([value]) => value);
    expect(requests[2].path).toBe('/up/updateProduct?guid=AABBCCDDEEFF');
    expect(parsePlist(requests[2].body!)).toMatchObject({
      appExtVrsId: versionId,
    });
  });

  it('does not retry explicit license errors', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ failureType: '9610' }));
    await expect(getVersionMetadata(account, app, versionId)).rejects.toThrow(
      'License required - purchase the app first',
    );
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched fallback metadata', async () => {
    const wrong = structuredClone(success);
    wrong.songList[0].metadata.softwareVersionExternalIdentifier = 'wrong';
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(wrong));
    await expect(getVersionMetadata(account, app, versionId)).rejects.toThrow(
      'different app or version',
    );
    expect(apiPost).not.toHaveBeenCalled();
  });
});
