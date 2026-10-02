import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddDownload from '../../src/components/Download/AddDownload';
import VersionHistory from '../../src/components/Search/VersionHistory';
import { useSettingsStore } from '../../src/store/settings';
import { useToastStore } from '../../src/store/toast';
import i18n from '../../src/i18n';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({
  accounts: [] as Account[], updateAccount: vi.fn(), startDownload: vi.fn(),
  acquireLicense: vi.fn(), loadVersions: vi.fn(), lookupApp: vi.fn(), lookupLatest: vi.fn(), resolveMeta: vi.fn(),
}));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ accounts: mocks.accounts, updateAccount: mocks.updateAccount }) }));
vi.mock('../../src/hooks/useDownloadAction', () => ({ useDownloadAction: () => mocks }));
vi.mock('../../src/api/search', () => ({ lookupApp: mocks.lookupApp, lookupLatestAppVersion: mocks.lookupLatest }));
vi.mock('../../src/apple/versionMetadataResolver', () => ({ resolveVersionMetadata: mocks.resolveMeta }));

const app = { id: 123, name: 'Fixture App', bundleID: 'com.fixture.app', version: '1.0', artistName: 'Fixture', artworkUrl: '' } as Software;
const first = { email: 'first@example.com', store: '143441', firstName: 'First', lastName: '', cookies: [] } as Account;
const second = { ...first, email: 'second@example.com' };
const versionResult = { versions: ['101', '102'], updatedCookies: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function renderVersions() {
  return render(<MemoryRouter initialEntries={[{ pathname: '/search/123/versions', state: { app, country: 'US' } }]}><VersionHistory /></MemoryRouter>);
}
async function renderAddDownload() {
  render(<MemoryRouter><AddDownload /></MemoryRouter>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: app.bundleID } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.lookup') })));
}
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.accounts = [first, second];
  mocks.updateAccount.mockResolvedValue(undefined);
  mocks.startDownload.mockResolvedValue(undefined);
  mocks.acquireLicense.mockResolvedValue({ status: 'alreadyOwned' });
  mocks.loadVersions.mockResolvedValue(versionResult);
  mocks.lookupApp.mockResolvedValue(app);
  mocks.lookupLatest.mockResolvedValue(null);
  useSettingsStore.setState({ defaultCountry: 'US' });
  useToastStore.setState({ toasts: [] });
  await i18n.changeLanguage('zh-CN');
});
afterEach(async () => { cleanup(); await i18n.changeLanguage('en-US'); });

describe('independent history actions', () => {
  it('allows account switching and discards the previous account version list', async () => {
    const request = deferred<typeof versionResult>();
    mocks.loadVersions.mockReturnValueOnce(request.promise);
    renderVersions();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('search.versions.load') }));
    const select = screen.getByRole('combobox');
    expect(select).toBeEnabled();
    fireEvent.change(select, { target: { value: second.email } });
    expect(screen.getByRole('button')).toBeEnabled();
    await act(async () => request.resolve(versionResult));
    expect(screen.queryByText('ID: 101')).not.toBeInTheDocument();
    expect(select).toHaveValue(second.email);
    expect(screen.getByRole('button')).toHaveAttribute('data-feedback', 'idle');
    expect(mocks.updateAccount).toHaveBeenCalledWith({ ...first, cookies: [] });
    await act(async () => fireEvent.click(screen.getByRole('button')));
    expect(mocks.loadVersions).toHaveBeenLastCalledWith(second, app);
    expect(screen.getByText('ID: 101')).toBeInTheDocument();
  });

  it('keeps other versions, refresh and account controls usable during a download', async () => {
    const request = deferred<void>();
    mocks.startDownload.mockReturnValueOnce(request.promise);
    renderVersions();
    await act(async () => fireEvent.click(screen.getByRole('button')));
    const [download, otherDownload] = screen.getAllByRole('button', { name: i18n.t('search.versions.download') });
    fireEvent.click(download);
    expect(download).toBeDisabled();
    expect(otherDownload).toBeEnabled();
    expect(screen.getByRole('combobox')).toBeEnabled();
    expect(screen.getByRole('button', { name: new RegExp(i18n.t('search.versions.refresh')) })).toBeEnabled();
    await act(async () => fireEvent.click(otherDownload));
    expect(mocks.startDownload).toHaveBeenNthCalledWith(1, first, app, '101');
    expect(mocks.startDownload).toHaveBeenNthCalledWith(2, first, app, '102');
    await act(async () => request.resolve());
  });

  it('does not show stale metadata errors after switching accounts', async () => {
    const request = deferred<never>();
    mocks.resolveMeta.mockReturnValueOnce(request.promise);
    renderVersions();
    await act(async () => fireEvent.click(screen.getByRole('button')));
    fireEvent.click(screen.getAllByRole('button', { name: i18n.t('search.versions.loadDetails') })[0]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: second.email } });
    await act(async () => request.reject(new Error('stale failure')));
    expect(screen.queryByText('stale failure')).not.toBeInTheDocument();
    expect(screen.queryByText('ID: 101')).not.toBeInTheDocument();
  });
});

describe('independent add-download actions', () => {
  it('keeps lookup, selectors and other actions enabled during license acquisition', async () => {
    const request = deferred<{ status: string }>();
    mocks.acquireLicense.mockReturnValueOnce(request.promise);
    await renderAddDownload();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.getLicense') }));
    expect(screen.getByRole('textbox')).toBeEnabled();
    screen.getAllByRole('combobox').forEach((select) => expect(select).toBeEnabled());
    expect(screen.getByRole('button', { name: i18n.t('downloads.add.lookup') })).toBeEnabled();
    expect(screen.getByRole('button', { name: i18n.t('downloads.add.selectVersion') })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.download') })));
    expect(mocks.startDownload).toHaveBeenCalledExactlyOnceWith(first, app, undefined);
    await act(async () => request.resolve({ status: 'alreadyOwned' }));
  });

  it('discards version choices from the previous account', async () => {
    const request = deferred<typeof versionResult>();
    mocks.loadVersions.mockReturnValueOnce(request.promise);
    await renderAddDownload();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.selectVersion') }));
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: second.email } });
    await act(async () => request.resolve(versionResult));
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: i18n.t('downloads.add.selectVersion') })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.selectVersion') })));
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    const versionSelect = screen.getAllByRole('combobox')[2];
    const download = deferred<void>();
    mocks.startDownload.mockReturnValueOnce(download.promise);
    fireEvent.click(screen.getByRole('button', { name: i18n.t('downloads.add.download') }));
    expect(versionSelect).toBeEnabled();
    fireEvent.change(versionSelect, { target: { value: '102' } });
    expect(versionSelect).toHaveValue('102');
    await act(async () => download.resolve());
    expect(mocks.startDownload).toHaveBeenLastCalledWith(second, app, undefined);
  });

  it('keeps lookup inputs editable and drops a stale lookup result', async () => {
    const request = deferred<Software>();
    mocks.lookupApp.mockReturnValueOnce(request.promise);
    render(<MemoryRouter><AddDownload /></MemoryRouter>);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: app.bundleID } });
    fireEvent.click(screen.getByRole('button'));
    expect(input).toBeEnabled();
    screen.getAllByRole('combobox').forEach((select) => expect(select).toBeEnabled());
    fireEvent.change(input, { target: { value: 'com.fixture.next' } });
    await act(async () => request.resolve(app));
    expect(screen.queryByText(app.name)).not.toBeInTheDocument();
    expect(input).toHaveValue('com.fixture.next');
  });
});
