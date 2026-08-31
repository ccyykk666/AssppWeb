import { openDB } from 'idb';
import type { Software, VersionMetadata } from '../types';

const DB_NAME = 'asspp-version-metadata';
const STORE_NAME = 'versions';

interface CachedVersionMetadata extends VersionMetadata {
  key: string;
}

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
  const { key: _key, ...metadata } = cached;
  return metadata;
}

export async function putCachedVersionMetadata(
  app: Software,
  versionId: string,
  metadata: VersionMetadata,
): Promise<void> {
  await (await dbPromise).put(STORE_NAME, {
    key: cacheKey(app, versionId),
    ...metadata,
  });
}

export async function clearVersionMetadataCache(): Promise<void> {
  await (await dbPromise).clear(STORE_NAME);
}
