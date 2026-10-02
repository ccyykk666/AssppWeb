import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist } from '../../src/apple/plist';
import { purchaseApp, PurchaseError } from '../../src/apple/purchase';
import { appleRequest } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const account: Account = {
  email: 'test@example.com',
  password: 'password',
  appleId: 'test@example.com',
  store: '143441',
  firstName: 'Test',
  lastName: 'User',
  passwordToken: 'token',
  directoryServicesIdentifier: '123',
  cookies: [],
  deviceIdentifier: 'AABBCCDDEEFF',
};

const app: Software = {
  id: 123456789,
  bundleID: 'com.example.app',
  name: 'Example',
  version: '1.0',
  price: 0,
  artistName: 'Example',
  sellerName: 'Example',
  description: 'Example',
  averageUserRating: 0,
  userRatingCount: 0,
  artworkUrl: '',
  screenshotUrls: [],
  minimumOsVersion: '15.0',
  releaseDate: '2026-01-01',
  primaryGenreName: 'Utilities',
};

function appleResponse(data: Record<string, unknown>) {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    rawHeaders: [] as [string, string][],
    body: buildPlist(data),
  };
}

describe('apple/purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('recovers from one temporary 404 without repeating a successful purchase', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...appleResponse({}), status: 404, body: '<html>Not Found</html>' })
      .mockResolvedValueOnce(appleResponse({ jingleDocType: 'purchaseSuccess', status: 0 }));
    const result = purchaseApp(account, app);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ status: 'acquired' });
    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appleRequest).mock.calls[1][0].body).toBe(vi.mocked(appleRequest).mock.calls[0][0].body);
  });

  it('limits repeated 404 errors and reports the license stage', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest).mockResolvedValue({ ...appleResponse({}), status: 404, body: '' });
    const result = expect(purchaseApp(account, app)).rejects.toMatchObject({ code: 'HTTP_404', message: expect.stringContaining('Apple license') });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry valid business errors or blindly retry long rate limits', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...appleResponse({ failureType: '2034' }), status: 503 });
    await expect(purchaseApp(account, app)).rejects.toMatchObject({ code: 'HTTP_503' });
    expect(appleRequest).toHaveBeenCalledTimes(1);
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...appleResponse({}), status: 429, body: '', headers: { 'retry-after': '60' } });
    await expect(purchaseApp(account, app)).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid success responses instead of reporting a license as acquired', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({ ...appleResponse({}), body: '<html>Unexpected page</html>' });
    await expect(purchaseApp(account, app)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('reports a newly acquired license', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      appleResponse({ jingleDocType: 'purchaseSuccess', status: 0 }),
    );

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      status: 'acquired',
      updatedCookies: [],
    });
  });

  it('uses the game pricing path first for App Store games', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      appleResponse({ jingleDocType: 'purchaseSuccess', status: 0 }),
    );

    await purchaseApp(account, { ...app, primaryGenreId: 6014 });

    expect(vi.mocked(appleRequest).mock.calls[0][0].body).toContain(
      '<string>GAME</string>',
    );
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to the game pricing path when Apple requests it', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(appleResponse({ failureType: '2059' }))
      .mockResolvedValueOnce(
        appleResponse({ jingleDocType: 'purchaseSuccess', status: 0 }),
      );

    await purchaseApp(account, app);

    expect(vi.mocked(appleRequest).mock.calls[0][0].body).toContain(
      '<string>STDQ</string>',
    );
    expect(vi.mocked(appleRequest).mock.calls[1][0].body).toContain(
      '<string>GAME</string>',
    );
  });

  it('reports an existing license from Apple failure type 5002', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      appleResponse({
        failureType: '5002',
        customerMessage: 'An unknown error has occurred',
      }),
    );

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      status: 'alreadyOwned',
      updatedCookies: [],
    });
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('does not misclassify unrelated unknown errors as an existing license', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      appleResponse({
        failureType: '9999',
        customerMessage: 'An unknown error has occurred',
      }),
    );

    await expect(purchaseApp(account, app)).rejects.toMatchObject<PurchaseError>({
      code: '9999',
    });
  });
});
