import i18n from '../i18n';
import { fetchBag,type SAPConfiguration } from './bag';
import { normalizeDeviceId,normalizeLegacyAuthURL } from './config';
import { extractAndMergeCookies } from './cookies';
import { buildPlist,parsePlist } from './plist';
import { appleRequest,type AppleResponse } from './request';
import { signSAPAction } from './sapSigner';
import { abortableDelay,requestScope,throwIfAborted } from '../utils/abort';
import type { Account,Cookie } from '../types';

const INVALID_CREDENTIALS_FAILURE='-5000';
const BAD_LOGIN_MESSAGE='MZFinance.BadLogin.Configurator_message';
const AUTHENTICATION_PATH='/WebObjects/MZFinance.woa/wa/authenticate/';
const MAX_REDIRECTS=3;
const MAX_TRANSPORT_ATTEMPTS=3;
const AUTHENTICATION_RETRY_DELAY_MS=10_000;
const MAX_AUTHENTICATION_RETRY_DELAY_MS=30_000;
const VERIFICATION_SESSION_TTL_MS=10*60*1000;
const MAX_VERIFICATION_SESSIONS=8;

interface AuthenticationSession {
  id: string;
  endpoint: URL;
  sap: SAPConfiguration;
  cookies: Cookie[];
  storeFront?: string;
  pod?: string;
  expiresAt: number;
}

// Keep only a pending 2FA exchange, never its password or serialized body.
// Every new sign-in gets fresh SAP state; its code submission reuses that state.
const verificationSessions=new Map<string,AuthenticationSession>();

function parseAuthenticationDictionary(body: string): Record<string,any>|undefined {
  try {
    const value=parsePlist(body);
    return value&&typeof value==='object'&&!Array.isArray(value)? value:undefined;
  } catch {
    return undefined;
  }
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean=false,
  ) {
    super(message);
    this.name='AuthenticationError';
  }
}

function validAuthenticationRedirect(value: string,base?: URL): URL|undefined {
  try {
    const url=normalizeLegacyAuthURL(value,base);
    const appleHost=
      url.hostname==='buy.itunes.apple.com'||
      /^p\d+-buy\.itunes\.apple\.com$/.test(url.hostname);
    if(
      url.protocol!=='https:'||
      url.username||url.password||url.hash||
      (url.port!==''&&url.port!=='443')||
      !appleHost||
      url.pathname!==AUTHENTICATION_PATH
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function transientAuthenticationStatus(status: number): boolean {
  return status===204||status===403||status===404||status===429||status>=500;
}

function authenticationRetryDelay(
  response: AppleResponse,
  attempt: number,
): number {
  const fallback=Math.min(
    AUTHENTICATION_RETRY_DELAY_MS*2**(attempt-1),
    MAX_AUTHENTICATION_RETRY_DELAY_MS,
  );
  const retryAfter=response.headers['retry-after']?.trim();
  if(!retryAfter) return fallback;

  const seconds=Number(retryAfter);
  const requested=Number.isFinite(seconds)
    ? seconds*1000
    :Date.parse(retryAfter)-Date.now();
  if(!Number.isFinite(requested)||requested<0) return fallback;

  if(requested>MAX_AUTHENTICATION_RETRY_DELAY_MS) {
    throw new AuthenticationError(i18n.t('errors.auth.rateLimited'));
  }
  return Math.max(requested,1000);
}

async function sendSignedAuthenticationRequest(
  host: string,
  path: string,
  guid: string,
  session: AuthenticationSession,
  body: string,
  signal?: AbortSignal,
): Promise<AppleResponse> {
  let lastResponse: AppleResponse|undefined;
  for(let attempt=1;attempt<=MAX_TRANSPORT_ATTEMPTS;attempt++) {
    let signature: string;
    try {
      signature=await signSAPAction(guid,session.sap,body,session.id,signal);
    } catch {
      throwIfAborted(signal);
      throw new AuthenticationError(i18n.t('errors.auth.sapUnavailable'));
    }

    const response=await appleRequest({
      method: 'POST',
      host,
      path,
      headers: {
        'Content-Type': 'application/x-apple-plist',
        'X-Apple-ActionSignature': signature,
      },
      body,
      cookies: session.cookies,
      signal,
    });
    session.cookies=extractAndMergeCookies(response.rawHeaders,session.cookies);
    session.storeFront=response.headers['x-set-apple-store-front']||session.storeFront;
    session.pod=response.headers.pod||session.pod;
    lastResponse=response;
    const dictionary=parseAuthenticationDictionary(response.body);
    // Populated credential/2FA errors are not transient network refusals.
    const hasVerdict=dictionary&&(
      dictionary.failureType||dictionary.customerMessage||
      dictionary.accountInfo||dictionary.passwordToken||dictionary.dialog
    );
    if(!transientAuthenticationStatus(response.status)||hasVerdict) {
      return response;
    }
    if(attempt<MAX_TRANSPORT_ATTEMPTS) {
      await abortableDelay(authenticationRetryDelay(response,attempt),signal);
    }
  }
  return lastResponse as AppleResponse;
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string='',
  signal?: AbortSignal,
): Promise<Account> {
  const scope=requestScope(signal,180_000);
  try {
    const guid=normalizeDeviceId(deviceId);
    const sessionKey=`${email.trim().toLowerCase()}:${guid}`;
    for(const [key,pending] of verificationSessions) {
      if(pending.expiresAt<=Date.now()) verificationSessions.delete(key);
    }
    let session=code? verificationSessions.get(sessionKey):undefined;
    if(!code) verificationSessions.delete(sessionKey);
    if(!session) {
      let bag;
      try {
        bag=await fetchBag(guid,scope.signal);
      } catch {
        throwIfAborted(scope.signal);
        throw new AuthenticationError(i18n.t('errors.auth.sapUnavailable'));
      }
      const endpoint=validAuthenticationRedirect(bag.authURL);
      if(!endpoint) throw new AuthenticationError(i18n.t('errors.auth.invalidRedirect'));
      endpoint.searchParams.set('guid',guid);
      const bytes=crypto.getRandomValues(new Uint8Array(16));
      session={
        id: Array.from(bytes,(value) => value.toString(16).padStart(2,'0')).join(''),
        endpoint,sap: bag.sap,cookies: [...(existingCookies??[])],
        expiresAt: Date.now()+VERIFICATION_SESSION_TTL_MS,
      };
    }

    let redirectCount=0;
    let attempt=1;

    while(attempt<=4) {
      const body=buildPlist({
        appleId: email,
        // Match the current Swift reference: sign-in=4, verification=2.
        attempt: code? '2':'4',
        guid,
        password: `${password}${(code??'').replace(/\s/g,'')}`,
        rmp: '0',
        why: 'signIn',
      });

      const response=await sendSignedAuthenticationRequest(
        session.endpoint.hostname,
        `${session.endpoint.pathname}${session.endpoint.search}`,
        guid,
        session,
        body,
        scope.signal,
      );

      if([301,302,303,307,308].includes(response.status)) {
        const location=response.headers.location;
        const redirect=location
          ? validAuthenticationRedirect(location,session.endpoint)
          :undefined;
        if(!redirect) {
          throw new AuthenticationError(i18n.t('errors.auth.invalidRedirect'));
        }
        redirectCount++;
        if(redirectCount>MAX_REDIRECTS) {
          throw new AuthenticationError(i18n.t('errors.auth.tooManyRedirects'));
        }
        session.endpoint=redirect;
        continue;
      }

      const result=parseAuthenticationDictionary(response.body);
      if(!result) {
        throw new AuthenticationError(
          i18n.t('errors.auth.unusableResponse',{ status: response.status }),
        );
      }

      const failureType=String(result.failureType??'');
      const customerMessage=String(result.customerMessage??'');
      if(attempt===1&&failureType===INVALID_CREDENTIALS_FAILURE) {
        attempt++;
        continue;
      }
      if(
        failureType===''&&
        !code&&
        customerMessage===BAD_LOGIN_MESSAGE
      ) {
        if(verificationSessions.size>=MAX_VERIFICATION_SESSIONS&&
          !verificationSessions.has(sessionKey)) {
          verificationSessions.delete(verificationSessions.keys().next().value!);
        }
        verificationSessions.set(sessionKey,session);
        throw new AuthenticationError(
          i18n.t('errors.auth.requiresVerification'),
          true,
        );
      }

      const dialog=result.dialog as Record<string,any>|undefined;
      const failureMessage=
        (dialog?.explanation as string|undefined)||
        customerMessage||
        undefined;
      if(failureType) {
        throw new AuthenticationError(
          failureMessage??i18n.t('errors.auth.unknownReason'),
        );
      }

      const accountInfo=result.accountInfo as Record<string,any>|undefined;
      const passwordToken=String(result.passwordToken??'');
      const dsid=String(result.dsPersonId??'');
      if(
        response.status!==200||
        !accountInfo||
        !passwordToken||
        !dsid
      ) {
        throw new AuthenticationError(
          failureMessage??i18n.t('errors.auth.missingAccountInfo'),
        );
      }

      const storeHeader=session.storeFront;
      if(!storeHeader) {
        throw new AuthenticationError(i18n.t('errors.auth.missingStoreFront'));
      }
      const address=
        (accountInfo.address as Record<string,any>|undefined)??{};

      verificationSessions.delete(sessionKey);
      return {
        email,
        password,
        appleId: String(accountInfo.appleId??email),
        store: storeHeader.split('-')[0]??'',
        firstName: String(address.firstName??''),
        lastName: String(address.lastName??''),
        passwordToken,
        directoryServicesIdentifier: dsid,
        cookies: session.cookies,
        deviceIdentifier: guid,
        pod: session.pod,
      };
    }

    throw new AuthenticationError(i18n.t('errors.auth.unknownReason'));
  } finally { scope.dispose(); }
}
