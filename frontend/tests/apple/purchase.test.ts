import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('reports a newly acquired license', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      appleResponse({ jingleDocType: 'purchaseSuccess', status: 0 }),
    );

    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      status: 'acquired',
      updatedCookies: [],
    });
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
