import { apiGet } from './client';
import type { ReleaseHistoryResult, Software } from '../types';

export async function searchApps(
  term: string,
  country: string,
  entity: string,
  limit: number = 25,
): Promise<Software[]> {
  const params = new URLSearchParams({
    term,
    country,
    entity: entity === "iPad" ? "iPadSoftware" : "software",
    limit: String(limit),
  });
  return apiGet<Software[]>(`/api/search?${params}`);
}

export async function lookupApp(
  bundleId: string,
  country: string,
): Promise<Software | null> {
  const params = new URLSearchParams({ bundleId, country });
  return apiGet<Software | null>(`/api/lookup?${params}`);
}

export interface CatalogVersion {
  externalVersionId: string;
  version: string;
  bundleID: string;
}

const CATALOG_VERSION_CACHE_MS = 5 * 60 * 1000;
const catalogVersionCache = new Map<
  string,
  { expiresAt: number; value: CatalogVersion | null }
>();
const catalogVersionInFlight = new Map<
  string,
  Promise<CatalogVersion | null>
>();

export async function lookupLatestAppVersion(
  id: number,
  country: string,
): Promise<CatalogVersion | null> {
  const normalizedCountry = country.toUpperCase();
  const key = `${id}:${normalizedCountry}`;
  const cached = catalogVersionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = catalogVersionInFlight.get(key);
  if (pending) return pending;

  const params = new URLSearchParams({
    id: String(id),
    country: normalizedCountry,
  });
  const request = apiGet<CatalogVersion | null>(
    `/api/catalog-version?${params}`,
  ).then((value) => {
    catalogVersionCache.set(key, {
      expiresAt: Date.now() + CATALOG_VERSION_CACHE_MS,
      value,
    });
    return value;
  });
  catalogVersionInFlight.set(key, request);
  request
    .finally(() => catalogVersionInFlight.delete(key))
    .catch(() => undefined);
  return request;
}

const appleLanguageMap: Record<string, string> = {
  'zh-CN': 'zh-Hans-CN',
  'en-US': 'en-US',
};

export async function getReleaseHistory(
  id: number,
  country: string,
  language: string,
): Promise<ReleaseHistoryResult> {
  const params = new URLSearchParams({
    id: String(id),
    country: country.toUpperCase(),
    language: appleLanguageMap[language] ?? 'en-US',
  });
  return apiGet<ReleaseHistoryResult>(`/api/release-history?${params}`);
}
