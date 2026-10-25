import { downloadProduct, StoreDownloadError } from './downloadProduct';
import { cachedVersionList, saveVersionList, versionListKey } from './versionListCache';
import { joinWork, sharedWork, throwIfAborted, type SharedWork } from '../utils/abort';
import type { Account, Software } from '../types';

export class VersionHistoryError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'VersionHistoryError';
  }
}

const requests = new Map<string, SharedWork<{ versions: string[]; updatedCookies: Account['cookies'] }> & { token: string }>();

export async function listVersions(
  account: Account,
  app: Software,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  throwIfAborted(options?.signal);
  if (!options?.forceRefresh) {
    const cached = await cachedVersionList(account, app);
    if (cached && Date.now() - cached.savedAt < 30_000) return { versions: cached.versions, updatedCookies: account.cookies };
  }
  const key = versionListKey(account, app);
  let entry = requests.get(key);
  if (!entry || entry.token !== account.passwordToken || entry.controller.signal.aborted) {
    entry = { token: account.passwordToken, ...sharedWork((signal) => requestVersions(account, app, signal)) };
    const promise = entry.promise;
    requests.set(key, entry);
    promise.finally(() => { if (requests.get(key)?.promise === promise) requests.delete(key); }).catch(() => undefined);
  }
  return joinWork(entry, options?.signal);
}

async function requestVersions(account: Account, app: Software, signal?: AbortSignal) {
  let result;
  try {
    result = await downloadProduct(account, app, undefined, signal);
  } catch (error) {
    if (error instanceof StoreDownloadError) throw new VersionHistoryError(error.message, error.code);
    throw error;
  }
  const identifiers = result.dict.songList[0]?.metadata?.softwareVersionExternalIdentifiers;
  if (!Array.isArray(identifiers)) throw new VersionHistoryError('Missing version identifiers');
  const versions = identifiers.map(String).reverse();
  if (!versions.length) throw new VersionHistoryError('No versions found');
  await saveVersionList(account, app, versions);
  return { versions, updatedCookies: result.updatedCookies };
}
