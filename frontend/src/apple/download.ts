import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag } from './bag';
import { lookupLatestAppVersion } from '../api/search';
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
  storeIdToCountry,
} from "./config";
import i18n from "../i18n";
import type { Account, Software, DownloadOutput, Sinf } from '../types';

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let triedUpdate = false;
  let selectedVersionId = externalVersionId;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      serialNumber: '0',
    };

    if (selectedVersionId) {
      payload[endpoint.externalVersionIdKey] = selectedVersionId;
    }

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
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
      const location = response.headers["location"];
      if (!location) {
        throw new DownloadError(i18n.t("errors.download.redirectLocation"));
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    // Some apps return an empty 500 from redownload even with the current
    // catalog version. Apple's bag-provided update endpoint serves that build.
    if (
      triedRedownload && !triedUpdate && selectedVersionId &&
      response.status === 500 && !response.body.trim()
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
      throw new DownloadError(
        i18n.t('errors.download.downloadFailed', {
          failureType: `HTTP ${response.status}`,
        }),
        `HTTP_${response.status}`,
      );
    }

    const dict = parsePlist(response.body) as Record<string, any>;
    const songList = dict.songList as Record<string, any>[] | undefined;
    const noItems = !Array.isArray(songList) || songList.length === 0;

    // Switch to redownload at most once for an explicit retryable error or
    // an empty volumeStore response. Pin latest requests to the iOS catalog
    // build so dispatch cannot silently select a different platform/version.
    if (
      !triedRedownload &&
      (String(dict.failureType ?? '') === RETRYABLE_FAILURE_TYPE ||
        (noItems && !dict.failureType && !dict.customerMessage && !dict.action))
    ) {
      triedRedownload = true;
      if (!selectedVersionId) {
        const country = storeIdToCountry(account.store);
        if (!country) {
          throw new DownloadError(i18n.t('errors.download.latestVersionUnavailable'), 'LATEST_VERSION_UNAVAILABLE');
        }
        const latest = await lookupLatestAppVersion(app.id, country);
        if (
          !latest || !/^[1-9]\d*$/.test(latest.externalVersionId) ||
          latest.bundleID !== app.bundleID
        ) {
          throw new DownloadError(i18n.t('errors.download.latestVersionUnavailable'), 'LATEST_VERSION_UNAVAILABLE');
        }
        selectedVersionId = latest.externalVersionId;
      }
      endpoint = redownloadEndpoint(deviceId);
      requestHost = endpoint.host;
      requestPath = endpoint.path;
      redirectAttempt = 0;
      continue;
    }

    if (dict.failureType) {
      const failureType = String(dict.failureType);

      const customerMessage = dict.customerMessage as string | undefined;
      switch (failureType) {
        case "2034":
        case "2042":
          throw new DownloadError(
            i18n.t("errors.download.passwordExpired"),
            failureType,
          );
        case "9610":
          throw new DownloadError(
            i18n.t("errors.download.licenseRequired"),
            "9610",
          );
        default: {
          if (customerMessage === "Your password has changed.") {
            throw new DownloadError(
              i18n.t("errors.download.passwordExpired"),
              failureType,
            );
          }
          // If apple provides a specific string, we fall back to it, otherwise we use the localized default.
          throw new DownloadError(
            customerMessage ??
              i18n.t("errors.download.downloadFailed", { failureType }),
            failureType,
          );
        }
      }
    }

    if (noItems) {
      throw new DownloadError(
        typeof dict.customerMessage === 'string' && dict.customerMessage
          ? dict.customerMessage
          : i18n.t('errors.download.noItems'),
        'NO_ITEMS',
      );
    }

    const item = songList![0];
    const url = item.URL as string;
    if (!url) {
      throw new DownloadError(i18n.t("errors.download.missingUrl"));
    }

    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw new DownloadError(i18n.t("errors.download.missingMetadata"));
    }

    // Never accept a wrong app/platform/version from the fallback endpoints.
    if (triedRedownload && (
      songList!.length !== 1 ||
      String(metadata.itemId) !== String(app.id) ||
      metadata.softwareVersionBundleId !== app.bundleID ||
      String(metadata.softwareVersionExternalIdentifier) !== selectedVersionId
    )) {
      throw new DownloadError(i18n.t('errors.download.mismatchedItem'), 'MISMATCHED_ITEM');
    }

    const version = metadata.bundleShortVersionString as string;
    const bundleVersion = metadata.bundleVersion as string;
    if (!version || !bundleVersion) {
      throw new DownloadError(i18n.t("errors.download.missingVersion"));
    }

    const sinfs: Sinf[] = [];
    const sinfData = item.sinfs as Record<string, any>[] | undefined;
    if (sinfData) {
      for (const sinfItem of sinfData) {
        const id = sinfItem.id as number;
        const sinf = sinfItem.sinf;
        if (id !== undefined && sinf) {
          let sinfBase64: string;
          if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
            const bytes =
              sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
            sinfBase64 = base64FromBytes(bytes);
          } else if (typeof sinf === "string") {
            sinfBase64 = sinf;
          } else {
            throw new DownloadError(i18n.t("errors.download.invalidSinf"));
          }
          sinfs.push({ id, sinf: sinfBase64 });
        }
      }
    }

    if (sinfs.length === 0) {
      throw new DownloadError(i18n.t("errors.download.noSinf"));
    }

    // Build iTunesMetadata plist
    const metadataDict: Record<string, any> = { ...metadata };
    metadataDict["apple-id"] = account.email;
    metadataDict["userName"] = account.email;
    delete metadataDict.passwordToken;
    delete metadataDict["passwordToken"];
    const iTunesMetadata = base64FromString(buildPlist(metadataDict));

    return {
      output: {
        downloadURL: url,
        sinfs,
        bundleShortVersionString: version,
        bundleVersion,
        iTunesMetadata,
      },
      updatedCookies: cookies,
    };
  }

  throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
