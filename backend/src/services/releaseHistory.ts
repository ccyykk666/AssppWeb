export interface ReleaseHistoryEntry {
  version: string;
  releaseDate: string;
  releaseNotes: string;
}

export interface ReleaseHistoryResult {
  appName: string;
  entries: ReleaseHistoryEntry[];
}

const MAX_HISTORY_HTML_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findSerializedServerData(html: string): string | undefined {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1];
    const idMatch = attributes.match(
      /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i,
    );
    if ((idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3]) ===
      'serialized-server-data') {
      return match[2];
    }
  }
  return undefined;
}

function historyPageItems(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 32) return undefined;

  if (Array.isArray(value)) {
    for (const child of value) {
      const result = historyPageItems(child, depth + 1);
      if (result) return result;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  const pageFields = value.pageFields;
  if (isRecord(pageFields) && pageFields.pageType === 'VersionHistory') {
    const shelves = value.shelves;
    if (Array.isArray(shelves)) {
      return shelves.flatMap((shelf) => {
        if (!isRecord(shelf) || !Array.isArray(shelf.items)) return [];
        return shelf.items;
      });
    }
  }

  for (const child of Object.values(value)) {
    const result = historyPageItems(child, depth + 1);
    if (result) return result;
  }
  return undefined;
}

function directHistoryItems(root: Record<string, unknown>): unknown[] | undefined {
  const data = root.data;
  if (!Array.isArray(data) || !isRecord(data[0]) || !isRecord(data[0].data)) {
    return undefined;
  }
  const shelfMapping = data[0].data.shelfMapping;
  if (!isRecord(shelfMapping) || !isRecord(shelfMapping.mostRecentVersion)) {
    return undefined;
  }
  const action = shelfMapping.mostRecentVersion.seeAllAction;
  if (!isRecord(action) || !isRecord(action.pageData) ||
    !Array.isArray(action.pageData.shelves)) {
    return undefined;
  }
  return action.pageData.shelves.flatMap((shelf) => {
    if (!isRecord(shelf) || !Array.isArray(shelf.items)) return [];
    return shelf.items;
  });
}

function normalizedDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toISOString();
}

export function parseReleaseHistoryPage(html: string): ReleaseHistoryResult {
  const serialized = findSerializedServerData(html);
  if (!serialized) throw new Error('Apple page metadata is missing');

  const root = JSON.parse(serialized) as unknown;
  if (!isRecord(root) || !Array.isArray(root.data)) {
    throw new Error('Apple page metadata is malformed');
  }

  const firstPayload = root.data[0];
  const page = isRecord(firstPayload) && isRecord(firstPayload.data)
    ? firstPayload.data
    : undefined;
  const appName = page && typeof page.title === 'string' ? page.title : '';
  const items = directHistoryItems(root) ?? historyPageItems(root) ?? [];
  const entries = items.flatMap((item): ReleaseHistoryEntry[] => {
    if (!isRecord(item) || typeof item.primarySubtitle !== 'string' ||
      typeof item.text !== 'string') {
      return [];
    }
    const version = item.primarySubtitle.trim().replace(/^版本\s*/i, '');
    if (!version) return [];
    const date = typeof item.secondarySubtitle === 'string'
      ? item.secondarySubtitle.trim()
      : '';
    return [{
      version,
      releaseDate: date ? normalizedDate(date) : '',
      releaseNotes: item.text.trim(),
    }];
  });

  return { appName, entries };
}

export async function fetchReleaseHistory(
  appId: string,
  country: string,
  language: string,
): Promise<ReleaseHistoryResult> {
  let url = new URL(
    `https://apps.apple.com/${country.toLowerCase()}/app/id${appId}`,
  );
  let response: Response | undefined;
  for (let redirectCount = 0; redirectCount <= 2; redirectCount++) {
    response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': language,
        'User-Agent': 'Mozilla/5.0 (compatible; AssppWeb/1.0)',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('Apple App Store redirect is missing');
    const nextUrl = new URL(location, url);
    if (nextUrl.hostname !== 'apps.apple.com' || nextUrl.protocol !== 'https:') {
      throw new Error('Apple App Store redirected to an unexpected host');
    }
    url = nextUrl;
  }
  if (!response) throw new Error('Apple App Store request failed');
  if (!response.ok) {
    throw new Error(`Apple App Store returned HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_HISTORY_HTML_BYTES) {
    throw new Error('Apple App Store page is too large');
  }
  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > MAX_HISTORY_HTML_BYTES) {
    throw new Error('Apple App Store page is too large');
  }
  return parseReleaseHistoryPage(html);
}
