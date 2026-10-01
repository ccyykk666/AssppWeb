import { Router, type Request, type Response } from 'express';
import {
  fetchReleaseHistory,
  type ReleaseHistoryResult,
} from '../services/releaseHistory.js';

const router = Router();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 128;
const cache = new Map<string, { expiresAt: number; value: ReleaseHistoryResult }>();
const inFlight = new Map<string, Promise<ReleaseHistoryResult>>();

function cacheResult(key: string, value: ReleaseHistoryResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

router.get('/release-history', async (req: Request, res: Response) => {
  const { id, country, language = 'en-US' } = req.query;
  if (typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) ||
    typeof country !== 'string' || !/^[a-z]{2}$/i.test(country) ||
    typeof language !== 'string' ||
    !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(language)) {
    res.status(400).json({ error: 'Invalid app ID, country, or language' });
    return;
  }

  const key = `${id}:${country.toUpperCase()}:${language.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(cached.value);
    return;
  }
  if (cached) cache.delete(key);

  try {
    let request = inFlight.get(key);
    if (!request) {
      request = fetchReleaseHistory(id, country, language);
      inFlight.set(key, request);
      request.finally(() => inFlight.delete(key)).catch(() => undefined);
    }
    const result = await request;
    cacheResult(key, result);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(result);
  } catch (error) {
    console.error(
      'Release history error:',
      error instanceof Error ? error.message : error,
    );
    res.status(502).json({ error: 'Apple release history request failed' });
  }
});

export default router;
