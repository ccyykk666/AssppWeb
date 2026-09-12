import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import searchRoutes from '../src/routes/search.js';

const app = express();
app.use('/api', searchRoutes);
const catalog = (version: unknown = { externalId: 890951385, display: '7.0.41.1' }) => ({
  results: { '1054598922': { bundleId: 'com.mcdonalds.gma.cn', offers: [{ version }] } },
});

describe('current iOS catalog version', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses a fixed public Apple host and the requested storefront without credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => catalog() });
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app).get('/api/catalog-version?id=1054598922&country=CN&host=evil.test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ externalVersionId: '890951385', version: '7.0.41.1', bundleID: 'com.mcdonalds.gma.cn' });
    const [url, options] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('uclient-api.itunes.apple.com');
    expect(parsed.searchParams.get('cc')).toBe('cn');
    expect(parsed.searchParams.get('platform')).toBe('enterprisestore');
    expect(parsed.searchParams.has('host')).toBe(false);
    expect(options.redirect).toBe('error');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers).toBeUndefined();
  });

  it.each(['id=x&country=CN', 'id=1&country=evil.test', 'id=1&id=2&country=CN', 'country=CN'])(
    'rejects invalid input %s', async (query) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect((await request(app).get(`/api/catalog-version?${query}`)).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('supports the catalog buyParams version fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: {
      '1054598922': { bundleId: 'com.mcdonalds.gma.cn', offers: [{ buyParams: 'appExtVrsId=890951385' }] },
    } }) }));
    expect((await request(app).get('/api/catalog-version?id=1054598922&country=CN')).body.externalVersionId).toBe('890951385');
  });

  it.each([{}, catalog({}), catalog({ externalId: 'bad' })])('does not guess absent/malformed versions', async (data) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => data }));
    const res = await request(app).get('/api/catalog-version?id=1054598922&country=CN');
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it('preserves upstream failure rather than interpreting it as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect((await request(app).get('/api/catalog-version?id=1054598922&country=CN')).status).toBe(502);
  });
});
