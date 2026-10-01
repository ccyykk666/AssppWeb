import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import releaseHistoryRoutes from '../src/routes/releaseHistory.js';
import { parseReleaseHistoryPage } from '../src/services/releaseHistory.js';

const historyPage = (appName = 'Example App') => `<!doctype html>
<script type="application/json" id="serialized-server-data">${JSON.stringify({
  data: [{
    data: {
      title: appName,
      shelfMapping: {
        mostRecentVersion: {
          seeAllAction: {
            pageData: {
              pageFields: { pageType: 'VersionHistory' },
              shelves: [{ items: [
                {
                  primarySubtitle: '2.1.0',
                  secondarySubtitle: 'Wed Sep 30 2026 02:07:23 GMT+0000',
                  text: 'Faster downloads',
                },
                {
                  primarySubtitle: '2.0.0',
                  secondarySubtitle: 'Wed Aug 20 2026 02:07:23 GMT+0000',
                  text: 'New design',
                },
              ] }],
            },
          },
        },
      },
    },
  }],
})}</script>`;

describe('Apple release history', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses version, date, and notes from serialized App Store data', () => {
    const result = parseReleaseHistoryPage(historyPage());
    expect(result.appName).toBe('Example App');
    expect(result.entries).toEqual([
      {
        version: '2.1.0',
        releaseDate: '2026-09-30T02:07:23.000Z',
        releaseNotes: 'Faster downloads',
      },
      {
        version: '2.0.0',
        releaseDate: '2026-08-20T02:07:23.000Z',
        releaseNotes: 'New design',
      },
    ]);
  });

  it('uses the fixed Apple host and returns the public history', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => historyPage('Fetched App'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const app = express();
    app.use('/api', releaseHistoryRoutes);

    const response = await request(app).get(
      '/api/release-history?id=123456789&country=CN&language=zh-Hans-CN',
    );
    expect(response.status).toBe(200);
    expect(response.body.appName).toBe('Fetched App');
    const [url, options] = fetchMock.mock.calls[0];
    expect(url.hostname).toBe('apps.apple.com');
    expect(url.pathname).toBe('/cn/app/id123456789');
    expect(url.searchParams.get('l')).toBe('zh-Hans-CN');
    expect(options.redirect).toBe('manual');
  });

  it('follows only Apple canonical redirects and preserves the language', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 301,
        headers: new Headers({
          location: 'https://apps.apple.com/cn/app/example/id987654321',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => historyPage(),
      });
    vi.stubGlobal('fetch', fetchMock);
    const app = express();
    app.use('/api', releaseHistoryRoutes);

    const response = await request(app).get(
      '/api/release-history?id=987654321&country=CN&language=zh-Hans-CN',
    );
    expect(response.status).toBe(200);
    const redirectedUrl = fetchMock.mock.calls[1][0] as URL;
    expect(redirectedUrl.hostname).toBe('apps.apple.com');
    expect(redirectedUrl.searchParams.get('l')).toBe('zh-Hans-CN');
  });

  it.each([
    'id=x&country=CN',
    'id=123&country=evil.test',
    'id=123&country=CN&language=../../bad',
    'country=CN',
  ])('rejects invalid input %s', async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = express();
    app.use('/api', releaseHistoryRoutes);
    expect((await request(app).get(`/api/release-history?${query}`)).status)
      .toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
