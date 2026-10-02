import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetail from '../../src/components/Search/ProductDetail';
import { useToastStore } from '../../src/store/toast';
import i18n from '../../src/i18n';
import type { Account, Software } from '../../src/types';

const { accountState, acquireLicense, startDownload } = vi.hoisted(() => ({ accountState: { accounts: [] as Account[] }, acquireLicense: vi.fn(), startDownload: vi.fn() }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => accountState }));
vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({ startDownload, acquireLicense }),
}));
vi.mock('../../src/api/search', () => ({ lookupApp: vi.fn(), lookupLatestAppVersion: vi.fn().mockResolvedValue(null) }));

const app = {
  id: 123, name: 'Test App', artistName: 'Developer', artworkUrl: '',
  averageUserRating: 4.5, userRatingCount: 100, version: '1.0',
  description: 'App description', releaseNotes: 'Latest changes', releaseDate: '2026-10-01',
} as Software;

function renderDetail(software: Software) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/search/123', state: { app: software, country: 'US' } }]}>
      <Routes><Route path="/search/:appId" element={<ProductDetail />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  accountState.accounts = [];
  acquireLicense.mockReset();
  startDownload.mockReset().mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => { cleanup(); await i18n.changeLanguage('en-US'); });

describe('product detail section order', () => {
  it('keeps the account, download and history available during a license request', async () => {
    const first = { email: 'first@example.com', store: '143441', firstName: 'First', lastName: '' } as Account;
    const second = { ...first, email: 'second@example.com' };
    accountState.accounts = [first, second];
    let resolve!: (value: { status: string }) => void;
    acquireLicense.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderDetail(app);
    fireEvent.click(screen.getByRole('button', { name: '获取许可证' }));
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(screen.getByRole('button', { name: '下载' })).toBeEnabled();
    expect(screen.getByRole('link', { name: '历史版本' })).toHaveAttribute('href', '/search/123/versions');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '下载' })));
    expect(startDownload).toHaveBeenCalledExactlyOnceWith(first, app);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: second.email } });
    expect(screen.getByRole('button', { name: '获取许可证' })).toBeEnabled();
    await act(async () => resolve({ status: 'alreadyOwned' }));
    expect(screen.getByRole('combobox')).toHaveValue(second.email);
    expect(screen.getByRole('button', { name: '获取许可证' })).toHaveAttribute('data-feedback', 'idle');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('keeps history in a non-stretching action row after license failure', async () => {
    accountState.accounts = [{ email: 'test@example.com', store: '143441', firstName: 'Test', lastName: '' } as Account];
    acquireLicense.mockRejectedValueOnce(new Error('Apple 许可证接口返回 HTTP 404，请稍后重试。'));
    renderDetail(app);
    const history = screen.getByRole('link', { name: '历史版本' });
    expect(history.parentElement).toHaveClass('items-start');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '获取许可证' })));
    expect(screen.getByRole('button', { name: '获取许可证' })).toBeEnabled();
    expect(document.querySelector('details')).toBeNull();
    expect(history).toHaveTextContent('历史版本');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe('error');
  });

  it('places clickable release notes before the description', () => {
    renderDetail(app);
    const releaseNotes = screen.getByRole('heading', { name: '更新日志' });
    const description = screen.getByRole('heading', { name: '描述' });
    expect(releaseNotes.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(releaseNotes.closest('a')).toHaveAttribute('href', '/search/123/release-notes');
    expect(screen.getByText('Latest changes')).toBeInTheDocument();
  });

  it('still displays the description when release notes are unavailable', () => {
    renderDetail({ ...app, releaseNotes: undefined });
    expect(screen.queryByRole('heading', { name: '更新日志' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '描述' })).toBeInTheDocument();
  });
});
