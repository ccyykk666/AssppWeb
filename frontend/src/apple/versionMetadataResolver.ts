import {
  getCachedVersionMetadata,
  putCachedVersionMetadata,
} from './versionMetadataCache';
import { getVersionMetadata } from './versionLookup';
import { currentAccount } from './accountSession';
import { joinWork, sharedWork, throwIfAborted, type SharedWork } from '../utils/abort';
import type { Account, Software, VersionMetadata } from '../types';

const MAX_METADATA_REQUESTS = 2;

const inFlight = new Map<
  string,
  SharedWork<{
    metadata: VersionMetadata;
    updatedCookies: Account['cookies'];
  }>
>();
let active = 0;
const queue: Array<() => void> = [];

function enqueue<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      const index = queue.indexOf(start);
      if (index >= 0) queue.splice(index, 1);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const start = () => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) { cancel(); return; }
      active++;
      task().then(resolve, reject).finally(() => {
        active--;
        queue.shift()?.();
      });
    };
    if (signal?.aborted) { cancel(); return; }
    if (active < MAX_METADATA_REQUESTS) start();
    else {
      // Prefer the most recent explicit click over older queued lookups.
      queue.unshift(start);
      signal?.addEventListener('abort', cancel, { once: true });
    }
  });
}

export async function resolveVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
  signal?: AbortSignal,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: Account['cookies'];
}> {
  const key = `${app.id}:${versionId}`;
  throwIfAborted(signal);
  const cached = await getCachedVersionMetadata(app, versionId).catch(() => undefined);
  if (cached) {
    return {
      metadata: cached,
      updatedCookies: currentAccount(account).cookies,
    };
  }

  const requestKey = `${account.email}:${account.deviceIdentifier}:${account.store}\u0000${key}`;
  const existing = inFlight.get(requestKey);
  if (existing && !existing.controller.signal.aborted) return joinWork(existing, signal);

  const request = sharedWork((requestSignal) => enqueue(async () => {
    throwIfAborted(requestSignal);
    const result = await getVersionMetadata(currentAccount(account), app, versionId, requestSignal);
    await putCachedVersionMetadata(app, versionId, result.metadata).catch(() => undefined);
    return result;
  }, requestSignal));
  inFlight.set(requestKey, request);
  request.promise.finally(() => { if (inFlight.get(requestKey) === request) inFlight.delete(requestKey); }).catch(() => undefined);
  return joinWork(request, signal);
}
