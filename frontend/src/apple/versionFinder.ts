import { downloadProduct, StoreDownloadError } from './downloadProduct';
import type { Account, Software } from '../types';

export class VersionHistoryError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'VersionHistoryError';
  }
}

export async function listVersions(
  account: Account,
  app: Software,
): Promise<{ versions: string[]; updatedCookies: typeof account.cookies }> {
  let result;
  try {
    result = await downloadProduct(account, app);
  } catch (error) {
    if (error instanceof StoreDownloadError) throw new VersionHistoryError(error.message, error.code);
    throw error;
  }
  const identifiers = result.dict.songList[0]?.metadata?.softwareVersionExternalIdentifiers;
  if (!Array.isArray(identifiers)) throw new VersionHistoryError('Missing version identifiers');
  const versions = identifiers.map(String).reverse();
  if (!versions.length) throw new VersionHistoryError('No versions found');
  return { versions, updatedCookies: result.updatedCookies };
}
