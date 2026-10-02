import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listVersions,
  VersionHistoryError,
} from '../../src/apple/versionFinder';
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
const app = {
  id: 1054598922,
  bundleID: 'com.mcdonalds.gma.cn',
  version: '7.0.41.1',
} as Software;
const success = {
  songList: [{
    metadata: {
      itemId: app.id,
      softwareVersionBundleId: app.bundleID,
      softwareVersionExternalIdentifier: '890951385',
      softwareVersionExternalIdentifiers: ['100', '200', '890951385'],
    },
  }],
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

describe('version history endpoint fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(lookupLatestAppVersion).mockResolvedValue({
      externalVersionId: '890951385',
      version: app.version,
      bundleID: app.bundleID,
    });
    vi.mocked(fetchBag).mockResolvedValue({
      updateURL: 'https://downloaddispatch.itunes.apple.com/up/updateProduct',
    } as Awaited<ReturnType<typeof fetchBag>>);
  });

  it('retries an empty volumeStore response through redownload', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce(response(success));

    await expect(listVersions(account, app)).resolves.toMatchObject({
      versions: ['890951385', '200', '100'],
    });
    const requests = vi.mocked(appleRequest).mock.calls.map(([value]) => value);
    expect(requests).toHaveLength(2);
    expect(requests[1].host).toBe('downloaddispatch.itunes.apple.com');
    expect(parsePlist(requests[0].body!)).toMatchObject({ serialNumber: '0' });
    expect(parsePlist(requests[1].body!)).toMatchObject({
      appExtVrsId: '890951385',
      serialNumber: '0',
    });
  });

  it('recovers an empty redownload HTTP 500 through updateProduct', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce({ ...response({}, 500), body: '' })
      .mockResolvedValueOnce(response(success));

    await expect(listVersions(account, app)).resolves.toHaveProperty(
      'versions.0',
      '890951385',
    );
    const requests = vi.mocked(appleRequest).mock.calls.map(([value]) => value);
    expect(requests[2].path).toBe('/up/updateProduct?guid=AABBCCDDEEFF');
  });

  it('keeps explicit account errors without retrying', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ failureType: '9610' }));
    await expect(listVersions(account, app)).rejects.toMatchObject({
      name: 'VersionHistoryError',
      code: '9610',
    } satisfies Partial<VersionHistoryError>);
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched fallback response', async () => {
    const wrong = structuredClone(success);
    wrong.songList[0].metadata.softwareVersionBundleId = 'com.example.wrong';
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(wrong));
    await expect(listVersions(account, app)).rejects.toThrow(
      'different app or version',
    );
  });
});
