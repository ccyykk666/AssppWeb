import { openDB } from 'idb';
import type { Account, Software } from '../types';

const database = openDB('asspp-version-lists', 1, {
  upgrade(db) { db.createObjectStore('lists'); },
});
export function versionListKey(account: Account, app: Software): string {
  return `${account.email}:${account.deviceIdentifier}:${account.store}:${app.id}`;
}
export interface CachedVersionList { versions: string[]; savedAt: number }

export async function cachedVersionList(account: Account, app: Software): Promise<CachedVersionList | undefined> {
  try {
    const value = await (await database).get('lists', versionListKey(account, app)) as CachedVersionList | undefined;
    return value && Date.now() - value.savedAt < 30 * 60_000 ? value : undefined;
  } catch { return undefined; }
}

export async function saveVersionList(account: Account, app: Software, versions: string[]): Promise<void> {
  try { await (await database).put('lists', { versions, savedAt: Date.now() }, versionListKey(account, app)); }
  catch { /* Storage being unavailable must not turn a valid Apple response into a failure. */ }
}
