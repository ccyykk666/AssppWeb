import {
  getCachedVersionMetadata,
  putCachedVersionMetadata,
} from './versionMetadataCache';
import { getVersionMetadata } from './versionLookup';
import type { Account, Software, VersionMetadata } from '../types';

const REQUEST_INTERVAL_MS = 800;

type VersionMetadataResult = {
  metadata: VersionMetadata;
  updatedCookies: Account['cookies'];
};

type RequestPriority = 0 | 1;

interface QueueItem {
  requestKey: string;
  priority: RequestPriority;
  sequence: number;
  started: boolean;
  cancelled: boolean;
  run: () => Promise<VersionMetadataResult>;
  resolve: (result: VersionMetadataResult) => void;
  reject: (error: Error) => void;
}

export class VersionMetadataRequestCancelled extends Error {
  constructor() {
    super('Version metadata request cancelled');
    this.name = 'VersionMetadataRequestCancelled';
  }
}

const inFlight = new Map<
  string,
  Promise<{
    metadata: VersionMetadata;
    updatedCookies: Account['cookies'];
  }>
>();
const latestCookies = new Map<string, Account['cookies']>();
const queue: QueueItem[] = [];
const queuedByKey = new Map<string, QueueItem>();
const requestGenerations = new Map<string, number>();
let processingQueue = false;
let nextSequence = 0;
let lastRequestStartedAt = 0;

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  while (queue.length > 0) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].cancelled) queue.splice(index, 1);
    }
    if (queue.length === 0) break;

    const waitMs = Math.max(
      0,
      REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt),
    );
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    queue.sort(
      (a, b) => a.priority - b.priority || a.sequence - b.sequence,
    );
    const item = queue.shift()!;
    if (item.cancelled) continue;
    item.started = true;
    queuedByKey.delete(item.requestKey);
    lastRequestStartedAt = Date.now();
    try {
      item.resolve(await item.run());
    } catch (error) {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  processingQueue = false;
}

function enqueue(
  requestKey: string,
  priority: RequestPriority,
  run: () => Promise<VersionMetadataResult>,
): Promise<VersionMetadataResult> {
  const request = new Promise<VersionMetadataResult>((resolve, reject) => {
    const item: QueueItem = {
      requestKey,
      priority,
      sequence: nextSequence++,
      started: false,
      cancelled: false,
      run,
      resolve,
      reject,
    };
    queue.push(item);
    queuedByKey.set(requestKey, item);
  });
  void processQueue();
  return request;
}

export async function resolveVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
  priority: RequestPriority = 0,
): Promise<{
  metadata: VersionMetadata;
  updatedCookies: Account['cookies'];
}> {
  const key = `${app.id}:${versionId}`;
  const requestKey = `${account.email}\u0000${key}`;
  const generation = requestGenerations.get(requestKey) ?? 0;
  const cached = await getCachedVersionMetadata(app, versionId);
  if ((requestGenerations.get(requestKey) ?? 0) !== generation) {
    throw new VersionMetadataRequestCancelled();
  }
  if (cached) {
    return { metadata: cached, updatedCookies: account.cookies };
  }

  const existing = inFlight.get(requestKey);
  if (existing) {
    setQueuedVersionMetadataPriority(account, app, versionId, priority);
    return existing;
  }

  const request = enqueue(requestKey, priority, async () => {
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
  request
    .finally(() => {
      if (inFlight.get(requestKey) === request) inFlight.delete(requestKey);
    })
    .catch(() => undefined);
  return request;
}

export function setQueuedVersionMetadataPriority(
  account: Account,
  app: Software,
  versionId: string,
  priority: RequestPriority,
): void {
  const requestKey = `${account.email}\u0000${app.id}:${versionId}`;
  const item = queuedByKey.get(requestKey);
  if (item && !item.started) item.priority = priority;
}

export function cancelQueuedVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): void {
  const requestKey = `${account.email}\u0000${app.id}:${versionId}`;
  const item = queuedByKey.get(requestKey);
  if (!item) {
    if (!inFlight.has(requestKey)) {
      requestGenerations.set(
        requestKey,
        (requestGenerations.get(requestKey) ?? 0) + 1,
      );
    }
    return;
  }
  if (item.started) return;

  requestGenerations.set(
    requestKey,
    (requestGenerations.get(requestKey) ?? 0) + 1,
  );
  item.cancelled = true;
  queuedByKey.delete(requestKey);
  inFlight.delete(requestKey);
  item.reject(new VersionMetadataRequestCancelled());
}
