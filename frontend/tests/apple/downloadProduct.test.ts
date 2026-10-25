import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadProduct, dispatchEndpoint } from '../../src/apple/downloadProduct';
import { fetchBag } from '../../src/apple/bag';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { obtainKBSync } from '../../src/apple/kbsync';
import { cachedKBSync, invalidateKBSync } from '../../src/apple/kbsync/cache';
import { lookupLatestAppVersion } from '../../src/api/search';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/kbsync', () => ({
  obtainKBSync: vi.fn(),
  hardwareIDFromDeviceIdentifier: () => Uint8Array.from([170,187,204,221,238,255]),
}));
vi.mock('../../src/apple/kbsync/cache', () => ({ cachedKBSync: vi.fn(), invalidateKBSync: vi.fn() }));
vi.mock('../../src/api/search', () => ({ lookupLatestAppVersion: vi.fn() }));

const endpoint = 'https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download';
const account = { store: '143465', pod: '30', directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', passwordToken: 'fixture-token', cookies: [] } as unknown as Account;
const app = { id: 123, bundleID: 'test.app' } as Software;
const metadata = { itemId: app.id, softwareVersionBundleId: app.bundleID, softwareVersionExternalIdentifier: '200', softwareVersionExternalIdentifiers: ['100','200'] };
const response = (dict: Record<string, unknown>, status = 200) => ({ status, statusText: '', headers: {} as Record<string,string>, rawHeaders: [] as [string,string][], body: buildPlist(dict) });
const success = () => response({ songList: [{ URL: 'https://example.apple.com/app.ipa', metadata }] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchBag).mockResolvedValue({ entDownloadURL: endpoint } as Awaited<ReturnType<typeof fetchBag>>);
  vi.mocked(obtainKBSync).mockResolvedValue('fixture-kbsync');
  vi.mocked(lookupLatestAppVersion).mockResolvedValue({ externalVersionId: '200', bundleID: app.bundleID, version: '2' });
});

describe('preferred ent/download protocol', () => {
  it('uses ipatool headers, account-bound kbsync and the pinned iOS version', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(success());
    const result = await downloadProduct(account, app);
    expect(result.dict.songList[0].metadata.softwareVersionExternalIdentifiers).toEqual(['100','200']);
    expect(obtainKBSync).toHaveBeenCalledWith(account.deviceIdentifier, 123);
    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe('downloaddispatch.itunes.apple.com');
    expect(request.headers).toMatchObject({ 'X-Token': 'fixture-token', 'X-Apple-Store-Front': '143465-1', 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' });
    expect(parsePlist(request.body!)).toMatchObject({ salableAdamId: '123', externalVersionId: '200', kbsync: 'fixture-kbsync', serialNumber: 'VMiwqYjM3e7/' });
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('never resolves latest for an explicitly selected historical version', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(success());
    await downloadProduct(account, app, '200');
    expect(lookupLatestAppVersion).not.toHaveBeenCalled();
  });

  it.each(['2034','2042','9610'])('preserves explicit Apple verdict %s without regenerating or falling back', async (failureType) => {
    vi.mocked(cachedKBSync).mockReturnValue('cached');
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ failureType }));
    await expect(downloadProduct(account, app, '200')).rejects.toMatchObject({ code: failureType });
    expect(obtainKBSync).not.toHaveBeenCalled();
    expect(invalidateKBSync).not.toHaveBeenCalled();
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('replaces a cached blob only once after an unstructured 403', async () => {
    vi.mocked(cachedKBSync).mockReturnValue('cached');
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...response({},403), body: '' }).mockResolvedValueOnce(success());
    await downloadProduct(account, app, '200');
    expect(invalidateKBSync).toHaveBeenCalledOnce();
    expect(obtainKBSync).toHaveBeenCalledOnce();
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects mismatched ent metadata and does not accept it as success', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [{ URL: 'https://example.apple.com/wrong.ipa', metadata: { ...metadata, itemId: 999 } }] }))
      .mockResolvedValueOnce({ ...response({},403), body: '' });
    await expect(downloadProduct(account, app, '200')).rejects.toThrow(/different app or build/);
  });

  it('never forwards X-Token to an ent redirect destination', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...response({},302), headers: { location: 'https://example.test/steal' }, body: '' })
      .mockResolvedValueOnce({ ...response({},403), body: '' });
    await expect(downloadProduct(account, app, '200')).rejects.toThrow();
    for (const [request] of vi.mocked(appleRequest).mock.calls) expect(request.host).not.toBe('example.test');
    expect(vi.mocked(appleRequest).mock.calls[1][0].headers?.['X-Token']).toBeUndefined();
  });

  it.each([endpoint+'?token=x', endpoint+'#x', endpoint.replace('https:','http:'), endpoint.replace('downloaddispatch.itunes.apple.com','evil.test')])('rejects an unsafe bag endpoint: %s', (url) => {
    expect(dispatchEndpoint(url,'ent',account.deviceIdentifier)).toBeUndefined();
  });
});
