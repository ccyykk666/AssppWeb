import { useEffect, useState } from "react";
import { useNavigationStore } from "../../store/navigation";

export default function NavigationProgress() {
  const pending = useNavigationStore((state) => state.pending);
  const start = useNavigationStore((state) => state.start);
  const [visible, setVisible] = useState(false);
  const [completing, setCompleting] = useState(false);

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

  useEffect(() => {
    if (pending) {
      setVisible(true);
      setCompleting(false);
      return;
    }
    if (!visible) return;

    setCompleting(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      setCompleting(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [pending, visible]);

  if (!visible) return null;

  return (
    <div
      className={`pointer-events-none fixed left-1/2 top-[calc(env(safe-area-inset-top)+1.65rem)] z-[110] -translate-x-1/2 transition-opacity duration-150 md:top-3 ${
        completing ? "opacity-0" : "opacity-100"
      }`}
      role="progressbar"
      aria-label="Loading"
    >
      <div className="h-1 w-[5.5rem] overflow-hidden rounded-full bg-gray-200/80 shadow-sm ring-1 ring-black/5 backdrop-blur-sm dark:bg-gray-700/80 dark:ring-white/10">
        <span className="navigation-wobble block h-full w-[28%] rounded-full bg-gray-800 dark:bg-gray-100" />
      </div>
    </div>
  );
}
