import { authHeaders } from '../api/client';
import { normalizeDeviceId } from './config';
import { parsePlist } from './plist';

export interface SAPConfiguration {
  setupURL: string;
  certificateURL: string;
  version: number;
}

export interface BagOutput {
  authURL: string;
  sap: SAPConfiguration;
}

export class SAPConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SAPConfigurationError';
  }
}

function bagValue(
  root: Record<string, any>,
  urlBag: Record<string, any>,
  key: string,
): unknown {
  return urlBag[key] ?? root[key] ?? urlBag[`loc-${key}`] ?? root[`loc-${key}`];
}

function validAuthenticationURL(value: string): boolean {
  try {
    const url = new URL(value);
    const appleHost =
      url.hostname === 'buy.itunes.apple.com' ||
      /^p\d+-buy\.itunes\.apple\.com$/.test(url.hostname);
    return (
      url.protocol === 'https:' &&
      appleHost &&
      url.pathname === '/WebObjects/MZFinance.woa/wa/authenticate'
    );
  } catch {
    return false;
  }
}

function validSAPURL(value: string, host: string, path: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === host &&
      (path.endsWith('/')
        ? url.pathname.startsWith(path)
        : url.pathname === path)
    );
  } catch {
    return false;
  }
}

export function parseBagConfiguration(xml: string): BagOutput {
  const root = parsePlist(xml) as Record<string, any>;
  const urlBag = (root.urlBag as Record<string, any> | undefined) ?? {};
  const authURL = bagValue(root, urlBag, 'authenticateAccount');
  const setupURL = bagValue(root, urlBag, 'sign-sap-setup');
  const certificateURL = bagValue(root, urlBag, 'sign-sap-setup-cert');
  const versionValue = bagValue(root, urlBag, 'sign-sap-version');
  const version = Number(versionValue);

  if (typeof authURL !== 'string' || !validAuthenticationURL(authURL)) {
    throw new SAPConfigurationError(
      'Apple Bag did not provide a supported authentication endpoint',
    );
  }
  if (
    typeof setupURL !== 'string' ||
    !validSAPURL(
      setupURL,
      'fpinit.itunes.apple.com',
      '/v1/signSapSetup/',
    )
  ) {
    throw new SAPConfigurationError(
      'Apple Bag did not provide a supported SAP setup endpoint',
    );
  }
  if (
    typeof certificateURL !== 'string' ||
    !validSAPURL(
      certificateURL,
      's.mzstatic.com',
      '/sap/setupCert.plist',
    )
  ) {
    throw new SAPConfigurationError(
      'Apple Bag did not provide a supported SAP certificate endpoint',
    );
  }
  if (!Number.isInteger(version) || version !== 200) {
    throw new SAPConfigurationError(
      `Apple Bag advertised unsupported SAP version ${String(versionValue)}`,
    );
  }

  return {
    authURL,
    sap: {
      setupURL,
      certificateURL,
      version,
    },
  };
}

export async function fetchBag(deviceId: string): Promise<BagOutput> {
  const guid = normalizeDeviceId(deviceId);
  const response = await fetch(`/api/bag?guid=${encodeURIComponent(guid)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new SAPConfigurationError(
      `Apple Bag request failed with HTTP ${response.status}`,
    );
  }
  return parseBagConfiguration(await response.text());
}
