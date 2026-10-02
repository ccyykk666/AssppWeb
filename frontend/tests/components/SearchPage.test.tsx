import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  useSearch.setState({ term: '', country: 'US', entity: 'iPhone', results: [], loading: false, error: null });
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
    expect(screen.getByRole('textbox')).toBeDisabled();
    screen.getAllByRole('combobox').forEach((select) => expect(select).toBeDisabled());
    await act(async () => resolve([app]));
    expect(button).toHaveAttribute('data-feedback', 'success');
    expect(button).toHaveAccessibleName('搜索: 已完成');
    expect(screen.getByRole('link', { name: /TikTok/ })).toHaveAttribute('href', '/search/123');
    expect(useToastStore.getState().toasts).toEqual([]);
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

  it('keeps failure details at the button and allows retry without a floating toast', async () => {
    vi.mocked(searchApps).mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValueOnce([app]);
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole('textbox'), 'tiktok');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    const button = screen.getByRole('button', { name: '搜索: 失败' });
    expect(button).toBeEnabled();
    expect(document.querySelector('details')).toHaveTextContent('查看原因');
    expect(document.querySelector('details')).not.toHaveAttribute('open');
    expect(useToastStore.getState().toasts).toEqual([]);
    await user.click(button);
    expect(button).toHaveAttribute('data-feedback', 'success');
    expect(document.querySelector('details')).toBeNull();
    expect(searchApps).toHaveBeenCalledTimes(2);
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
