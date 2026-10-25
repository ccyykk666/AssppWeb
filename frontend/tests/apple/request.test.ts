import { afterEach, describe, expect, it, vi } from 'vitest';
import { appleRequest } from '../../src/apple/request';
import { initLibcurl, libcurl } from '../../src/apple/libcurl-init';

vi.mock('../../src/apple/libcurl-init', () => ({ initLibcurl: vi.fn().mockResolvedValue(undefined), libcurl: { fetch: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('Apple request lifecycle', () => {
  it('aborts a stalled transport instead of leaving the action spinning', async () => {
    vi.useFakeTimers();
    vi.mocked(libcurl.fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const result = appleRequest({ host: 'buy.itunes.apple.com', path: '/', method: 'POST', timeoutMs: 1000 });
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('cancels the wait even when networking WASM has not finished initializing', async () => {
    vi.mocked(initLibcurl).mockImplementationOnce(() => new Promise(() => undefined));
    const controller = new AbortController();
    const result = appleRequest({ host: 'buy.itunes.apple.com', path: '/', method: 'POST', signal: controller.signal });
    controller.abort(new DOMException('Page changed', 'AbortError'));
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(libcurl.fetch).not.toHaveBeenCalled();
  });
});
