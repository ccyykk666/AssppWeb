import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchBag,
  parseBagConfiguration,
  SAPConfigurationError,
} from '../../src/apple/bag';
import { buildPlist } from '../../src/apple/plist';

const validBag = {
  urlBag: {
    authenticateAccount:
      'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
    'sign-sap-setup':
      'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
    'sign-sap-setup-cert':
      'https://s.mzstatic.com/sap/setupCert.plist',
    'sign-sap-version': '200',
  },
};

describe('apple/bag', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the complete SAP configuration advertised by Apple', () => {
    expect(parseBagConfiguration(buildPlist(validBag))).toEqual({
      authURL:
        'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      sap: {
        setupURL:
          'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
        certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
        version: 200,
      },
    });
  });

  it('accepts the loc-prefixed SAP keys used by current Apple bags', () => {
    const bag = {
      urlBag: {
        authenticateAccount:
          'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
        'loc-sign-sap-setup':
          'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
        'loc-sign-sap-setup-cert':
          'https://s.mzstatic.com/sap/setupCert.plist',
        'loc-sign-sap-version': '200',
      },
    };
    expect(parseBagConfiguration(buildPlist(bag)).sap.version).toBe(200);
  });

  it('rejects missing or untrusted SAP endpoints', () => {
    expect(() =>
      parseBagConfiguration(
        buildPlist({
          urlBag: {
            ...validBag.urlBag,
            'sign-sap-setup': 'https://example.com/sign',
          },
        }),
      ),
    ).toThrow(SAPConfigurationError);
  });

  it('requests the bag with a canonical uppercase GUID', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => buildPlist(validBag),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchBag('aa:bb:cc:dd:ee:ff');

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/bag?guid=AABBCCDDEEFF',
    );
  });
});
