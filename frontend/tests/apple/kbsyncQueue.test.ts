import { expect, it, vi } from 'vitest';
import { generateKBSync } from '../../src/apple/kbsync/generate';
import { obtainKBSync, prefetchKBSync } from '../../src/apple/kbsync';
import type { Account } from '../../src/types';

vi.mock('../../src/apple/kbsync/generate', () => ({ generateKBSync: vi.fn() }));
it('preempts background emulation for the account explicitly selected by the user', async () => {
  localStorage.clear();
  const calls: number[] = [];
  vi.mocked(generateKBSync).mockImplementation(async (_guid, dsid, _progress, signal) => {
    calls.push(dsid);
    if (calls.length === 1) return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
    return `blob-${dsid}`;
  });
  prefetchKBSync([{ deviceIdentifier: 'AABBCCDDEEFF', directoryServicesIdentifier: '1' } as Account]);
  await vi.waitFor(() => expect(calls).toEqual([1]));
  await expect(obtainKBSync('112233445566', 2)).resolves.toBe('blob-2');
  await vi.waitFor(() => expect(calls).toEqual([1, 2, 1]));
});
