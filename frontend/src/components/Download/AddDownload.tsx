import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import PageContainer from "../Layout/PageContainer";
import AppIcon from "../common/AppIcon";
import CountrySelect from "../common/CountrySelect";
import Spinner from "../common/Spinner";
import ActionButton from '../common/ActionButton';
import { useAccounts } from "../../hooks/useAccounts";
import { useDownloadAction } from "../../hooks/useDownloadAction";
import { useRequestContext } from '../../hooks/useRequestContext';
import { useSettingsStore } from "../../store/settings";
import { useToastStore } from "../../store/toast";
import { lookupApp, lookupLatestAppVersion } from "../../api/search";
import { firstAccountCountry } from "../../utils/account";
import { getErrorMessage } from "../../utils/error";
import { countryCodeMap, storeIdToCountry } from "../../apple/config";
import type { Software } from "../../types";

export default function AddDownload() {
  const { accounts, updateAccount } = useAccounts();
  const { defaultCountry } = useSettingsStore();
  const { t } = useTranslation();
  const addToast = useToastStore((s) => s.addToast);
  const {
    startDownload,
    acquireLicense,
    loadVersions,
  } = useDownloadAction({ localFeedback: true });

  const [bundleId, setBundleId] = useState("");
  const [country, setCountry] = useState(defaultCountry);
  const [countryTouched, setCountryTouched] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [app, setApp] = useState<Software | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [step, setStep] = useState<"lookup" | "ready" | "versions">("lookup");
  const [lookingUp, setLookingUp] = useState(false);
  const lookupRunning = useRef(false);
  const captureLookup = useRequestContext(`${bundleId.trim()}:${country}`);
  const actionContext = `${app?.id}:${country}:${selectedAccount}`;
  const captureContext = useRequestContext(actionContext);

  useEffect(() => {
    setVersions([]);
    setSelectedVersion('');
    setStep(app ? 'ready' : 'lookup');
  }, [actionContext]);

  const availableCountryCodes = Array.from(
    new Set(
      accounts
        .map((a) => storeIdToCountry(a.store))
        .filter(Boolean) as string[],
    ),
  ).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const allCountryCodes = Object.keys(countryCodeMap).sort((a, b) =>
    t(`countries.${a}`, a).localeCompare(t(`countries.${b}`, b)),
  );

  const filteredAccounts = useMemo(() => {
    return accounts.filter((a) => storeIdToCountry(a.store) === country);
  }, [accounts, country]);

  useEffect(() => {
    if (filteredAccounts.length > 0) {
      if (
        !selectedAccount ||
        !filteredAccounts.find((a) => a.email === selectedAccount)
      ) {
        setSelectedAccount(filteredAccounts[0].email);
      }
    } else if (selectedAccount !== "") {
      setSelectedAccount("");
    }
  }, [filteredAccounts, selectedAccount]);

  const account = accounts.find((a) => a.email === selectedAccount);
  const autoCountry = firstAccountCountry(accounts);

  useEffect(() => {
    if (countryTouched) return;
    const nextCountry = autoCountry ?? defaultCountry;
    if (nextCountry && nextCountry !== country) {
      setCountry(nextCountry);
    }
  }, [autoCountry, country, countryTouched, defaultCountry]);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!bundleId.trim() || lookupRunning.current) return;
    lookupRunning.current = true;
    const isCurrent = captureLookup();
    setLookingUp(true);
    try {
      const result = await lookupApp(bundleId.trim(), country);
      if (!isCurrent()) return;
      if (!result) {
        addToast(t("downloads.add.notFound"), "error");
        return;
      }
      setApp(result);
      setStep("ready");
      void lookupLatestAppVersion(result.id, country).catch(() => undefined);
    } catch (e) {
      if (isCurrent()) addToast(getErrorMessage(e, t("downloads.add.lookupFailed")), "error");
    } finally {
      lookupRunning.current = false;
      setLookingUp(false);
    }
  }

  async function handleGetLicense() {
    if (!account || !app) return;
    const result = await acquireLicense(account, app);
    return result.status === 'alreadyOwned' ? t('common.licenseOwned') : t('common.licenseAcquired');
  }

  async function handleLoadVersions() {
    if (!account || !app) return;
    const isCurrent = captureContext();
    const result = await loadVersions(account, app);
    await updateAccount({ ...account, cookies: result.updatedCookies });
    if (!isCurrent()) return;
    setVersions(result.versions);
    setStep('versions');
  }

  async function handleDownload() {
    if (!account || !app) return;
    await startDownload(account, app, selectedVersion || undefined);
  }

  return (
    <PageContainer title={t("downloads.add.title")}>
      <div className="space-y-6">
        <form onSubmit={handleLookup} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t("downloads.add.bundleId")}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={bundleId}
                onChange={(e) => setBundleId(e.target.value)}
                placeholder={t("downloads.add.placeholder")}
                className="block w-full flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 dark:disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
              />
              <button
                type="submit"
                disabled={lookingUp || !bundleId.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
              >
                {lookingUp && <Spinner />}
                {lookingUp
                  ? t("downloads.add.lookingUp")
                  : t("downloads.add.lookup")}
              </button>
            </div>
          </div>
          <div className="flex w-full gap-3 overflow-hidden">
            <CountrySelect
              value={country}
              onChange={(v) => {
                setCountry(v);
                setCountryTouched(true);
                setApp(null);
              }}
              availableCountryCodes={availableCountryCodes}
              allCountryCodes={allCountryCodes}
              className="w-1/2 truncate disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 dark:disabled:text-gray-400 disabled:cursor-not-allowed"
            />
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              className="w-1/2 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 truncate disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 dark:disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
              disabled={filteredAccounts.length === 0}
            >
              {filteredAccounts.length > 0 ? (
                filteredAccounts.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.firstName} {a.lastName} ({a.email})
                  </option>
                ))
              ) : (
                <option value="">
                  {t("downloads.add.noAccountsForRegion")}
                </option>
              )}
            </select>
          </div>
        </form>

        {!app && !lookingUp && (
          <div className="flex flex-col items-center justify-center py-12 px-4 bg-gray-50 dark:bg-gray-900/30 border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-2xl">
            <div className="bg-white dark:bg-gray-800 p-4 rounded-full shadow-sm mb-4 border border-gray-100 dark:border-gray-700">
              <svg
                className="w-10 h-10 text-blue-500 dark:text-blue-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2 text-center">
              {t("downloads.add.emptyTitle")}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm">
              {t("downloads.add.emptyDesc")}
            </p>
          </div>
        )}

        {app && (
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <div className="flex items-center gap-4 mb-4">
              <AppIcon url={app.artworkUrl} name={app.name} size="md" />
              <div>
                <p className="font-medium text-gray-900 dark:text-white">
                  {app.name}
                </p>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {app.artistName}
                </p>
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  v{app.version} -{" "}
                  {app.formattedPrice ?? t("search.product.free")}
                </p>
              </div>
            </div>

            {step === "versions" && versions.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t("downloads.add.versionOptional")}
                </label>
                <select
                  value={selectedVersion}
                  onChange={(e) => setSelectedVersion(e.target.value)}
                  className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-base text-gray-900 dark:text-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 truncate disabled:bg-gray-50 dark:disabled:bg-gray-800/50 disabled:text-gray-500 dark:disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  <option value="">{t("downloads.add.latest")}</option>
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-wrap items-start gap-2">
              {(app.price === undefined || app.price === 0) && (
                <ActionButton
                  action={handleGetLicense}
                  label={t('downloads.add.getLicense')}
                  pendingLabel={t('downloads.add.processing')}
                  successLabel={t('common.licenseAcquired')}
                  errorLabel={t('toast.title.licenseFailed')}
                  contextKey={actionContext}
                  disabled={!account}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                />
              )}
              {step !== "versions" && (
                <ActionButton
                  action={handleLoadVersions}
                  label={t('downloads.add.selectVersion')}
                  pendingLabel={t('downloads.add.processing')}
                  successLabel={t('common.versionsLoaded')}
                  errorLabel={t('downloads.add.versionsFailed')}
                  contextKey={actionContext}
                  disabled={!account}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-gray-700 dark:text-gray-300 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                />
              )}
              <ActionButton
                action={handleDownload}
                label={t('downloads.add.download')}
                pendingLabel={t('downloads.add.processing')}
                successLabel={t('common.downloadQueued')}
                errorLabel={t('toast.title.downloadFailed')}
                contextKey={`${actionContext}:${selectedVersion}`}
                disabled={!account}
                className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              />
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
