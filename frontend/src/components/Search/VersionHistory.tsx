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
  resolveAccurateVersionMetadata,
  resolveVersionMetadata,
  setQueuedVersionMetadataPriority,
  VersionMetadataRequestCancelled,
} from "../../apple/versionMetadataResolver";
import { getErrorMessage } from "../../utils/error";
import { storeIdToCountry } from "../../apple/config";
import type { Software, VersionMetadata } from "../../types";

const SCROLL_SETTLE_MS = 180;
const PREFETCH_MARGIN_PX = 240;
const MOBILE_NAV_INSET_PX = 64;

interface VersionRowProps {
  versionId: string;
  metadata?: VersionMetadata;
  isLoading: boolean;
  hasError: boolean;
  isDownloading: boolean;
  disableDownload: boolean;
  onLoadMetadata: (versionId: string, priority?: number) => void;
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
  onDownload,
}: VersionRowProps) {
  const { t } = useTranslation();

  return (
    <div
      data-version-id={versionId}
      className="p-4 flex items-center justify-between gap-4"
    >
      <div className="min-w-0 flex-1">
        <p className="h-5 truncate text-sm font-medium text-gray-900 dark:text-white">
          ID: {versionId}
          {metadata ? ` (v${metadata.displayVersion})` : ""}
        </p>
        <div className="h-5 flex items-center text-xs text-gray-500 dark:text-gray-400">
          {metadata?.releaseDate ? (
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
  const retryPendingMetaRef = useRef(new Map<string, number>());
  const metadataErrorsRef = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
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
    async (versionId: string, priority = 0) => {
      if (!account || !app || versionMetaRef.current[versionId]) return;
      if (pendingMetaRef.current.has(versionId)) {
        setQueuedVersionMetadataPriority(account, app, versionId, priority);
        if (cancelledPendingMetaRef.current.has(versionId)) {
          const retryPriority = retryPendingMetaRef.current.get(versionId);
          retryPendingMetaRef.current.set(
            versionId,
            retryPriority === undefined
              ? priority
              : Math.min(retryPriority, priority),
          );
        }
        return;
      }

      pendingMetaRef.current.add(versionId);
      cancelledPendingMetaRef.current.delete(versionId);
      metadataErrorsRef.current.delete(versionId);
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
        if (result.downloadURL) {
          void resolveAccurateVersionMetadata(
            app,
            versionId,
            result.downloadURL,
            priority,
          )
            .then((metadata) => {
              versionMetaRef.current[versionId] = metadata;
              setVersionMeta((prev) => ({ ...prev, [versionId]: metadata }));
            })
            .catch(() => undefined);
        }
        await updateAccount({ ...account, cookies: result.updatedCookies });
      } catch (error) {
        if (!(error instanceof VersionMetadataRequestCancelled)) {
          metadataErrorsRef.current.add(versionId);
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

  const handleCancelMeta = useCallback((versionId: string) => {
    if (!account || !app) return;
    if (pendingMetaRef.current.has(versionId)) {
      cancelledPendingMetaRef.current.add(versionId);
    }
    retryPendingMetaRef.current.delete(versionId);
    cancelQueuedVersionMetadata(account, app, versionId);
  }, [account, app]);

  const handleLoadMetaRef = useRef(handleLoadMeta);
  const handleCancelMetaRef = useRef(handleCancelMeta);
  useEffect(() => {
    handleLoadMetaRef.current = handleLoadMeta;
    handleCancelMetaRef.current = handleCancelMeta;
  }, [handleCancelMeta, handleLoadMeta]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !account || !app || versions.length === 0) return;
    const scrollContainer = list.closest<HTMLElement>(".overflow-y-auto");

    let settleTimer: ReturnType<typeof setTimeout> | undefined;

    const loadVisibleRows = () => {
      const visualViewport = window.visualViewport;
      const visualTop = visualViewport?.offsetTop ?? 0;
      const visualBottom =
        visualTop + (visualViewport?.height ?? window.innerHeight);
      const containerRect = scrollContainer?.getBoundingClientRect();
      const viewportTop = Math.max(containerRect?.top ?? 0, visualTop);
      const bottomInset = window.matchMedia("(max-width: 767px)").matches
        ? MOBILE_NAV_INSET_PX
        : 0;
      const viewportBottom =
        Math.min(containerRect?.bottom ?? visualBottom, visualBottom) -
        bottomInset;
      const rows = Array.from(
        list.querySelectorAll<HTMLElement>("[data-version-id]"),
      ).map((element) => ({
        rect: element.getBoundingClientRect(),
        versionId: element.dataset.versionId ?? "",
      }));

      const visibleRows = rows
        .filter(
          ({ rect, versionId }) =>
            versionId && rect.bottom > viewportTop && rect.top < viewportBottom,
        )
        .sort((a, b) => a.rect.top - b.rect.top);
      const visibleIds = new Set(visibleRows.map(({ versionId }) => versionId));
      const nearbyRows = rows
        .filter(
          ({ rect, versionId }) =>
            versionId &&
            !visibleIds.has(versionId) &&
            rect.bottom > viewportTop - PREFETCH_MARGIN_PX &&
            rect.top < viewportBottom + PREFETCH_MARGIN_PX,
        )
        .sort((a, b) => {
          const distanceA =
            a.rect.top >= viewportBottom
              ? a.rect.top - viewportBottom
              : viewportTop - a.rect.bottom;
          const distanceB =
            b.rect.top >= viewportBottom
              ? b.rect.top - viewportBottom
              : viewportTop - b.rect.bottom;
          return distanceA - distanceB;
        });
      const wantedIds = new Set([
        ...visibleRows.map(({ versionId }) => versionId),
        ...nearbyRows.map(({ versionId }) => versionId),
      ]);

      for (const versionId of pendingMetaRef.current) {
        if (!wantedIds.has(versionId)) {
          handleCancelMetaRef.current(versionId);
        }
      }
      visibleRows.forEach(({ versionId }, index) => {
        if (
          !versionMetaRef.current[versionId] &&
          !metadataErrorsRef.current.has(versionId)
        ) {
          void handleLoadMetaRef.current(versionId, index);
        }
      });
      nearbyRows.forEach(({ versionId }, index) => {
        if (
          !versionMetaRef.current[versionId] &&
          !metadataErrorsRef.current.has(versionId)
        ) {
          void handleLoadMetaRef.current(
            versionId,
            visibleRows.length + 100 + index,
          );
        }
      });
    };

    const scheduleVisibleRows = () => {
      for (const versionId of pendingMetaRef.current) {
        handleCancelMetaRef.current(versionId);
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(loadVisibleRows, SCROLL_SETTLE_MS);
    };

    scheduleVisibleRows();
    (scrollContainer ?? window).addEventListener("scroll", scheduleVisibleRows, {
      passive: true,
    });
    window.addEventListener("resize", scheduleVisibleRows, { passive: true });
    window.visualViewport?.addEventListener("scroll", scheduleVisibleRows, {
      passive: true,
    });
    window.visualViewport?.addEventListener("resize", scheduleVisibleRows, {
      passive: true,
    });

    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      (scrollContainer ?? window).removeEventListener(
        "scroll",
        scheduleVisibleRows,
      );
      window.removeEventListener("resize", scheduleVisibleRows);
      window.visualViewport?.removeEventListener("scroll", scheduleVisibleRows);
      window.visualViewport?.removeEventListener("resize", scheduleVisibleRows);
      for (const versionId of pendingMetaRef.current) {
        handleCancelMetaRef.current(versionId);
      }
    };
  }, [account?.email, app, versions]);

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
          <div
            ref={listRef}
            className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 divide-y divide-gray-200 dark:divide-gray-800"
          >
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
                onDownload={handleDownloadVersion}
              />
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
