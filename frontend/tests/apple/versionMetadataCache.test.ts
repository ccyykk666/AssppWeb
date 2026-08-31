import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearVersionMetadataCache,
  getCachedVersionMetadata,
  putCachedVersionMetadata,
} from '../../src/apple/versionMetadataCache';
import type { Software } from '../../src/types';

const app = { id: 123 } as Software;

beforeEach(async () => {
  await clearVersionMetadataCache();
});

describe('version metadata cache', () => {
  it('persists successful metadata by app and external version ID', async () => {
    const metadata = {
      displayVersion: '7.2.1',
      releaseDate: '2025-05-03T01:02:03.000Z',
      releaseDateSource: 'archive' as const,
    };

    await putCachedVersionMetadata(app, '456', metadata);

    await expect(getCachedVersionMetadata(app, '456')).resolves.toEqual(
      metadata,
    );
    await expect(getCachedVersionMetadata(app, 'other')).resolves.toBeUndefined();
  });

  it('can be cleared with the rest of local application data', async () => {
    await putCachedVersionMetadata(app, '456', {
      displayVersion: '1.0',
      releaseDate: '2024-01-01T00:00:00.000Z',
    });

    await clearVersionMetadataCache();

    await expect(getCachedVersionMetadata(app, '456')).resolves.toBeUndefined();
  });
});
