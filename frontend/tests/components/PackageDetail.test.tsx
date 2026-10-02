import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PackageDetail from '../../src/components/Download/PackageDetail';
import i18n from '../../src/i18n';
import type { DownloadTask } from '../../src/types';

const mocks = vi.hoisted(() => ({ tasks: [] as DownloadTask[], pauseDownload: vi.fn(), resumeDownload: vi.fn() }));
vi.mock('../../src/hooks/useDownloads', () => ({ useDownloads: () => ({ ...mocks, deleteDownload: vi.fn(), hashToEmail: {} }) }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ accounts: [] }) }));
vi.mock('../../src/hooks/useDownloadAction', () => ({ useDownloadAction: () => ({ startDownload: vi.fn(), loadVersions: vi.fn() }) }));
const task = {
  id: 'fixture-task', accountHash: 'fixture-hash', status: 'completed', progress: 100,
  software: { id: 123, name: 'Fixture IPA', version: '1.0', bundleID: 'com.fixture.ipa', artworkUrl: '' },
  createdAt: '2026-10-01',
} as DownloadTask;

function renderPackage() {
  return render(<MemoryRouter initialEntries={['/downloads/fixture-task']}><Routes><Route path="/downloads/:id" element={<PackageDetail />} /></Routes></MemoryRouter>);
}
beforeEach(async () => {
  mocks.tasks = [task];
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => { cleanup(); vi.unstubAllGlobals(); await i18n.changeLanguage('en-US'); });

describe('package task narrowing', () => {
  it('safely renders a missing task without exposing task actions', () => {
    mocks.tasks = [{ ...task, id: 'other-task' }];
    renderPackage();
    expect(screen.getByText(i18n.t('downloads.package.notFound'))).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['downloading', 'paused'] as const)('uses the correct ID for a %s task action', async (status) => {
    mocks.tasks = [{ ...task, status }];
    renderPackage();
    const operation = status === 'downloading' ? 'pause' : 'resume';
    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t(`downloads.package.${operation}`) })));
    expect(operation === 'pause' ? mocks.pauseDownload : mocks.resumeDownload).toHaveBeenCalledExactlyOnceWith(task.id);
  });

  it('uses the captured task ID and account hash when downloading an IPA', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    renderPackage();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.package.downloadIpa') })));
    expect(fetchMock).toHaveBeenCalledWith(`/api/packages/${task.id}/file?accountHash=${task.accountHash}`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
