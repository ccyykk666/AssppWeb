import i18n from '../i18n';
import { fetchBag,type BagOutput } from './bag';
import { lookupLatestVersion } from './latestVersion';
import { extractAndMergeCookies } from './cookies';
import { hardwareIDFromDeviceIdentifier,obtainKBSync } from './kbsync';
import { cachedKBSync,invalidateKBSync } from './kbsync/cache';
import { buildPlist,parsePlist } from './plist';
import { appleRequest } from './request';
import { toBase64 } from './kbsync/bytes';
import { accountExchange } from './accountSession';
import { requestScope,throwIfAborted } from '../utils/abort';
import { redownloadEndpoint,volumeStoreEndpoint } from './config';
import type { StoreDownloadEndpoint } from './config';
import type { AppleResponse } from './request';
import type { Account,Cookie,Software } from '../types';

export class StoreDownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name='StoreDownloadError';
  }
}

// Only the observed empty/unavailable responses permit endpoint recovery.
// Authentication, license, and other structured failures must not be hidden.
export function needsDownloadFallback(dict: Record<string,any>): boolean {
  if(dict.songList?.length||dict.dialog||dict.action) return false;
  if(dict.failureType) return String(dict.failureType)==='5002';
  if(dict.status!==undefined&&Number(dict.status)!==0) return false;
  const message=String(dict.customerMessage??'')
    .trim()
    .toLowerCase();
  return !message||message==='no longer available'||message.endsWith(' no longer available');
}

const DISPATCH_PATHS={
  ent: '/WebObjects/DownloadDispatch.woa/wa/ent/download',
  redownload: '/r/redownload',
  update: '/up/updateProduct',
};

// Matches ipatool's ent/download request (majd/ipatool@3411d57).
const ENT_USER_AGENT='Configurator/2.18 (Macintosh; OS X 15.3.2; 24D81) AppleWebKit/0620.2.4.11.6';
const ENT_SERIAL_PREFIX=[0x54,0xc8,0xb0,0xa9,0x88];

export function dispatchEndpoint(
  raw: string|undefined,
  kind: keyof typeof DISPATCH_PATHS,
  deviceId: string,
): StoreDownloadEndpoint|undefined {
  if(!raw) return undefined;
  let url: URL;
  try {
    url=new URL(raw);
  } catch {
    return undefined;
  }
  const path=DISPATCH_PATHS[kind];
  if(
    url.protocol!=='https:'||
    url.host!=='downloaddispatch.itunes.apple.com'||
    url.pathname!==path||
    url.search||
    url.hash||
    url.username||
    url.password
  ) {
    return undefined;
  }
  url.searchParams.set('guid',deviceId);
  return {
    host: url.hostname,
    path: url.pathname+url.search,
    externalVersionIdKey: kind==='ent'? 'externalVersionId':'appExtVrsId',
  };
}

// Errors identify the endpoint without exposing bodies, queries, or account values.
function responseDict(response: AppleResponse,endpoint: StoreDownloadEndpoint): Record<string,any> {
  if(response.body.trim()) {
    try {
      const dict=parsePlist(response.body);
      if(dict&&typeof dict==='object'&&!Array.isArray(dict)&&
        (response.status===200||dict.failureType)) return dict;
    } catch {
      // Report the same safe diagnostic for every malformed response.
    }
  }
  const kind=i18n.t(response.body.trim()? 'errors.download.invalidPlist':'errors.download.emptyResponse');
  const location=endpoint.host+endpoint.path.split('?')[0];
  throw new StoreDownloadError(i18n.t('errors.download.protocolFailed',{
    status: response.status,endpoint: location,reason: kind,
  }),`HTTP_${response.status}`);
}

function requireItems(dict: Record<string,any>): void {
  const code=String(dict.failureType??'');
  if(dict.customerMessage==='Your password has changed.') {
    throw new StoreDownloadError(i18n.t('errors.download.passwordExpired'),'2034');
  }
  if(code) {
    if(['2034','2042'].includes(code)||dict.customerMessage==='Your password has changed.') {
      throw new StoreDownloadError(i18n.t('errors.download.passwordExpired'),code);
    }
    if(code==='9610') throw new StoreDownloadError(i18n.t('errors.download.licenseRequired'),code);
    throw new StoreDownloadError(`${dict.customerMessage||'Apple download failed'} (${code})`,code);
  }
  if(!Array.isArray(dict.songList)||!dict.songList.length) {
    throw new StoreDownloadError(dict.customerMessage||i18n.t('errors.download.noItems'),'NO_ITEMS');
  }
}

function validateDownloadItem(dict: Record<string,any>,app: Software,version?: string): void {
  const metadata=dict.songList[0]?.metadata;
  if(
    dict.songList.length!==1||
    !metadata||
    String(metadata.itemId)!==String(app.id)||
    (version&&String(metadata.softwareVersionExternalIdentifier)!==version)||
    !metadata.softwareVersionBundleId||
    (app.bundleID&&metadata.softwareVersionBundleId!==app.bundleID)
  ) {
    throw new StoreDownloadError(i18n.t('errors.download.mismatchedItem'),'MISMATCHED_ITEM');
  }
}

async function sendEntDownload(
  account: Account,
  app: Software,
  endpoint: StoreDownloadEndpoint,
  version: string,
  kbsync: string,
  cookies: Cookie[],
  signal?: AbortSignal,
): Promise<{ dict: Record<string,any>; cookies: Cookie[] }> {
  const hardwareID=hardwareIDFromDeviceIdentifier(account.deviceIdentifier);
  const response=await accountExchange(account,() => appleRequest({
    method: 'POST',
    host: endpoint.host,
    path: endpoint.path,
    // Redirects are never followed, so X-Token cannot reach another host.
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'User-Agent': ENT_USER_AGENT,
      'X-Apple-Store-Front': `${account.store}-1`,
      'X-Token': account.passwordToken,
      'iCloud-DSID': account.directoryServicesIdentifier,
      'X-Dsid': account.directoryServicesIdentifier,
    },
    body: buildPlist({
      creditDisplay: '',
      guid: account.deviceIdentifier,
      kbsync,
      salableAdamId: String(app.id),
      serialNumber: toBase64(Uint8Array.from([...ENT_SERIAL_PREFIX,...hardwareID.subarray(2)])),
      [endpoint.externalVersionIdKey]: version,
    }),
    cookies,
    signal,
  }),signal);
  const updatedCookies=extractAndMergeCookies(response.rawHeaders,cookies);
  const dict=responseDict(response,endpoint);
  requireItems(dict);
  validateDownloadItem(dict,app,version);
  if(!dict.songList[0].URL) {
    throw new StoreDownloadError('Apple download: ent/download response has no package URL');
  }
  return { dict,cookies: updatedCookies };
}

// Apple's bag now routes volumeStoreDownloadProduct to ent/download, which
// requires a kbsync blob bound to the account DSID and device GUID.
async function entDownload(
  account: Account,
  app: Software,
  endpoint: StoreDownloadEndpoint,
  version: string|Promise<string>,
  cookies: Cookie[],
  signal?: AbortSignal,
): Promise<{ dict: Record<string,any>; cookies: Cookie[] }> {
  const dsid=Number(account.directoryServicesIdentifier);
  if(!Number.isSafeInteger(dsid)||dsid<=0) {
    throw new StoreDownloadError('ent/download requires a numeric account DSID');
  }
  const cached=cachedKBSync(dsid,account.deviceIdentifier);
  if(cached) {
    try {
      return await sendEntDownload(account,app,endpoint,await version,cached,cookies,signal);
    } catch(error) {
      if(!(error instanceof StoreDownloadError)||error.code!=='HTTP_403') throw error;
      // Only a rejected cached blob permits one fresh generation, never a login/license error.
      invalidateKBSync(dsid,account.deviceIdentifier,cached);
    }
  }
  const [resolvedVersion,kbsync]=await Promise.all([version,obtainKBSync(account.deviceIdentifier,dsid,signal)]);
  return sendEntDownload(account,app,endpoint,resolvedVersion,kbsync,cookies,signal);
}

/** Shared protocol for downloads, version lists, and pinned version metadata. */
export async function downloadProduct(account: Account,app: Software,versionId?: string,signal?: AbortSignal) {
  const scope=requestScope(signal,8*60_000);
  try {
    const bag=await fetchBag(account.deviceIdentifier,scope.signal);
    const ent=dispatchEndpoint(bag.entDownloadURL,'ent',account.deviceIdentifier);
    let entError: unknown;
    if(ent) {
      try {
        // Prepare the independent signing and catalog steps concurrently.
        const version=versionId??lookupLatestVersion(account,app);
        const result=await entDownload(account,app,ent,version,[...account.cookies],scope.signal);
        return { dict: result.dict,updatedCookies: result.cookies };
      } catch(error) {
        throwIfAborted(scope.signal);
        if(error instanceof Error&&error.name==='TimeoutError') throw error;
        if(error instanceof StoreDownloadError&&error.code&&['2034','2042','9610','HTTP_429'].includes(error.code)) throw error;
        entError=error;
      }
    }
    try {
      return await legacyDownloadProduct(account,app,bag,versionId,scope.signal);
    } catch(error) {
      if(entError&&error instanceof Error) {
        const reason=entError instanceof Error? entError.message:String(entError);
        throw new StoreDownloadError(`${error.message} ${i18n.t('errors.download.entFailure',{ reason })}`,(error as StoreDownloadError).code);
      }
      throw error;
    }
  } finally { scope.dispose(); }
}

async function legacyDownloadProduct(account: Account,app: Software,bag: BagOutput,versionId?: string,signal?: AbortSignal) {
  let cookies=[...account.cookies];
  const send=async (endpoint: StoreDownloadEndpoint,version?: string): Promise<AppleResponse> => {
    const payload: Record<string,unknown>={
      creditDisplay: '',
      guid: account.deviceIdentifier,
      salableAdamId: app.id,
      serialNumber: '0',
    };
    if(version) payload[endpoint.externalVersionIdKey]=version;
    let host=endpoint.host;
    let path=endpoint.path;
    for(let redirects=0;redirects<=3;redirects++) {
      const response=await accountExchange(account,() => appleRequest({
        method: 'POST',
        host,
        path,
        headers: {
          'Content-Type': 'application/x-apple-plist',
          'iCloud-DSID': account.directoryServicesIdentifier,
          'X-Dsid': account.directoryServicesIdentifier,
        },
        body: buildPlist(payload),
        cookies,
        signal,
      }),signal);
      cookies=extractAndMergeCookies(response.rawHeaders,cookies);
      if(![301,302,303,307,308].includes(response.status)) return response;
      if(!response.headers.location) throw new StoreDownloadError('Missing Apple download redirect location');
      const url=new URL(response.headers.location,`https://${host}${path}`);
      if(
        url.protocol!=='https:'||
        url.port||
        url.username||
        url.password||
        !/^(?:(?:p\d+-)?buy|downloaddispatch)\.itunes\.apple\.com$/.test(url.hostname)
      ) {
        throw new StoreDownloadError('Unsafe Apple download redirect');
      }
      host=url.hostname;
      path=url.pathname+url.search;
    }
    throw new StoreDownloadError(i18n.t('errors.download.tooManyRedirects'));
  };

  const primary=volumeStoreEndpoint(account.pod,account.deviceIdentifier);
  let dict=responseDict(await send(primary,versionId),primary);
  if(!needsDownloadFallback(dict)) {
    requireItems(dict);
    return { dict,updatedCookies: cookies };
  }

  // An unpinned dispatch request may return HTTP 500 or the tvOS build.
  let pinnedVersion=versionId;
  if(!pinnedVersion) {
    try {
      pinnedVersion=await lookupLatestVersion(account,app);
    } catch {
      throw new StoreDownloadError(i18n.t('errors.download.latestVersionUnavailable'),'LATEST_VERSION_UNAVAILABLE');
    }
  }
  const redownload=
    dispatchEndpoint(bag.redownloadURL,'redownload',account.deviceIdentifier)??
    redownloadEndpoint(account.deviceIdentifier);
  const response=await send(redownload,pinnedVersion);
  const emptyServerError=response.status===500&&!response.body.trim();
  if(!emptyServerError) dict=responseDict(response,redownload);
  const recoverable=
    !emptyServerError&&needsDownloadFallback(dict)&&(Boolean(dict.failureType)||Boolean(dict.customerMessage));

  const update=dispatchEndpoint(bag.updateURL,'update',account.deviceIdentifier);
  if(update&&(emptyServerError||recoverable)) {
    dict=responseDict(await send(update,pinnedVersion),update);
  } else if(emptyServerError) {
    responseDict(response,redownload); // Preserve the HTTP failure, not an XML parser error.
  }
  requireItems(dict);
  validateDownloadItem(dict,app,pinnedVersion);
  return { dict,updatedCookies: cookies };
}
