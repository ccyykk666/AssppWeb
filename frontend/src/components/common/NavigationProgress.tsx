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
    }, 260);
    return () => window.clearTimeout(timer);
  }, [pending, visible]);

  if (!visible) return null;

  return (
    <>
      <style>
        {`
          @keyframes navigation-progress {
            0% { transform: scaleX(0.04); }
            18% { transform: scaleX(0.32); }
            48% { transform: scaleX(0.62); }
            78% { transform: scaleX(0.82); }
            100% { transform: scaleX(0.92); }
          }
          @keyframes navigation-progress-shimmer {
            from { transform: translateX(-100%); }
            to { transform: translateX(350%); }
          }
          .navigation-progress-running {
            animation: navigation-progress 8s cubic-bezier(0.1, 0.55, 0.2, 1) forwards;
          }
          .navigation-progress-shimmer {
            animation: navigation-progress-shimmer 1.1s ease-in-out infinite;
          }
          @media (prefers-reduced-motion: reduce) {
            .navigation-progress-running { animation: none; transform: scaleX(0.72); }
            .navigation-progress-shimmer { animation: none; }
          }
        `}
      </style>
      <div
        className={`pointer-events-none fixed inset-x-0 top-0 z-[110] h-[3px] overflow-hidden transition-opacity duration-150 ${
          completing ? "opacity-0 delay-100" : "opacity-100"
        }`}
        role="progressbar"
        aria-label="Loading"
      >
        <div
          className={`relative h-full origin-left bg-gradient-to-r from-gray-500 via-gray-300 to-white shadow-[0_0_8px_rgba(107,114,128,0.5)] ${
            completing
              ? "scale-x-100 transition-transform duration-200 ease-out"
              : "navigation-progress-running"
          }`}
        >
          <span className="navigation-progress-shimmer absolute inset-y-0 right-0 w-1/3 bg-gradient-to-r from-transparent via-white/90 to-transparent" />
        </div>
      </div>
    </>
  );
}
