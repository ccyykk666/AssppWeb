import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiPost } = vi.hoisted(() => ({ apiPost: vi.fn() }));

vi.mock('../../src/api/client', () => ({ apiPost }));

import { signSAPAction } from '../../src/apple/sapSigner';

describe('apple/sapSigner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiPost.mockResolvedValue({ signature: 'c2lnbmF0dXJl' });
  });

  it('sends the exact UTF-8 body to the private signer as base64', async () => {
    const configuration = {
      setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
      certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
      version: 200,
    };

    await expect(
      signSAPAction(
        'AABBCCDDEEFF',
        configuration,
        '<plist>密码</plist>',
      ),
    ).resolves.toBe('c2lnbmF0dXJl');

    expect(apiPost).toHaveBeenCalledWith('/api/sap/sign', {
      guid: 'AABBCCDDEEFF',
      setupURL: configuration.setupURL,
      certificateURL: configuration.certificateURL,
      version: 200,
      body: btoa(
        String.fromCharCode(
          ...new TextEncoder().encode('<plist>密码</plist>'),
        ),
      ),
    });
  });
});
