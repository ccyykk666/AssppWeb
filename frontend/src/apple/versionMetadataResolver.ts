import {
  getCachedVersionMetadata,
  putCachedVersionMetadata,
} from './versionMetadataCache';
import {
  lookupVersionMetadata,
  readAccurateVersionMetadata,
} from './versionLookup';
import type { Account, Software, VersionMetadata } from '../types';

const REQUEST_INTERVAL_MS = 800;
const MAX_CONCURRENT_APPLE_REQUESTS = 2;
const MAX_CONCURRENT_METADATA_REQUESTS = 2;

type VersionMetadataResult = {
  metadata: VersionMetadata;
  downloadURL?: string;
  updatedCookies: Account['cookies'];
};

type RequestPriority = number;

interface QueueItem {
  requestKey: string;
  priority: RequestPriority;
  sequence: number;
  prepared: boolean;
  preparing: boolean;
  started: boolean;
  cancelled: boolean;
  prepare: () => Promise<VersionMetadataResult | undefined>;
  runApple: () => Promise<VersionMetadataResult>;
  resolve: (result: VersionMetadataResult) => void;
  reject: (error: Error) => void;
}

export class VersionMetadataRequestCancelled extends Error {
  constructor() {
    super('Version metadata request cancelled');
    this.name = 'VersionMetadataRequestCancelled';
  }
}

const inFlight = new Map<string, Promise<VersionMetadataResult>>();
const latestCookies = new Map<string, Account['cookies']>();
const queue: QueueItem[] = [];
const queuedByKey = new Map<string, QueueItem>();
const requestGenerations = new Map<string, number>();
let activeAppleRequests = 0;
let queueTimer: ReturnType<typeof setTimeout> | undefined;
let nextSequence = 0;
let lastRequestStartedAt = 0;

function processQueue(): void {
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (queue[index].cancelled) queue.splice(index, 1);
  }
  if (queue.length === 0) return;

  queue.sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  const item = queue[0];
  if (item.cancelled) {
    queue.shift();
    processQueue();
    return;
  }

  // Resolve the cache for the highest-priority row first. This keeps IndexedDB
  // completion order from rearranging the visible top-to-bottom request order.
  if (!item.prepared) {
    if (item.preparing) return;
    item.preparing = true;
    void item
      .prepare()
      .then((cached) => {
        item.preparing = false;
        if (item.cancelled) return;
        if (cached) {
          const index = queue.indexOf(item);
          if (index >= 0) queue.splice(index, 1);
          queuedByKey.delete(item.requestKey);
          item.resolve(cached);
        } else {
          item.prepared = true;
        }
      }, (error) => {
        item.preparing = false;
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        queuedByKey.delete(item.requestKey);
        item.reject(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(processQueue);
    return;
  }

  if (queueTimer || activeAppleRequests >= MAX_CONCURRENT_APPLE_REQUESTS) {
    return;
  }

  const waitMs = Math.max(
    0,
    REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt),
  );
  if (waitMs > 0) {
    queueTimer = setTimeout(() => {
      queueTimer = undefined;
      processQueue();
    }, waitMs);
    return;
  }

  queue.shift();

  item.started = true;
  queuedByKey.delete(item.requestKey);
  activeAppleRequests += 1;
  lastRequestStartedAt = Date.now();
  void item
    .runApple()
    .then(item.resolve, (error) => {
      item.reject(error instanceof Error ? error : new Error(String(error)));
    })
    .finally(() => {
      activeAppleRequests -= 1;
      processQueue();
    });
  processQueue();
}

function enqueue(
  requestKey: string,
  priority: RequestPriority,
  prepare: () => Promise<VersionMetadataResult | undefined>,
  runApple: () => Promise<VersionMetadataResult>,
): Promise<VersionMetadataResult> {
  const request = new Promise<VersionMetadataResult>((resolve, reject) => {
    const item: QueueItem = {
      requestKey,
      priority,
      sequence: nextSequence++,
      prepared: false,
      preparing: false,
      started: false,
      cancelled: false,
      prepare,
      runApple,
      resolve,
      reject,
    };
    queue.push(item);
    queuedByKey.set(requestKey, item);
  });
  processQueue();
  return request;
}

export function resolveVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
  priority: RequestPriority = 0,
): Promise<VersionMetadataResult> {
  const key = `${app.id}:${versionId}`;
  const requestKey = `${account.email}\u0000${key}`;
  const generation = requestGenerations.get(requestKey) ?? 0;

  const existing = inFlight.get(requestKey);
  if (existing) {
    setQueuedVersionMetadataPriority(account, app, versionId, priority);
    return existing;
  }

  const request = enqueue(
    requestKey,
    priority,
    async () => {
      const cached = await getCachedVersionMetadata(app, versionId);
      if ((requestGenerations.get(requestKey) ?? 0) !== generation) {
        throw new VersionMetadataRequestCancelled();
      }
      return cached
        ? { metadata: cached, updatedCookies: account.cookies }
        : undefined;
    },
    async () => {
      const currentAccount = {
        ...account,
        cookies: latestCookies.get(account.email) ?? account.cookies,
      };
      const result = await lookupVersionMetadata(currentAccount, app, versionId);
      latestCookies.set(account.email, result.updatedCookies);
      return result;
    },
  );
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

interface MetadataQueueItem {
  priority: RequestPriority;
  sequence: number;
  run: () => Promise<VersionMetadata>;
  resolve: (metadata: VersionMetadata) => void;
  reject: (error: Error) => void;
}

const metadataQueue: MetadataQueueItem[] = [];
const metadataInFlight = new Map<string, Promise<VersionMetadata>>();
let activeMetadataRequests = 0;
let nextMetadataSequence = 0;

function processMetadataQueue(): void {
  while (
    metadataQueue.length > 0 &&
    activeMetadataRequests < MAX_CONCURRENT_METADATA_REQUESTS
  ) {
    metadataQueue.sort(
      (a, b) => a.priority - b.priority || a.sequence - b.sequence,
    );
    const item = metadataQueue.shift()!;
    activeMetadataRequests += 1;
    void item
      .run()
      .then(item.resolve, (error) => {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        activeMetadataRequests -= 1;
        processMetadataQueue();
      });
  }
}

function enqueueMetadata(
  priority: RequestPriority,
  run: () => Promise<VersionMetadata>,
): Promise<VersionMetadata> {
  const request = new Promise<VersionMetadata>((resolve, reject) => {
    metadataQueue.push({
      priority,
      sequence: nextMetadataSequence++,
      run,
      resolve,
      reject,
    });
  });
  processMetadataQueue();
  return request;
}

export async function resolveAccurateVersionMetadata(
  app: Software,
  versionId: string,
  downloadURL: string,
  priority: RequestPriority = 0,
): Promise<VersionMetadata> {
  const key = `${app.id}:${versionId}`;
  const cached = await getCachedVersionMetadata(app, versionId);
  if (cached) return cached;

  const existing = metadataInFlight.get(key);
  if (existing) return existing;

  const request = enqueueMetadata(priority, async () => {
    const metadata = await readAccurateVersionMetadata(downloadURL);
    await putCachedVersionMetadata(app, versionId, metadata);
    return metadata;
  });
  metadataInFlight.set(key, request);
  request
    .finally(() => {
      if (metadataInFlight.get(key) === request) metadataInFlight.delete(key);
    })
    .catch(() => undefined);
  return request;
}
