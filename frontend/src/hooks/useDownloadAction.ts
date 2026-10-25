import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { getDownloadInfo } from "../apple/download";
import { listVersions, VersionHistoryError } from "../apple/versionFinder";
import {
  purchaseApp,
  PurchaseError,
  type PurchaseResult,
} from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { accountExchange, currentAccount as latestAccount, recoverAccountOperation, renewAccount } from '../apple/accountSession';
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import { joinWork, sharedWork, throwIfAborted, waitFor, type SharedWork } from '../utils/abort';
import type { Account, Software } from "../types";

interface DownloadSettings {
  maxDownloadMB: number;
}

interface LicenseDependencies {
  purchase: typeof purchaseApp;
  renew: typeof authenticate;
}

type UpdateAccount = (account: Account, expected?: Account) => Promise<void>;
type AcquireLicense = (
  account: Account,
  app: Software,
) => Promise<PurchaseResult>;
type ListVersions = typeof listVersions;

interface VersionSessionDependencies {
  renew: typeof authenticate;
  updateAccount: UpdateAccount;
}

const EXPIRED_PASSWORD_TOKEN_CODES = new Set(["2034", "2042"]);
const defaultLicenseDependencies: LicenseDependencies = {
  purchase: purchaseApp,
  renew: authenticate,
};

let downloadSettingsPromise: Promise<DownloadSettings> | undefined;
const licenseRequests = new Map<string, SharedWork<PurchaseResult> & { token: string }>();

function loadDownloadSettings(): Promise<DownloadSettings> {
  if (!downloadSettingsPromise) {
    downloadSettingsPromise = apiGet<DownloadSettings>("/api/settings").catch(
      (error) => {
        downloadSettingsPromise = undefined;
        throw error;
      },
    );
  }
  return downloadSettingsPromise;
}

export async function purchaseWithTokenRefresh(
  account: Account,
  app: Software,
  updateAccount: UpdateAccount,
  dependencies: LicenseDependencies = defaultLicenseDependencies,
  signal?: AbortSignal,
): Promise<PurchaseResult> {
  let currentAccount = latestAccount(account);
  let result: PurchaseResult;

  try {
    result = await (signal ? dependencies.purchase(currentAccount, app, signal) : dependencies.purchase(currentAccount, app));
  } catch (error) {
    if (
      !(error instanceof PurchaseError) ||
      !error.code ||
      !EXPIRED_PASSWORD_TOKEN_CODES.has(error.code)
    ) {
      throw error;
    }

    currentAccount = await renewAccount(currentAccount, updateAccount, dependencies.renew, signal);
    result = await (signal ? dependencies.purchase(currentAccount, app, signal) : dependencies.purchase(currentAccount, app));
  }

  const updatedAccount = {
    ...currentAccount,
    cookies: result.updatedCookies,
  };
  await updateAccount(updatedAccount, currentAccount);
  return { ...result, updatedAccount: latestAccount(updatedAccount) };
}

export async function listVersionsWithLicense(
  account: Account,
  app: Software,
  acquireLicense: AcquireLicense,
  list: ListVersions = listVersions,
  session?: VersionSessionDependencies,
  options?: { signal?: AbortSignal; forceRefresh?: boolean },
) {
  let currentAccount = latestAccount(account);
  let refreshed = false;
  let acquired = false;
  while (true) {
    try {
      throwIfAborted(options?.signal);
      const result = await (options ? list(currentAccount, app, options) : list(currentAccount, app));
      const updatedAccount = { ...currentAccount, cookies: result.updatedCookies };
      if (session) await session.updateAccount(updatedAccount, currentAccount);
      return { ...result, updatedAccount: latestAccount(updatedAccount) };
    } catch (error) {
      if (!(error instanceof VersionHistoryError)) throw error;
      if (session && !refreshed && error.code &&
          EXPIRED_PASSWORD_TOKEN_CODES.has(error.code)) {
        refreshed = true;
        currentAccount = await renewAccount(currentAccount, session.updateAccount, session.renew, options?.signal);
        continue;
      }
      if (!acquired && error.code === '9610' && (app.price ?? 0) === 0) {
        acquired = true;
        const license = await acquireLicense(currentAccount, app);
        currentAccount = { ...(license.updatedAccount ?? currentAccount), cookies: license.updatedCookies };
        continue;
      }
      throw error;
    }
  }
}

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction({ localFeedback = false } = {}) {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  useEffect(() => {
    // This value is static for the lifetime of the server. Warm it while the
    // user is reading the app page instead of after they click Download.
    void loadDownloadSettings().catch(() => undefined);
    // Load the Apple networking WASM while the action UI is idle so the first
    // license or download click does not pay its cold-start cost.
    void import("../apple/libcurl-init")
      .then(({ initLibcurl }) => initLibcurl())
      .catch(() => undefined);
  }, []);

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
    signal?: AbortSignal,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // Ignore a settings fetch failure, not an explicit size-limit rejection.
    const settings = await waitFor(loadDownloadSettings(), signal).catch((error) => {
      throwIfAborted(signal);
      return undefined;
    });
    if (settings) {
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          const message = t("toast.downloadLimit.message", {
            appName,
            size: sizeMB.toFixed(2),
            limit: settings.maxDownloadMB,
          });
          if (localFeedback) throw new Error(message);
          addToast(
            message,
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    }

    const { output } = await recoverAccountOperation(
      account, app,
      (current) => getDownloadInfo(current, app, versionId, signal),
      signal,
    );
    throwIfAborted(signal);
    const hash = await accountHash(account);

    await apiPost("/api/downloads", {
      software: { ...app, version: output.bundleShortVersionString },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      bundleVersion: output.bundleVersion,
      externalVersionId: output.externalVersionId,
      pinnedVersion:
        versionId !== undefined &&
        output.bundleShortVersionString !== app.version,
      iTunesMetadata: output.iTunesMetadata,
    }, signal);

    fetchTasks();

    if (!localFeedback) {
      addToast(
        t("toast.msg", { appName, ...ctx }),
        "info",
        t("toast.title.downloadStarted"),
      );
    }
  }

  async function acquireLicense(account: Account, app: Software, signal?: AbortSignal) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // A valid password token can be reused. Renew only when Apple explicitly
    // reports that it expired, avoiding a full signed login on every click.
    const key = `${account.email}:${account.deviceIdentifier}:${account.store}:${app.id}`;
    let entry = licenseRequests.get(key);
    const current = latestAccount(account);
    if (!entry || entry.token !== current.passwordToken || entry.controller.signal.aborted) {
      entry = { token: current.passwordToken, ...sharedWork((requestSignal) =>
        accountExchange(current, () => purchaseWithTokenRefresh(current, app, updateAccount, defaultLicenseDependencies, requestSignal), requestSignal)) };
      const promise = entry.promise;
      licenseRequests.set(key, entry);
      promise.finally(() => { if (licenseRequests.get(key)?.promise === promise) licenseRequests.delete(key); }).catch(() => undefined);
    }
    const result = await joinWork(entry, signal);

    if (result.status === 'alreadyOwned') {
      if (!localFeedback) {
        addToast(
          t('toast.msg', { appName, ...ctx }),
          'info',
          t('toast.title.licenseAlreadyOwned'),
        );
      }
      return result;
    }

    if (!localFeedback) {
      addToast(
        t("toast.msg", { appName, ...ctx }),
        "success",
        t("toast.title.licenseSuccess"),
      );
    }
    return result;
  }

  async function loadVersions(account: Account, app: Software, options?: { signal?: AbortSignal; forceRefresh?: boolean }) {
    return listVersionsWithLicense(account, app, acquireLicense, listVersions, {
      renew: authenticate, updateAccount,
    }, options);
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.downloadFailed")),
      }),
      "error",
      t("toast.title.downloadFailed"),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t("toast.msgFailed", {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t("toast.title.licenseFailed")),
      }),
      "error",
      t("toast.title.licenseFailed"),
    );
  }

  return {
    startDownload,
    acquireLicense,
    loadVersions,
    toastDownloadError,
    toastLicenseError,
  };
}
