import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useToastStore } from "../../store/toast";
import { listVersions } from "../../apple/versionFinder";
import {
  cancelQueuedVersionMetadata,
  resolveVersionMetadata,
  setQueuedVersionMetadataPriority,
  VersionMetadataRequestCancelled,
} from "../../apple/versionMetadataResolver";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";
import type { Software, VersionMetadata } from "../../types";

interface VersionRowProps {
  versionId: string;
  metadata?: VersionMetadata;
  isLoading: boolean;
  hasError: boolean;
  isDownloading: boolean;
  disableDownload: boolean;
  onLoadMetadata: (versionId: string, priority?: 0 | 1) => void;
  onSetPriority: (versionId: string, priority: 0 | 1) => void;
  onCancelMetadata: (versionId: string) => void;
  onDownload: (versionId: string) => void;
}

function VersionRow({
  versionId,
  metadata,
  isLoading,
  hasError,
  isDownloading,
  disableDownload,
  onLoadMetadata,
  onSetPriority,
  onCancelMetadata,
  onDownload,
}: VersionRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (metadata || hasError) return;
    const element = rowRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      onLoadMetadata(versionId, 0);
      return;
    }
    const scrollRoot = element.closest("[data-page-scroll-container]");

    const nearbyObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMetadata(versionId, 1);
        } else {
          onCancelMetadata(versionId);
        }
      },
      { root: scrollRoot, rootMargin: "240px 0px" },
    );
    const visibleObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoadMetadata(versionId, 0);
        onSetPriority(versionId, 0);
      } else {
        onSetPriority(versionId, 1);
      }
    }, { root: scrollRoot });

    nearbyObserver.observe(element);
    visibleObserver.observe(element);
    return () => {
      nearbyObserver.disconnect();
      visibleObserver.disconnect();
      onCancelMetadata(versionId);
    };
  }, [
    hasError,
    metadata,
    onCancelMetadata,
    onLoadMetadata,
    onSetPriority,
    versionId,
  ]);

  return (
    <div ref={rowRef} className="p-4 flex items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="h-5 truncate text-sm font-medium text-gray-900 dark:text-white">
          ID: {versionId}
          {metadata ? ` (v${metadata.displayVersion})` : ""}
        </p>
        <div className="h-5 flex items-center text-xs text-gray-500 dark:text-gray-400">
          {metadata ? (
            new Date(metadata.releaseDate).toLocaleDateString()
          ) : hasError && !isLoading ? (
            <button
              onClick={() => onLoadMetadata(versionId, 0)}
              className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              {t("search.versions.retryDetails")}
            </button>
          ) : null}
        </div>
      </div>
      <button
        onClick={() => onDownload(versionId)}
        disabled={disableDownload}
        className="px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {isDownloading
          ? t("search.versions.downloading")
          : t("search.versions.download")}
      </button>
    </div>
  );
}

export default function VersionHistory() {
  const { appId } = useParams<{ appId: string }>();
  const location = useLocation();
  const { accounts, updateAccount } = useAccounts();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const { startDownload, toastDownloadError } = useDownloadAction();

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
  const [loading, setLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState<Record<string, boolean>>({});
  const [metadataErrors, setMetadataErrors] = useState<Record<string, boolean>>(
    {},
  );
  const versionMetaRef = useRef<Record<string, VersionMetadata>>({});
  const pendingMetaRef = useRef(new Set<string>());
  const cancelledPendingMetaRef = useRef(new Set<string>());
  const retryPendingMetaRef = useRef(new Map<string, 0 | 1>());
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(
    null,
  );

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
    setLoading(true);
    try {
      const result = await listVersions(account, app);
      setVersions(result.versions);
      await updateAccount({ ...account, cookies: result.updatedCookies });
    } catch (e) {
      addToast(getErrorMessage(e, t("search.versions.loadFailed")), "error");
    } finally {
      setLoading(false);
    }
  }

  const handleLoadMeta = useCallback(
    async (versionId: string, priority: 0 | 1 = 0) => {
      if (!account || !app || versionMetaRef.current[versionId]) return;
      if (pendingMetaRef.current.has(versionId)) {
        setQueuedVersionMetadataPriority(account, app, versionId, priority);
        if (cancelledPendingMetaRef.current.has(versionId)) {
          const retryPriority = retryPendingMetaRef.current.get(versionId);
          retryPendingMetaRef.current.set(
            versionId,
            retryPriority === undefined
              ? priority
              : Math.min(retryPriority, priority) as 0 | 1,
          );
        }
        return;
      }

      pendingMetaRef.current.add(versionId);
      cancelledPendingMetaRef.current.delete(versionId);
      setLoadingMeta((prev) => ({ ...prev, [versionId]: true }));
      setMetadataErrors((prev) => ({ ...prev, [versionId]: false }));
      try {
        const result = await resolveVersionMetadata(
          account,
          app,
          versionId,
          priority,
        );
        versionMetaRef.current[versionId] = result.metadata;
        setVersionMeta((prev) => ({ ...prev, [versionId]: result.metadata }));
        await updateAccount({ ...account, cookies: result.updatedCookies });
      } catch (error) {
        if (!(error instanceof VersionMetadataRequestCancelled)) {
          setMetadataErrors((prev) => ({ ...prev, [versionId]: true }));
        }
      } finally {
        const retryPriority = retryPendingMetaRef.current.get(versionId);
        retryPendingMetaRef.current.delete(versionId);
        cancelledPendingMetaRef.current.delete(versionId);
        pendingMetaRef.current.delete(versionId);
        setLoadingMeta((prev) => ({ ...prev, [versionId]: false }));
        if (retryPriority !== undefined) {
          void handleLoadMeta(versionId, retryPriority);
        }
      }
    },
    [account, app, updateAccount],
  );

  const handleSetMetaPriority = useCallback((
    versionId: string,
    priority: 0 | 1,
  ) => {
    if (!account || !app) return;
    setQueuedVersionMetadataPriority(account, app, versionId, priority);
  }, [account, app]);

  const handleCancelMeta = useCallback((versionId: string) => {
    if (!account || !app) return;
    if (pendingMetaRef.current.has(versionId)) {
      cancelledPendingMetaRef.current.add(versionId);
    }
    retryPendingMetaRef.current.delete(versionId);
    cancelQueuedVersionMetadata(account, app, versionId);
  }, [account, app]);

  async function handleDownloadVersion(versionId: string) {
    if (!account || !app) return;
    setDownloadingVersion(versionId);
    try {
      await startDownload(account, app, versionId);
    } catch (e) {
      toastDownloadError(account, app, e);
    } finally {
      setDownloadingVersion(null);
    }
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
              <button
                onClick={handleLoadVersions}
                disabled={loading || !account}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {loading
                  ? t("search.versions.loading")
                  : t("search.versions.load")}
              </button>
            </div>
          )
        )}

        {versions.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-200 dark:divide-gray-800">
            {versions.map((versionId) => (
              <VersionRow
                key={versionId}
                versionId={versionId}
                metadata={versionMeta[versionId]}
                isLoading={Boolean(loadingMeta[versionId])}
                hasError={Boolean(metadataErrors[versionId])}
                isDownloading={downloadingVersion === versionId}
                disableDownload={
                  downloadingVersion === versionId || downloadingVersion !== null
                }
                onLoadMetadata={handleLoadMeta}
                onSetPriority={handleSetMetaPriority}
                onCancelMetadata={handleCancelMeta}
                onDownload={handleDownloadVersion}
              />
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
