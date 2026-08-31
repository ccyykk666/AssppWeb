import {
  getCachedVersionMetadata,
  putCachedVersionMetadata,
} from './versionMetadataCache';
import { getVersionMetadata } from './versionLookup';
import type { Account, Software, VersionMetadata } from '../types';

const REQUEST_INTERVAL_MS = 800;

const inFlight = new Map<
  string,
  Promise<{
    metadata: VersionMetadata;
    updatedCookies: Account['cookies'];
  }>
>();
const latestCookies = new Map<string, Account['cookies']>();
let queueTail: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const execution = queueTail.then(async () => {
    const waitMs = Math.max(
      0,
      REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt),
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastRequestStartedAt = Date.now();
    return task();
  });
  queueTail = execution.then(
    () => undefined,
    () => undefined,
  );
  return execution;
}

export async function resolveVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: Account['cookies'];
}> {
  const key = `${app.id}:${versionId}`;
  const cached = await getCachedVersionMetadata(app, versionId);
  if (cached) {
    return { metadata: cached, updatedCookies: account.cookies };
  }

  const requestKey = `${account.email}\u0000${key}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;

  const request = enqueue(async () => {
    const currentAccount = {
      ...account,
      cookies: latestCookies.get(account.email) ?? account.cookies,
    };
    const result = await getVersionMetadata(currentAccount, app, versionId);
    latestCookies.set(account.email, result.updatedCookies);
    await putCachedVersionMetadata(app, versionId, result.metadata);
    return result;
  });
  inFlight.set(requestKey, request);
  request.finally(() => inFlight.delete(requestKey)).catch(() => undefined);
  return request;
}
