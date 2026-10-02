import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadAction } from '../../src/hooks/useDownloadAction';
import { useToastStore } from '../../src/store/toast';
import { purchaseApp } from '../../src/apple/purchase';
import { getDownloadInfo } from '../../src/apple/download';
import { apiGet, apiPost } from '../../src/api/client';
import { listVersions, VersionHistoryError } from '../../src/apple/versionFinder';
import i18n from '../../src/i18n';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ updateAccount: vi.fn() }) }));
vi.mock('../../src/apple/purchase', async (original) => ({ ...await original<object>(), purchaseApp: vi.fn() }));
vi.mock('../../src/apple/download', () => ({ getDownloadInfo: vi.fn() }));
vi.mock('../../src/apple/versionFinder', async (original) => ({ ...await original<object>(), listVersions: vi.fn() }));
vi.mock('../../src/apple/libcurl-init', () => ({ initLibcurl: vi.fn() }));
vi.mock('../../src/api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../src/utils/account', () => ({ accountHash: vi.fn().mockResolvedValue('hash') }));
vi.mock('../../src/store/downloads', () => ({ useDownloadsStore: (select: (s: unknown) => unknown) => select({ fetchTasks: vi.fn() }) }));

const account = { email: 'test@example.com', firstName: 'Test', lastName: '', store: '143465', cookies: [] } as unknown as Account;
const app = { id: 1, name: 'Test App', price: 0 } as Software;
// The hook deliberately caches static settings for the lifetime of the page.
const settings = { maxDownloadMB: 10 };
beforeEach(async () => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  vi.mocked(apiGet).mockResolvedValue(settings);
  vi.mocked(purchaseApp).mockResolvedValue({ status: 'alreadyOwned', updatedCookies: [] });
  vi.mocked(getDownloadInfo).mockResolvedValue({ output: { bundleShortVersionString: '1.0' }, updatedCookies: [] } as never);
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => { cleanup(); await i18n.changeLanguage('en-US'); });

describe('local download notifications', () => {
  it('returns owned/acquired results without duplicating a global toast', async () => {
    const { result } = renderHook(() => useDownloadAction({ localFeedback: true }));
    await act(async () => {
      expect(await result.current.acquireLicense(account, app)).toMatchObject({ status: 'alreadyOwned' });
      vi.mocked(purchaseApp).mockResolvedValueOnce({ status: 'acquired', updatedCookies: [] });
      expect(await result.current.acquireLicense(account, app)).toMatchObject({ status: 'acquired' });
    });
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('creates a download without a global toast and preserves historical build IDs', async () => {
    const { result } = renderHook(() => useDownloadAction({ localFeedback: true }));
    await act(async () => { await result.current.startDownload(account, app, '123'); });
    expect(getDownloadInfo).toHaveBeenCalledWith(account, app, '123');
    expect(apiPost).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('rejects over-limit downloads instead of displaying false success', async () => {
    const { result } = renderHook(() => useDownloadAction({ localFeedback: true }));
    await act(async () => {
      await expect(result.current.startDownload(account, { ...app, fileSizeBytes: String(20 * 1024 * 1024) })).rejects.toThrow();
    });
    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('does not toast for the automatic license retry while loading history', async () => {
    vi.mocked(listVersions).mockRejectedValueOnce(new VersionHistoryError('license required', '9610'))
      .mockResolvedValueOnce({ versions: ['123'], updatedCookies: [] });
    const { result } = renderHook(() => useDownloadAction({ localFeedback: true }));
    await act(async () => {
      expect(await result.current.loadVersions(account, app)).toMatchObject({ versions: ['123'] });
    });
    expect(purchaseApp).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('retains global notifications for background callers', async () => {
    const { result } = renderHook(() => useDownloadAction());
    await act(async () => { await result.current.acquireLicense(account, app); });
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
