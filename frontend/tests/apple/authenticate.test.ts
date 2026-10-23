import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.useRealTimers();
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
    expect(endpoint.pathname).toBe('/WebObjects/MZFinance.woa/wa/authenticate/');
    expect(parsePlist(body)).toMatchObject({
      appleId: 'test@example.com',
      attempt: '4',
      guid: 'AABBCCDDEEFF',
      password: 'password',
    });
    expect(signSAPAction).toHaveBeenCalledWith(
      'AABBCCDDEEFF',
      bag.sap,
      body,
      expect.stringMatching(/^[a-f0-9]{32}$/),
    );
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/x-apple-plist',
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
    ).toBe('4');
  });

  it.each([301, 302, 303, 307, 308])('normalizes relative pod routing on HTTP %s', async (status) => {
    vi.mocked(appleRequest).mockResolvedValueOnce({
      status, statusText: '', body: '', rawHeaders: [],
      headers: { location: '/WebObjects/MZFinance.woa/wa/authenticate?Pod=30&PRH=30' },
    }).mockResolvedValueOnce(successfulResponse());
    await authenticate('redirect@example.com', 'password', undefined, [], 'AABBCCDDEEFF');
    expect(vi.mocked(appleRequest).mock.calls[1][0].path)
      .toBe('/WebObjects/MZFinance.woa/wa/authenticate/?Pod=30&PRH=30');
  });

  it('retries transient Apple edge failures with production backoff', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 500,
        statusText: 'Internal Server Error',
        headers: {},
        rawHeaders: [],
        body: '<html>edge failure</html>',
      })
      .mockResolvedValueOnce({
        status: 404,
        statusText: 'Not Found',
        headers: {},
        rawHeaders: [],
        body: '<html>edge failure</html>',
      })
      .mockResolvedValueOnce(successfulResponse());

    const result = authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'AABBCCDDEEFF',
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(appleRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toMatchObject({
      directoryServicesIdentifier: '123',
    });
    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(signSAPAction).toHaveBeenCalledTimes(3);
  });

  it('honors Retry-After when Apple rate limits authentication', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'retry-after': '2' },
        rawHeaders: [],
        body: '',
      })
      .mockResolvedValueOnce(successfulResponse());

    const result = authenticate(
      'test@example.com',
      'password',
      undefined,
      undefined,
      'AABBCCDDEEFF',
    );

    await vi.advanceTimersByTimeAsync(1999);
    expect(appleRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      directoryServicesIdentifier: '123',
    });
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh signing session for a new sign-in with the same device', async () => {
    await authenticate('fresh@example.com', 'password', undefined, [], 'AABBCCDDEEFF');
    await authenticate('fresh@example.com', 'password', undefined, [], 'AABBCCDDEEFF');
    const calls = vi.mocked(signSAPAction).mock.calls;
    expect(calls[0][3]).not.toBe(calls[1][3]);
  });

  it('retains SAP session, pod redirect and challenge cookies for the 2FA submission', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({
        status: 307, statusText: '', body: '',
        headers: { location: 'https://p30-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate', pod: '30', 'x-set-apple-store-front': '143465-1' },
        rawHeaders: [['set-cookie', 'challenge=fixture; Domain=.itunes.apple.com; Path=/; Secure']],
      })
      .mockResolvedValueOnce({
        ...successfulResponse(), headers: {},
        body: buildPlist({ failureType: '', customerMessage: 'MZFinance.BadLogin.Configurator_message' }),
      })
      .mockResolvedValueOnce({ ...successfulResponse(), headers: {} });
    await expect(authenticate('verify@example.com', 'password', undefined, [], 'AABBCCDDEEFF'))
      .rejects.toMatchObject({ codeRequired: true });
    const result = await authenticate('verify@example.com', 'password', '123 456', [], 'AABBCCDDEEFF');
    const signingCalls = vi.mocked(signSAPAction).mock.calls;
    expect(new Set(signingCalls.map((call) => call[3])).size).toBe(1);
    const final = vi.mocked(appleRequest).mock.calls[2][0];
    expect(final.host).toBe('p30-buy.itunes.apple.com');
    expect(final.cookies).toEqual([expect.objectContaining({ name: 'challenge', value: 'fixture' })]);
    expect(parsePlist(final.body!)).toMatchObject({ attempt: '2', password: 'password123456' });
    expect(result.pod).toBe('30');
    expect(result.store).toBe('143465');
    expect(fetchBag).toHaveBeenCalledTimes(1);
  });

  it('carries intermediate cookies into a bounded retry of an empty 204', async () => {
    vi.useFakeTimers();
    vi.mocked(appleRequest).mockResolvedValueOnce({
      status: 204, statusText: '', headers: {}, body: '',
      rawHeaders: [['set-cookie', 'routing=fixture; Domain=.itunes.apple.com; Path=/; Secure']],
    }).mockResolvedValueOnce(successfulResponse());
    const result = authenticate('retry@example.com', 'password', undefined, [], 'AABBCCDDEEFF');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toHaveProperty('passwordToken', 'token');
    expect(vi.mocked(appleRequest).mock.calls[1][0].cookies)
      .toEqual([expect.objectContaining({ name: 'routing', value: 'fixture' })]);
    expect(vi.mocked(signSAPAction).mock.calls[0][3]).toBe(vi.mocked(signSAPAction).mock.calls[1][3]);
  });

  it('does not retry a structured credential rejection returned with HTTP 403', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({
      ...successfulResponse(), status: 403,
      body: buildPlist({ failureType: '5005', customerMessage: 'Fixture invalid verification code' }),
    });
    await expect(authenticate('invalid@example.com', 'password', '123456', [], 'AABBCCDDEEFF'))
      .rejects.toThrow('Fixture invalid verification code');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('stops after three empty edge responses without logging credentials', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');
    vi.mocked(appleRequest).mockResolvedValue({ status: 204, statusText: '', headers: {}, rawHeaders: [], body: '' });
    const result = authenticate('edge@example.com', 'fixture-secret', undefined, [], 'AABBCCDDEEFF');
    const assertion = expect(result).rejects.toThrow(/VPS outbound network/);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(appleRequest).toHaveBeenCalledTimes(3);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore(); error.mockRestore();
  });

  it('does not shorten a long Retry-After requested by Apple', async () => {
    vi.mocked(appleRequest).mockResolvedValueOnce({
      status: 429, statusText: '', headers: { 'retry-after': '120' }, rawHeaders: [], body: '',
    });
    await expect(authenticate('rate@example.com', 'password', undefined, [], 'AABBCCDDEEFF'))
      .rejects.toThrow(/longer wait/);
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });
});
