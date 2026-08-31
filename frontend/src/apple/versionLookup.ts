import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { apiPost } from '../api/client';
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";
import type { Account, Software, VersionMetadata } from "../types";

export async function lookupVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{
  metadata: VersionMetadata;
  downloadURL: string;
  updatedCookies: typeof account.cookies;
}> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      guid: deviceId,
      salableAdamId: app.id,
      [endpoint.externalVersionIdKey]: versionId,
    };

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
        throw new Error("Failed to retrieve redirect location");
      }
      const url = new URL(location);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    const dict = parsePlist(response.body) as Record<string, any>;

    // volumeStore intermittently returns 5002; retry once via the redownload
    // dispatch endpoint, which serves the same payload.
    if (
      String(dict.failureType ?? "") === RETRYABLE_FAILURE_TYPE &&
      !triedRedownload
    ) {
      triedRedownload = true;
      endpoint = redownloadEndpoint(deviceId);
      requestHost = endpoint.host;
      requestPath = endpoint.path;
      redirectAttempt = 0;
      continue;
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (!songList || songList.length === 0) {
      throw new Error("No items in response");
    }

    const item = songList[0];
    const downloadURL = item.URL as string | undefined;
    if (!downloadURL) {
      throw new Error('Missing download URL');
    }

    const itemMetadata = item.metadata as Record<string, unknown> | undefined;
    const displayVersion = String(
      itemMetadata?.bundleShortVersionString ?? '',
    ).trim();
    if (!displayVersion) {
      throw new Error('Missing bundle short version string');
    }

    return {
      metadata: { displayVersion, releaseDate: '' },
      downloadURL,
      updatedCookies: cookies,
    };
  }

  throw new Error("Too many redirects");
}

export async function readAccurateVersionMetadata(
  downloadURL: string,
): Promise<VersionMetadata> {
  // Apple reuses the application's original App Store release date in the
  // purchase response. Reading the package stays as a separate, slower stage
  // so it never blocks the version number returned above.
  return apiPost<VersionMetadata>('/api/version-metadata', { downloadURL });
}
