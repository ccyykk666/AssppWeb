import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SearchPage from '../../src/components/Search/SearchPage';
import { searchApps } from '../../src/api/search';
import { useSearch } from '../../src/hooks/useSearch';
import { useSettingsStore } from '../../src/store/settings';
import { useToastStore } from '../../src/store/toast';
import i18n from '../../src/i18n';
import type { Software } from '../../src/types';

vi.mock('../../src/api/search', () => ({ searchApps: vi.fn(), lookupApp: vi.fn() }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ accounts: [] }) }));

const app = {
  id: 123, name: 'TikTok', artistName: 'Test developer', artworkUrl: '',
  averageUserRating: 4.5, userRatingCount: 100, primaryGenreName: 'Entertainment',
} as Software;

function renderSearch() {
  return render(<MemoryRouter initialEntries={['/search']}><SearchPage /></MemoryRouter>);
}

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-CN');
  useSearch.setState({ term: '', country: 'US', entity: 'iPhone', results: [], resultsCountry: '', loading: false, error: null });
  useSettingsStore.setState({ defaultCountry: 'US', defaultEntity: 'iPhone' });
  useToastStore.setState({ toasts: [] });
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en-US');
});

describe('search button local feedback', () => {
  it('shows only a spinner while searching, blocks duplicate requests, then confirms completion', async () => {
    let resolve!: (apps: Software[]) => void;
    vi.mocked(searchApps).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderSearch();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tiktok' } });
    const button = screen.getByRole('button', { name: '搜索' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(searchApps).toHaveBeenCalledExactlyOnceWith('tiktok', 'US', 'iPhone');
    expect(button).toHaveAttribute('data-feedback', 'pending');
    expect(button).toHaveAccessibleName('搜索: 搜索中...');
    expect(button.querySelector('.action-button-content')).toHaveTextContent('');
    expect(button.querySelector('.action-button-content svg')).not.toBeNull();
    expect(button).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeEnabled();
    screen.getAllByRole('combobox').forEach((select) => expect(select).toBeEnabled());
    await act(async () => resolve([app]));
    expect(button).toHaveAttribute('data-feedback', 'success');
    expect(button).toHaveAccessibleName('搜索: 已加载');
    expect(screen.getByRole('link', { name: /TikTok/ })).toHaveAttribute('href', '/search/123');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('allows editing the next query while a search is pending', async () => {
    let resolve!: (apps: Software[]) => void;
    vi.mocked(searchApps).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderSearch();
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'tiktok' } });
    fireEvent.click(screen.getByRole('button'));
    fireEvent.change(input, { target: { value: 'weibo' } });
    expect(input).toHaveValue('weibo');
    await act(async () => resolve([app]));
    expect(input).toHaveValue('weibo');
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'idle');
    expect(searchApps).toHaveBeenCalledExactlyOnceWith('tiktok', 'US', 'iPhone');
  });

  it('submits once with Enter and keeps feedback when trimming the query', async () => {
    vi.mocked(searchApps).mockResolvedValueOnce([app]);
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('textbox'), '  tiktok  {Enter}');
    await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'success'));
    expect(searchApps).toHaveBeenCalledExactlyOnceWith('tiktok', 'US', 'iPhone');
    expect(useSearch.getState().term).toBe('tiktok');
  });

  it('uses the original error bar without changing the button layout and allows retry', async () => {
    vi.mocked(searchApps).mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce([app]);
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('textbox'), 'tiktok');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    const button = screen.getByRole('button', { name: '搜索' });
    expect(button).toBeEnabled();
    expect(document.querySelector('details')).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: i18n.t('errors.messages.searchFailed') }),
    ]);
    await user.click(button);
    expect(button).toHaveAttribute('data-feedback', 'success');
    expect(document.querySelector('details')).toBeNull();
    expect(searchApps).toHaveBeenCalledTimes(2);
  });

  it('allows filter changes during search while preserving the results storefront', async () => {
    let resolve!: (apps: Software[]) => void;
    vi.mocked(searchApps).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const user = userEvent.setup();
    function ResultContext() {
      const location = useLocation();
      return <p>Result country: {location.state.country}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/search']}>
        <Routes>
          <Route path="/search" element={<SearchPage />} />
          <Route path="/search/:appId" element={<ResultContext />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.type(screen.getByRole('textbox'), 'tiktok');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    const [country, entity] = screen.getAllByRole('combobox');
    await user.selectOptions(country, 'CN');
    await user.selectOptions(entity, 'iPad');
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'pending');
    await act(async () => resolve([app]));
    expect(country).toHaveValue('CN');
    expect(entity).toHaveValue('iPad');
    expect(screen.getByRole('button')).toHaveAccessibleName('搜索: 已加载');
    expect(searchApps).toHaveBeenCalledExactlyOnceWith('tiktok', 'US', 'iPhone');
    await user.click(screen.getByRole('link', { name: /TikTok/ }));
    expect(screen.getByText('Result country: US')).toBeInTheDocument();
  });

  it('uses equal-height aligned controls across idle, pending and loaded states', async () => {
    vi.mocked(searchApps).mockResolvedValueOnce([app]);
    renderSearch();
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: '搜索' });
    expect(input).toHaveClass('h-11');
    expect(button).toHaveClass('h-11', 'text-base', 'rounded-md');
    expect(input.parentElement).toHaveClass('items-center');
    fireEvent.change(input, { target: { value: 'tiktok' } });
    await act(async () => fireEvent.click(button));
    expect(button).toHaveClass('h-11');
  });

  it('does not search blank input by click or Enter', async () => {
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('textbox'), '   {Enter}');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(searchApps).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('retains pending feedback when returning to an in-flight search', () => {
    useSearch.setState({ term: 'tiktok', loading: true });
    renderSearch();
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'pending');
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    expect(searchApps).not.toHaveBeenCalled();
    act(() => useSearch.setState({ loading: false }));
    expect(screen.getByRole('button')).toBeEnabled();
  });
});
