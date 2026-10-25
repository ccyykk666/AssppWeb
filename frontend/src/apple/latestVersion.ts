import { lookupLatestAppVersion } from '../api/search';
import { storeIdToCountry } from './config';
import type { Account, Software } from '../types';

// Public catalog lookup stays credential-free and uses the account storefront.
export async function lookupLatestVersion(account: Account, app: Software): Promise<string> {
  const country = storeIdToCountry(account.store.split('-')[0]);
  if (!country) throw new Error('Unknown account storefront');
  const latest = await lookupLatestAppVersion(app.id, country);
  if (!latest || latest.bundleID !== app.bundleID || !/^[1-9]\d*$/.test(latest.externalVersionId)) {
    throw new Error('Catalog returned no matching iOS version identifier');
  }
  return latest.externalVersionId;
}
