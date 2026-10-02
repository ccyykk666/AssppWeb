const routeLoaders: Record<string, () => Promise<unknown>> = {
  "/": () => import("../components/Welcome/HomePage"),
  "/accounts": () => import("../components/Account/AccountList"),
  "/search": () => import("../components/Search/SearchPage"),
  "/downloads": () => import("../components/Download/DownloadList"),
  "/settings": () => import("../components/Settings/SettingsPage"),
};

const requestedRoutes = new Set<string>();

export function preloadRoute(path: string) {
  if (requestedRoutes.has(path)) return;
  const loader = routeLoaders[path];
  if (!loader) return;

  requestedRoutes.add(path);
  void loader().catch(() => requestedRoutes.delete(path));
}

export function preloadLightweightRoutes() {
  preloadRoute("/");
  preloadRoute("/accounts");
  preloadRoute("/search");
  preloadRoute("/settings");
}
