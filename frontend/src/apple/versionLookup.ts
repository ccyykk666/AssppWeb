import { apiPost } from '../api/client';
import { downloadProduct } from './downloadProduct';
import type { Account, Software, VersionMetadata } from '../types';

export async function getVersionMetadata(
  account: Account,
  app: Software,
  versionId: string,
): Promise<{ metadata: VersionMetadata; updatedCookies: typeof account.cookies }> {
  const { dict, updatedCookies } = await downloadProduct(account, app, versionId);
  const downloadURL = dict.songList[0].URL as string | undefined;
  if (!downloadURL) throw new Error('Missing download URL');
  // Read Info.plist from the real package; Apple often reuses the app's original release date.
  const metadata = await apiPost<VersionMetadata>('/api/version-metadata', { downloadURL });
  return { metadata, updatedCookies };
}
