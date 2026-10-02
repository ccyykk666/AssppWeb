import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import Spinner from "../common/Spinner";
import ActionButton from '../common/ActionButton';
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useRequestContext } from '../../hooks/useRequestContext';
import { lookupLatestAppVersion } from '../../api/search';
import { resolveVersionMetadata } from "../../apple/versionMetadataResolver";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";
import type { Software, VersionMetadata } from "../../types";

export default function VersionHistory() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts, updateAccount } = useAccounts();
  const { t, i18n } = useTranslation();
  const { startDownload, loadVersions } =
    useDownloadAction({ localFeedback: true });

  const stateApp = (location.state as { app?: Software; country?: string })
    ?.app;
  const stateCountry = (location.state as { country?: string })?.country;
  const country = stateCountry ?? "US";

  const [app] = useState<Software | null>(stateApp ?? null);
  const [selectedAccount, setSelectedAccount] = useState("");

  const filteredAccounts = useMemo(
    () => accounts.filter((a) => storeIdToCountry(a.store) === country),
    [accounts, country],
  );
  const [versions, setVersions] = useState<string[]>([]);
  const [versionMeta, setVersionMeta] = useState<
    Record<string, VersionMetadata>
  >({});
  const [loadingMeta, setLoadingMeta] = useState<Record<string, boolean>>({});
  const [metaErrors, setMetaErrors] = useState<Record<string, string>>({});
  const captureContext = useRequestContext(`${app?.id}:${country}:${selectedAccount}`);

  useEffect(() => {
    setVersions([]);
    setVersionMeta({});
    setLoadingMeta({});
    setMetaErrors({});
  }, [app?.id, country, selectedAccount]);

  useEffect(() => {
    if (
      filteredAccounts.length > 0 &&
      !filteredAccounts.some((a) => a.email === selectedAccount)
    ) {
      setSelectedAccount(filteredAccounts[0].email);
    }
  }, [filteredAccounts, selectedAccount]);

  const account = filteredAccounts.find((a) => a.email === selectedAccount);

  async function handleLoadVersions() {
    if (!account || !app) return;
    const isCurrent = captureContext();
    const [result, latest] = await Promise.all([
      loadVersions(account, app),
      lookupLatestAppVersion(app.id, country).catch(() => null),
    ]);
    await updateAccount({ ...account, cookies: result.updatedCookies });
    if (!isCurrent()) return;
    setVersions(result.versions);
    if (
      latest?.bundleID === app.bundleID && latest.version && app.releaseDate &&
      result.versions.includes(latest.externalVersionId)
    ) {
      setVersionMeta((previous) => ({
        ...previous,
        [latest.externalVersionId]: {
          displayVersion: latest.version,
          releaseDate: app.releaseDate,
        },
      }));
    }
  }

  async function handleLoadMeta(versionId: string) {
    if (!account || !app || versionMeta[versionId] || loadingMeta[versionId]) return;
    const isCurrent = captureContext();
    setLoadingMeta((prev) => ({ ...prev, [versionId]: true }));
    setMetaErrors((previous) => {
      const next = { ...previous };
      delete next[versionId];
      return next;
    });
    try {
      const result = await resolveVersionMetadata(account, app, versionId);
      await updateAccount({ ...account, cookies: result.updatedCookies });
      if (!isCurrent()) return;
      setVersionMeta((prev) => ({ ...prev, [versionId]: result.metadata }));
    } catch (error) {
      if (!isCurrent()) return;
      setMetaErrors((previous) => ({
        ...previous,
        [versionId]: getErrorMessage(
          error,
          t('search.versions.detailsUnavailable'),
        ),
      }));
    } finally {
      if (isCurrent()) setLoadingMeta((prev) => ({ ...prev, [versionId]: false }));
    }
  }

  async function handleDownloadVersion(versionId: string) {
    if (!account || !app) return;
    await startDownload(account, app, versionId);
  }

  if (!app) {
    return (
      <PageContainer title={t("search.versions.title")}>
        <p className="text-gray-500">{t("search.versions.unavailable")}</p>
      </PageContainer>
    );
  }

  return (
    <PageContainer title={t("search.versions.title")}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <AppIcon url={app.artworkUrl} name={app.name} size="md" />
          <div>
            <h2 className="font-medium text-gray-900 dark:text-white">
              {app.name}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {app.bundleID}
            </p>
          </div>
        </div>

        {accounts.length > 0 && filteredAccounts.length === 0 ? (
          <div className="p-4 bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-lg text-sm text-yellow-700 dark:text-yellow-400">
            {t("search.product.noAccountsForRegion")}
          </div>
        ) : (
          filteredAccounts.length > 0 && (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t("search.versions.account")}
                </label>
                <select
                  value={selectedAccount}
                  onChange={(e) => setSelectedAccount(e.target.value)}
                  className="rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white w-full focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                >
                  {filteredAccounts.map((a) => (
                    <option key={a.email} value={a.email}>
                      {a.firstName} {a.lastName} ({a.email})
                    </option>
                  ))}
                </select>
              </div>
              <ActionButton
                action={handleLoadVersions}
                label={versions.length > 0 ? t('search.versions.refresh') : t('search.versions.load')}
                pendingLabel={t('search.versions.loading')}
                successLabel={t('common.versionsLoaded')}
                errorLabel={t('search.versions.loadFailed')}
                contextKey={`${app.id}:${selectedAccount}`}
                disabled={!account}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              />
            </div>
          )
        )}

        {versions.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-200 dark:divide-gray-800">
            {versions.map((versionId) => {
              const meta = versionMeta[versionId];
              const isLoadingMeta = loadingMeta[versionId];
              const metaError = metaErrors[versionId];

              return (
                <div
                  key={versionId}
                  className="p-4 flex items-start justify-between gap-3"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {meta ? `v${meta.displayVersion}` : t('search.versions.buildId', { id: versionId })}
                    </p>
                    {meta && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(meta.releaseDate).toLocaleDateString(i18n.resolvedLanguage)}
                      </p>
                    )}
                    {!meta && !isLoadingMeta && !metaError && (
                      <button
                        onClick={() => handleLoadMeta(versionId)}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 py-1 transition-colors"
                      >
                        {t("search.versions.loadDetails")}
                      </button>
                    )}
                    {isLoadingMeta && (
                      <span className="inline-flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                        <Spinner />
                        {t("search.versions.loading")}
                      </span>
                    )}
                    {metaError && !isLoadingMeta && (
                      <div className="mt-1">
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {metaError}
                        </p>
                        <button
                          onClick={() => handleLoadMeta(versionId)}
                          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 py-1 transition-colors"
                        >
                          {t('search.versions.retryDetails')}
                        </button>
                      </div>
                    )}
                  </div>
                  <ActionButton
                    action={() => handleDownloadVersion(versionId)}
                    label={t('search.versions.download')}
                    pendingLabel={t('search.versions.downloading')}
                    successLabel={t('common.downloadQueued')}
                    errorLabel={t('toast.title.downloadFailed')}
                    contextKey={`${app.id}:${selectedAccount}:${versionId}`}
                    disabled={!account}
                    className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
