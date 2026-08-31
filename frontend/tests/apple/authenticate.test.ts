import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate } from '../../src/apple/authenticate';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { signSAPAction } from '../../src/apple/sapSigner';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/apple/sapSigner', () => ({ signSAPAction: vi.fn() }));

const bag = {
  authURL:
    'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old',
  sap: {
    setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
    certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
    version: 200,
  },
};

function successfulResponse() {
  return {
    status: 200,
    statusText: 'OK',
    headers: {
      'x-set-apple-store-front': '143465-1,29',
      pod: '42',
    },
    rawHeaders: [] as [string, string][],
    body: buildPlist({
      accountInfo: {
        appleId: 'test@example.com',
        address: { firstName: 'Test', lastName: 'User' },
      },
      passwordToken: 'token',
      dsPersonId: '123',
    }),
  };
}

describe('apple/authenticate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchBag).mockResolvedValue(bag);
    vi.mocked(signSAPAction).mockResolvedValue('c2lnbmF0dXJl');
    vi.mocked(appleRequest).mockResolvedValue(successfulResponse());
  });

  it('signs and sends the exact SAP login body with a canonical GUID', async () => {
    const account = await authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'aa:bb:cc:dd:ee:ff',
    );

    const request = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${request.host}${request.path}`);
    const body = request.body as string;

    expect(endpoint.searchParams.get('guid')).toBe('AABBCCDDEEFF');
    expect(endpoint.searchParams.getAll('guid')).toHaveLength(1);
    expect(endpoint.searchParams.get('foo')).toBe('1');
    expect(parsePlist(body)).toMatchObject({
      appleId: 'test@example.com',
      attempt: '1',
      guid: 'AABBCCDDEEFF',
      password: 'password',
    });
    expect(signSAPAction).toHaveBeenCalledWith(
      'AABBCCDDEEFF',
      bag.sap,
      body,
    );
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Apple-ActionSignature': 'c2lnbmF0dXJl',
    });
    expect(account.deviceIdentifier).toBe('AABBCCDDEEFF');
    expect(account.store).toBe('143465');
    expect(account.pod).toBe('42');
  });

  it('rejects an off-domain redirect before resending credentials', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({
      status: 302,
      statusText: 'Found',
      headers: { location: 'https://example.com/collect' },
      rawHeaders: [],
      body: '',
    });

    await expect(
      authenticate(
        'test@example.com',
        'password',
        undefined,
        undefined,
        'AABBCCDDEEFF',
      ),
    ).rejects.toThrow(/redirect/i);

    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps the original attempt value after an Apple pod redirect', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 302,
        statusText: 'Found',
        headers: {
          location:
            'https://p42-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
        },
        rawHeaders: [],
        body: '',
      })
      .mockResolvedValueOnce(successfulResponse());

    await authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'AABBCCDDEEFF',
    );

    expect(appleRequest).toHaveBeenCalledTimes(2);
    expect(
      parsePlist(vi.mocked(appleRequest).mock.calls[1][0].body as string)
        .attempt,
    ).toBe('1');
  });
});
