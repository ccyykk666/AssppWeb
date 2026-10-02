import i18n from '../i18n';
import english from '../locales/en-US.json';

const errorKeys = new Map<string, string>();

function indexMessages(value: Record<string, unknown>, prefix: string) {
  for (const [key, message] of Object.entries(value)) {
    const path = `${prefix}.${key}`;
    if (typeof message === 'string' && !message.includes('{{')) {
      errorKeys.set(message, path);
    } else if (message && typeof message === 'object') {
      indexMessages(message as Record<string, unknown>, path);
    }
  }
}

// Translate at display time so persisted task errors follow the chosen language.
indexMessages(english.errors, 'errors');
errorKeys.set('Search failed', 'errors.messages.searchFailed');
errorKeys.set('Lookup failed', 'errors.messages.lookupFailed');
errorKeys.set('Failed to fetch', 'errors.messages.networkFailed');
errorKeys.set('fetch failed', 'errors.messages.networkFailed');
errorKeys.set('Load failed', 'errors.messages.networkFailed');
errorKeys.set('NetworkError when attempting to fetch resource.', 'errors.messages.networkFailed');
errorKeys.set('Network request failed', 'errors.messages.networkFailed');
errorKeys.set('Aborted', 'errors.messages.cancelled');
errorKeys.set('Subscription Required', 'errors.purchase.subscriptionRequired');
errorKeys.set('An unknown error has occurred.', 'errors.purchase.unknownError');

const curlErrors: Record<string, string> = {
  '5': 'proxyFailed',
  '6': 'dnsFailed',
  '7': 'connectionFailed',
  '28': 'timeout',
  '35': 'tlsFailed',
  '52': 'emptyResponse',
  '55': 'transferFailed',
  '56': 'transferFailed',
  '60': 'tlsFailed',
};

export function getErrorMessage(error: unknown, fallback: string): string {
  let message = typeof error === 'string'
    ? error
    : error instanceof Error ? error.message : '';
  if (!message.trim()) return fallback;

  // Backend API errors may arrive as a JSON response rather than plain text.
  try {
    const payload: unknown = JSON.parse(message);
    if (payload && typeof payload === 'object' && 'error' in payload &&
      typeof payload.error === 'string') {
      message = payload.error;
    }
  } catch {
    // Ordinary error messages are not JSON.
  }
  message = message.trim();
  const key = errorKeys.get(message);
  if (key) return i18n.t(key);

  const curlCode = message.match(/Request failed with error code (\d+)\b/i)?.[1];
  if (curlCode) {
    return i18n.t(`errors.messages.${curlErrors[curlCode] ?? 'networkCode'}`, {
      code: curlCode,
    });
  }
  if (/^(?:Could not connect to server|WebSocket.*(?:closed|failed)|Failed to initialize.*WASM)/i.test(message)) {
    return i18n.t('errors.messages.networkFailed');
  }
  if (/timeout|timed out/i.test(message)) return i18n.t('errors.messages.timedOut');
  if (error instanceof Error && error.name === 'AbortError') {
    return i18n.t('errors.messages.cancelled');
  }

  const chunkHttp = message.match(/^Chunk (\d+): HTTP (\d+)/);
  if (chunkHttp) return i18n.t('errors.messages.chunkFailed', { chunk: chunkHttp[1], status: chunkHttp[2] });
  const chunkEmpty = message.match(/^Chunk (\d+): no body/);
  if (chunkEmpty) return i18n.t('errors.messages.chunkEmpty', { chunk: chunkEmpty[1] });
  const chunkIncomplete = message.match(/^Chunk (\d+): expected /);
  if (chunkIncomplete) return i18n.t('errors.messages.incompleteChunk', { chunk: chunkIncomplete[1] });
  const sizeLimit = message.match(/^File size exceeds the maximum limit of (\d+) MB$/);
  if (sizeLimit) return i18n.t('errors.messages.sizeLimit', { limit: sizeLimit[1] });
  if (message.startsWith('File too large:')) return i18n.t('errors.messages.tooLarge');
  if (message.startsWith('Path traversal detected')) return i18n.t('errors.messages.unsafeArchive');
  if (/^Invalid (?:sinf|iTunesMetadata)/.test(message)) return i18n.t('errors.messages.invalidMetadata');
  const appleCode = message.match(/^Apple error (.+)$/);
  if (appleCode) return i18n.t('errors.messages.appleCode', { code: appleCode[1] });
  const sapVersion = message.match(/^Apple Bag advertised unsupported SAP version (.+)$/);
  if (sapVersion) return i18n.t('errors.messages.unsupportedSapVersion', { version: sapVersion[1] });
  const http = message.match(/(?:HTTP\s+|request failed with HTTP\s+)(\d{3})\b/i);
  if (http) return i18n.t('errors.messages.httpFailed', { status: http[1] });

  // Preserve unfamiliar Apple messages rather than inventing their meaning.
  return message;
}
