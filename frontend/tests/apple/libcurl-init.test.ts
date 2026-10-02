import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadWasm, setWebsocket } = vi.hoisted(() => ({ loadWasm: vi.fn(), setWebsocket: vi.fn() }));
vi.mock('libcurl.js/bundled', () => ({ libcurl: { load_wasm: loadWasm, set_websocket: setWebsocket } }));
vi.mock('../../src/components/Auth/PasswordGate', () => ({ getAccessToken: () => null }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

describe('Apple network initialization recovery', () => {
  it('allows retry after failed warm-up instead of caching the rejection forever', async () => {
    loadWasm.mockRejectedValueOnce(new Error('temporary asset failure')).mockResolvedValueOnce(undefined);
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    await expect(initLibcurl()).rejects.toThrow('temporary asset failure');
    await expect(initLibcurl()).resolves.toBeUndefined();
    await initLibcurl();
    expect(loadWasm).toHaveBeenCalledTimes(2);
  });

  it('shares an in-flight initialization between simultaneous callers', async () => {
    let resolve!: () => void;
    loadWasm.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const { initLibcurl } = await import('../../src/apple/libcurl-init');
    const first = initLibcurl();
    const second = initLibcurl();
    expect(loadWasm).toHaveBeenCalledOnce();
    resolve();
    await Promise.all([first, second]);
    await initLibcurl();
    expect(loadWasm).toHaveBeenCalledOnce();
  });
});
