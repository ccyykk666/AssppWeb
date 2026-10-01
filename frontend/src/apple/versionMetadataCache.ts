import { openDB } from 'idb';
import type { Software, VersionMetadata } from '../types';

const DB_NAME = 'asspp-version-metadata';
const STORE_NAME = 'versions';

interface CachedVersionMetadata extends VersionMetadata {
  key: string;
  cachedAt?: number;
}

// Historical external version IDs are immutable in Apple's catalog. Keep
// resolved package metadata locally for a month, while still allowing rare
// upstream corrections to be picked up eventually.
export const VERSION_METADATA_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const dbPromise = openDB(DB_NAME, 1, {
  upgrade(db) {
    db.createObjectStore(STORE_NAME, { keyPath: 'key' });
  },
});

function cacheKey(app: Software, versionId: string): string {
  return `${app.id}:${versionId}`;
}

export async function getCachedVersionMetadata(
  app: Software,
  versionId: string,
): Promise<VersionMetadata | undefined> {
  const cached = await (await dbPromise).get(
    STORE_NAME,
    cacheKey(app, versionId),
  ) as CachedVersionMetadata | undefined;
  if (!cached) return undefined;
  if (
    typeof cached.cachedAt !== 'number' ||
    Date.now() - cached.cachedAt >= VERSION_METADATA_CACHE_TTL_MS
  ) {
    await (await dbPromise).delete(STORE_NAME, cacheKey(app, versionId));
    return undefined;
  }
  const { key: _key, cachedAt: _cachedAt, ...metadata } = cached;
  return metadata;
}

export async function putCachedVersionMetadata(
  app: Software,
  versionId: string,
  metadata: VersionMetadata,
): Promise<void> {
  await (await dbPromise).put(STORE_NAME, {
    key: cacheKey(app, versionId),
    cachedAt: Date.now(),
    ...metadata,
  });
}

export async function clearVersionMetadataCache(): Promise<void> {
  await (await dbPromise).clear(STORE_NAME);
}
