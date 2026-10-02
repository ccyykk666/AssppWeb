import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductDetail from '../../src/components/Search/ProductDetail';
import { useToastStore } from '../../src/store/toast';
import i18n from '../../src/i18n';
import type { Account, Software } from '../../src/types';

const { accountState, acquireLicense } = vi.hoisted(() => ({ accountState: { accounts: [] as Account[] }, acquireLicense: vi.fn() }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => accountState }));
vi.mock('../../src/hooks/useDownloadAction', () => ({
  useDownloadAction: () => ({ startDownload: vi.fn(), acquireLicense }),
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
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => { cleanup(); await i18n.changeLanguage('en-US'); });

describe('product detail section order', () => {
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
