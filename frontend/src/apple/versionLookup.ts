import { apiPost } from '../api/client';
import { fetchBag } from './bag';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from './config';
import type { Account, Software, VersionMetadata } from '../types';

export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: typeof account.cookies;
}> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let triedUpdate = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: '',
      guid: deviceId,
      salableAdamId: app.id,
      serialNumber: '0',
      [endpoint.externalVersionIdKey]: versionId,
    };

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-apple-plist',
      'iCloud-DSID': account.directoryServicesIdentifier,
      'X-Dsid': account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: 'POST',
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    if (response.status === 302) {
      const location = response.headers.location;
      if (!location) {
        throw new Error('Failed to retrieve redirect location');
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    if (
      triedRedownload && !triedUpdate && response.status === 500 &&
      !response.body.trim()
    ) {
      triedUpdate = true;
      const bag = await fetchBag(deviceId);
      if (bag.updateURL) {
        const url = new URL(bag.updateURL);
        url.searchParams.set('guid', deviceId);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        redirectAttempt = 0;
        continue;
      }
    }

    if (response.status !== 200) {
      throw new Error(
        `Apple version detail request failed: HTTP ${response.status}`,
      );
    }

    const dict = parsePlist(response.body) as Record<string, any>;
    const songList = dict.songList as Record<string, any>[] | undefined;
    const noItems = !Array.isArray(songList) || songList.length === 0;

    if (
      !triedRedownload &&
      (String(dict.failureType ?? '') === RETRYABLE_FAILURE_TYPE ||
        (noItems && !dict.failureType && !dict.customerMessage && !dict.action))
    ) {
      triedRedownload = true;
      endpoint = redownloadEndpoint(deviceId);
      requestHost = endpoint.host;
      requestPath = endpoint.path;
      redirectAttempt = 0;
      continue;
    }

    if (dict.failureType) {
      const failureType = String(dict.failureType);
      switch (failureType) {
        case '2034':
        case '2042':
          throw new Error('Password token is expired');
        case '9610':
          throw new Error('License required - purchase the app first');
        default: {
          const message = dict.customerMessage as string | undefined;
          throw new Error(message ?? `Apple error ${failureType}`);
        }
      }
    }

    if (noItems) {
      const message = typeof dict.customerMessage === 'string'
        ? dict.customerMessage
        : 'Apple did not return details for this version. It may no longer be available.';
      throw new Error(message);
    }

    const item = songList![0];
    const appleMetadata = item.metadata as Record<string, any> | undefined;
    if (triedRedownload && (!appleMetadata ||
      String(appleMetadata.itemId) !== String(app.id) ||
      appleMetadata.softwareVersionBundleId !== app.bundleID ||
      String(appleMetadata.softwareVersionExternalIdentifier) !== versionId
    )) {
      throw new Error('Apple returned metadata for a different app or version');
    }

    const downloadURL = item.URL as string | undefined;
    if (!downloadURL) {
      throw new Error('Missing download URL');
    }

    // Apple reuses the application's original App Store release date in this
    // response for every historical version. Read the real package metadata
    // from a few HTTP ranges instead of trusting that stale field.
    const metadata = await apiPost<VersionMetadata>('/api/version-metadata', {
      downloadURL,
    });

    return {
      metadata,
      updatedCookies: cookies,
    };
  }

  throw new Error('Too many redirects');
}
