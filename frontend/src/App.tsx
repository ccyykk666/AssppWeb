import { Routes, Route } from "react-router-dom";
import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "./store/settings";

import Sidebar from "./components/Layout/Sidebar";
import MobileNav from "./components/Layout/MobileNav";
import MobileHeader from "./components/Layout/MobileHeader";
import ToastContainer from "./components/common/ToastContainer";
import GlobalDownloadNotifier from "./components/common/GlobalDownloadNotifier";
import NavigationProgress from "./components/common/NavigationProgress";
import PasswordGate from "./components/Auth/PasswordGate";
import { preloadLightweightRoutes } from "./utils/preloadRoute";

const HomePage = lazy(() => import("./components/Welcome/HomePage"));
const AccountList = lazy(() => import("./components/Account/AccountList"));
const AddAccountForm = lazy(
  () => import("./components/Account/AddAccountForm"),
);
const AccountDetail = lazy(() => import("./components/Account/AccountDetail"));
const SearchPage = lazy(() => import("./components/Search/SearchPage"));
const ProductDetail = lazy(() => import("./components/Search/ProductDetail"));
const VersionHistory = lazy(() => import("./components/Search/VersionHistory"));
const ReleaseNotesHistory = lazy(
  () => import('./components/Search/ReleaseNotesHistory'),
);
const DownloadList = lazy(() => import("./components/Download/DownloadList"));
const AddDownload = lazy(() => import("./components/Download/AddDownload"));
const PackageDetail = lazy(() => import("./components/Download/PackageDetail"));
const SettingsPage = lazy(() => import("./components/Settings/SettingsPage"));

function Loading() {
  const { t } = useTranslation();
  return (
    <div
      className="flex-1 p-6 sm:p-8"
      role="status"
      aria-label={t("loading")}
      aria-busy="true"
    >
      <div className="mx-auto max-w-5xl space-y-5 animate-pulse motion-reduce:animate-none">
        <div className="h-7 w-32 rounded-md bg-gray-200 dark:bg-gray-800" />
        <div className="h-24 rounded-xl bg-gray-100 dark:bg-gray-900" />
        <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
          <div className="h-4 w-2/3 rounded bg-gray-200 dark:bg-gray-800" />
          <div className="h-4 w-1/2 rounded bg-gray-100 dark:bg-gray-900" />
          <div className="h-4 w-3/4 rounded bg-gray-100 dark:bg-gray-900" />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    function applyTheme() {
      const isDark =
        theme === "dark" || (theme === "system" && mediaQuery.matches);
      if (isDark) {
        root.classList.add("dark");
        root.style.colorScheme = "dark";
      } else {
        root.classList.remove("dark");
        root.style.colorScheme = "light";
      }
    }

    applyTheme();
    mediaQuery.addEventListener("change", applyTheme);
    return () => mediaQuery.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setTimeout(preloadLightweightRoutes, 800);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <PasswordGate>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex text-gray-900 dark:text-gray-100 transition-colors duration-200">
        <ToastContainer />
        <GlobalDownloadNotifier />
        <NavigationProgress />

        <Sidebar />
        <main className="flex-1 flex flex-col min-w-0 safe-top">
          <MobileHeader />
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/accounts" element={<AccountList />} />
              <Route path="/accounts/add" element={<AddAccountForm />} />
              <Route path="/accounts/:email" element={<AccountDetail />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/search/:appId" element={<ProductDetail />} />
              <Route
                path="/search/:appId/versions"
                element={<VersionHistory />}
              />
              <Route
                path="/search/:appId/release-notes"
                element={<ReleaseNotesHistory />}
              />
              <Route path="/downloads" element={<DownloadList />} />
              <Route path="/downloads/add" element={<AddDownload />} />
              <Route path="/downloads/:id" element={<PackageDetail />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </main>
        <MobileNav />
      </div>
    </PasswordGate>
  );
}
