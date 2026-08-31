import i18n from '../i18n';
import { fetchBag, type SAPConfiguration } from './bag';
import { normalizeDeviceId } from './config';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest, type AppleResponse } from './request';
import { signSAPAction } from './sapSigner';
import type { Account, Cookie } from '../types';

const INVALID_CREDENTIALS_FAILURE = '-5000';
const BAD_LOGIN_MESSAGE = 'MZFinance.BadLogin.Configurator_message';
const AUTHENTICATION_PATH = '/WebObjects/MZFinance.woa/wa/authenticate';
const MAX_REDIRECTS = 3;
const MAX_TRANSPORT_ATTEMPTS = 3;

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function validAuthenticationRedirect(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const appleHost =
      url.hostname === 'buy.itunes.apple.com' ||
      /^p\d+-buy\.itunes\.apple\.com$/.test(url.hostname);
    if (
      url.protocol !== 'https:' ||
      !appleHost ||
      url.pathname !== AUTHENTICATION_PATH
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function transientAuthenticationStatus(status: number): boolean {
  return status === 204 || status === 404 || status >= 500;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendSignedAuthenticationRequest(
  host: string,
  path: string,
  guid: string,
  sap: SAPConfiguration,
  body: string,
  cookies: Cookie[],
): Promise<AppleResponse> {
  let lastResponse: AppleResponse | undefined;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    let signature: string;
    try {
      signature = await signSAPAction(guid, sap, body);
    } catch {
      throw new AuthenticationError(i18n.t('errors.auth.sapUnavailable'));
    }

    const response = await appleRequest({
      method: 'POST',
      host,
      path,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Apple-ActionSignature': signature,
      },
      body,
      cookies,
    });
    lastResponse = response;
    if (!transientAuthenticationStatus(response.status)) {
      return response;
    }
    if (attempt < MAX_TRANSPORT_ATTEMPTS) {
      await sleep(attempt * 250);
    }
  }
  return lastResponse as AppleResponse;
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = '',
): Promise<Account> {
  const guid = normalizeDeviceId(deviceId);
  let bag;
  try {
    bag = await fetchBag(guid);
  } catch {
    throw new AuthenticationError(i18n.t('errors.auth.sapUnavailable'));
  }
  const endpoint = new URL(bag.authURL);
  endpoint.searchParams.set('guid', guid);

  let requestHost = endpoint.hostname;
  let requestPath = `${endpoint.pathname}${endpoint.search}`;
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let redirectCount = 0;
  let redirected = false;
  let attempt = 1;

  while (attempt <= 4) {
    const requestAttempt = redirected ? 1 : attempt;
    const body = buildPlist({
      appleId: email,
      attempt: String(requestAttempt),
      guid,
      password: `${password}${(code ?? '').replace(/\s/g, '')}`,
      rmp: '0',
      why: 'signIn',
    });

    const response = await sendSignedAuthenticationRequest(
      requestHost,
      requestPath,
      guid,
      bag.sap,
      body,
      cookies,
    );
    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers.location;
      const redirect = location
        ? validAuthenticationRedirect(location)
        : undefined;
      if (!redirect) {
        throw new AuthenticationError(i18n.t('errors.auth.invalidRedirect'));
      }
      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new AuthenticationError(i18n.t('errors.auth.tooManyRedirects'));
      }
      requestHost = redirect.hostname;
      requestPath = `${redirect.pathname}${redirect.search}`;
      redirected = true;
      continue;
    }

    if (!response.body.trim()) {
      throw new AuthenticationError(
        i18n.t('errors.auth.emptyBody', { status: response.status }),
      );
    }

    let result: Record<string, any>;
    try {
      result = parsePlist(response.body) as Record<string, any>;
    } catch {
      throw new AuthenticationError(
        i18n.t('errors.auth.invalidResponse', { status: response.status }),
      );
    }

    const failureType = String(result.failureType ?? '');
    const customerMessage = String(result.customerMessage ?? '');
    if (attempt === 1 && failureType === INVALID_CREDENTIALS_FAILURE) {
      attempt++;
      continue;
    }
    if (
      failureType === '' &&
      !code &&
      customerMessage === BAD_LOGIN_MESSAGE
    ) {
      throw new AuthenticationError(
        i18n.t('errors.auth.requiresVerification'),
        true,
      );
    }

    const dialog = result.dialog as Record<string, any> | undefined;
    const failureMessage =
      (dialog?.explanation as string | undefined) ||
      customerMessage ||
      undefined;
    if (failureType) {
      throw new AuthenticationError(
        failureMessage ?? i18n.t('errors.auth.unknownReason'),
      );
    }

    const accountInfo = result.accountInfo as Record<string, any> | undefined;
    const passwordToken = String(result.passwordToken ?? '');
    const dsid = String(result.dsPersonId ?? '');
    if (
      response.status !== 200 ||
      !accountInfo ||
      !passwordToken ||
      !dsid
    ) {
      throw new AuthenticationError(
        failureMessage ?? i18n.t('errors.auth.missingAccountInfo'),
      );
    }

    const storeHeader = response.headers['x-set-apple-store-front'];
    if (!storeHeader) {
      throw new AuthenticationError(i18n.t('errors.auth.missingStoreFront'));
    }
    const address =
      (accountInfo.address as Record<string, any> | undefined) ?? {};

    return {
      email,
      password,
      appleId: String(accountInfo.appleId ?? email),
      store: storeHeader.split('-')[0] ?? '',
      firstName: String(address.firstName ?? ''),
      lastName: String(address.lastName ?? ''),
      passwordToken,
      directoryServicesIdentifier: dsid,
      cookies,
      deviceIdentifier: guid,
      pod: response.headers.pod || undefined,
    };
  }

  throw new AuthenticationError(i18n.t('errors.auth.unknownReason'));
}
