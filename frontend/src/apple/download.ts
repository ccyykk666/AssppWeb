import i18n from '../i18n';
import { downloadProduct, StoreDownloadError } from './downloadProduct';
import { buildPlist } from './plist';
import type { Account, Software, DownloadOutput, Sinf } from '../types';

export class DownloadError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'DownloadError';
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  let result;
  try {
    result = await downloadProduct(account, app, externalVersionId);
  } catch (error) {
    if (error instanceof StoreDownloadError) throw new DownloadError(error.message, error.code);
    throw error;
  }
  const { dict, updatedCookies } = result;
  const item = dict.songList[0];
  const url = item.URL as string;
  if (!url) throw new DownloadError(i18n.t('errors.download.missingUrl'));
  const metadata = item.metadata as Record<string, any>;
  if (!metadata) throw new DownloadError(i18n.t('errors.download.missingMetadata'));
  const version = metadata.bundleShortVersionString as string;
  const bundleVersion = metadata.bundleVersion as string;
  if (!version || !bundleVersion) {
    throw new DownloadError(i18n.t("errors.download.missingVersion"));
  }

  const sinfs: Sinf[] = [];
  const sinfData = item.sinfs as Record<string, any>[] | undefined;
  if (sinfData) {
    for (const sinfItem of sinfData) {
      const id = sinfItem.id as number;
      const sinf = sinfItem.sinf;
      if (id !== undefined && sinf) {
        let sinfBase64: string;
        if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
          const bytes =
            sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
          sinfBase64 = base64FromBytes(bytes);
        } else if (typeof sinf === "string") {
          sinfBase64 = sinf;
        } else {
          throw new DownloadError(i18n.t("errors.download.invalidSinf"));
        }
        sinfs.push({ id, sinf: sinfBase64 });
      }
    }
  }

  if (sinfs.length === 0) {
    throw new DownloadError(i18n.t("errors.download.noSinf"));
  }

  // Build iTunesMetadata plist
  const metadataDict: Record<string, any> = { ...metadata };
  metadataDict["apple-id"] = account.email;
  metadataDict["userName"] = account.email;
  delete metadataDict.passwordToken;
  delete metadataDict["passwordToken"];
  const iTunesMetadata = base64FromString(buildPlist(metadataDict));

  return {
    output: {
      downloadURL: url,
      sinfs,
      bundleShortVersionString: version,
      bundleVersion,
      iTunesMetadata,
    },
    updatedCookies,
  };
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
