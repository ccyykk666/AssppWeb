import { lookupLatestAppVersion } from '../api/search';
import { fetchBag } from './bag';
import { extractAndMergeCookies } from './cookies';
import { buildPlist, parsePlist } from './plist';
import { appleRequest } from './request';
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  storeIdToCountry,
  volumeStoreEndpoint,
} from './config';
import type { Account, Software } from '../types';
import i18n from '../i18n';

export class VersionHistoryError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'VersionHistoryError';
  }
}

export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let triedUpdate = false;
  let selectedVersionId: string | undefined;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: '',
      guid: deviceId,
      salableAdamId: app.id,
      serialNumber: '0',
    };

    if (selectedVersionId) {
      payload[endpoint.externalVersionIdKey] = selectedVersionId;
    }

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-apple-plist',
      'iCloud-DSID': account.directoryServicesIdentifier,
      'X-Dsid': account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
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
        `Apple version history request failed: HTTP ${response.status}`,
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
      const country = storeIdToCountry(account.store);
      if (country) {
        const latest = await lookupLatestAppVersion(app.id, country)
          .catch(() => null);
        if (latest?.bundleID === app.bundleID &&
          /^[1-9]\d*$/.test(latest.externalVersionId)) {
          selectedVersionId = latest.externalVersionId;
        }
      }
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
          throw new VersionHistoryError(
            i18n.t('errors.download.passwordExpired'),
            failureType,
          );
        case '9610':
          throw new VersionHistoryError(
            i18n.t('errors.download.licenseRequired'),
            failureType,
          );
        default: {
          const message = dict.customerMessage as string | undefined;
          throw new Error(message ?? `Apple error ${failureType}`);
        }
      }
    }

    if (noItems) {
      const message = typeof dict.customerMessage === 'string'
        ? dict.customerMessage
        : 'Apple did not return version history. Acquire the app license and try again.';
      throw new Error(message);
    }

    const item = songList![0];
    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new Error('Missing version identifiers');
    }

    if (triedRedownload && (
      String(metadata.itemId) !== String(app.id) ||
      metadata.softwareVersionBundleId !== app.bundleID ||
      (selectedVersionId && metadata.softwareVersionExternalIdentifier !== undefined &&
        String(metadata.softwareVersionExternalIdentifier) !== selectedVersionId)
    )) {
      throw new Error('Apple returned metadata for a different app or version');
    }

    const identifiers = metadata.softwareVersionExternalIdentifiers as unknown;
    if (!Array.isArray(identifiers)) {
      throw new Error('Missing version identifiers');
    }

    const versions = identifiers.map((id) => String(id)).reverse();
    if (versions.length === 0) {
      throw new Error('No versions found');
    }

    return { versions, updatedCookies: cookies };
  }

  throw new Error('Too many redirects');
}
