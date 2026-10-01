import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAccounts } from "./useAccounts";
import { useToastStore } from "../store/toast";
import { useDownloadsStore } from "../store/downloads";
import { getDownloadInfo } from "../apple/download";
import {
  purchaseApp,
  PurchaseError,
  type PurchaseResult,
} from "../apple/purchase";
import { authenticate } from "../apple/authenticate";
import { apiPost, apiGet } from "../api/client";
import { accountHash } from "../utils/account";
import { getErrorMessage } from "../utils/error";
import { getAccountContext } from "../utils/toast";
import type { Account, Software } from "../types";

interface DownloadSettings {
  maxDownloadMB: number;
}

interface LicenseDependencies {
  purchase: typeof purchaseApp;
  renew: typeof authenticate;
}

type UpdateAccount = (account: Account) => Promise<void>;

const EXPIRED_PASSWORD_TOKEN_CODES = new Set(["2034", "2042"]);
const defaultLicenseDependencies: LicenseDependencies = {
  purchase: purchaseApp,
  renew: authenticate,
};

let downloadSettingsPromise: Promise<DownloadSettings> | undefined;

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
): Promise<PurchaseResult> {
  let currentAccount = account;
  let result: PurchaseResult;

  try {
    result = await dependencies.purchase(currentAccount, app);
  } catch (error) {
    if (
      !(error instanceof PurchaseError) ||
      !error.code ||
      !EXPIRED_PASSWORD_TOKEN_CODES.has(error.code)
    ) {
      throw error;
    }

    currentAccount = await dependencies.renew(
      account.email,
      account.password,
      undefined,
      account.cookies,
      account.deviceIdentifier,
    );
    // Keep the renewed token even if Apple's follow-up purchase fails.
    await updateAccount(currentAccount);
    result = await dependencies.purchase(currentAccount, app);
  }

  await updateAccount({
    ...currentAccount,
    cookies: result.updatedCookies,
  });
  return result;
}

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  useEffect(() => {
    // This value is static for the lifetime of the server. Warm it while the
    // user is reading the app page instead of after they click Download.
    void loadDownloadSettings().catch(() => undefined);
  }, []);

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await loadDownloadSettings();
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t("toast.downloadLimit.message", {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            "error",
            t("toast.title.downloadLimit"),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    const { output, updatedCookies } = await getDownloadInfo(
      account,
      app,
      versionId,
    );
    await updateAccount({ ...account, cookies: updatedCookies });
    const hash = await accountHash(account);

    await apiPost("/api/downloads", {
      software: { ...app, version: output.bundleShortVersionString },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      bundleVersion: output.bundleVersion,
      pinnedVersion:
        versionId !== undefined &&
        output.bundleShortVersionString !== app.version,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "info",
      t("toast.title.downloadStarted"),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // A valid password token can be reused. Renew only when Apple explicitly
    // reports that it expired, avoiding a full signed login on every click.
    const result = await purchaseWithTokenRefresh(
      account,
      app,
      updateAccount,
    );

    if (result.status === 'alreadyOwned') {
      addToast(
        t('toast.msg', { appName, ...ctx }),
        'info',
        t('toast.title.licenseAlreadyOwned'),
      );
      return;
    }

    addToast(
      t("toast.msg", { appName, ...ctx }),
      "success",
      t("toast.title.licenseSuccess"),
    );
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
    toastDownloadError,
    toastLicenseError,
  };
}
