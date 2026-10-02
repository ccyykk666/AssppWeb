import { useEffect } from "react";
import Spinner from "./Spinner";
import { useNavigationStore } from "../../store/navigation";

export default function NavigationSpinner() {
  const pending = useNavigationStore((state) => state.pending);
  const start = useNavigationStore((state) => state.start);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname + destination.search + destination.hash ===
          window.location.pathname + window.location.search + window.location.hash
      ) {
        return;
      }

      start();
    }

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [start]);

  if (!pending) return null;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-white/20 dark:bg-gray-950/20 backdrop-blur-[1px]"
      role="status"
      aria-label="Loading"
    >
      <div className="rounded-full bg-white/95 dark:bg-gray-900/95 p-3 text-blue-600 dark:text-blue-400 shadow-lg border border-gray-200/70 dark:border-gray-700/70">
        <Spinner />
      </div>
    </div>
  );
}
