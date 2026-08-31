import { ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { useSearch } from "../../hooks/useSearch";

const MAX_SAVED_POSITIONS = 100;
interface SavedScrollPosition {
  container: number;
  viewport: number;
}

const scrollPositions = new Map<string, SavedScrollPosition>();

function saveScrollPosition(key: string, position: SavedScrollPosition) {
  scrollPositions.delete(key);
  scrollPositions.set(key, position);
  if (scrollPositions.size > MAX_SAVED_POSITIONS) {
    const oldestKey = scrollPositions.keys().next().value;
    if (oldestKey !== undefined) scrollPositions.delete(oldestKey);
  }
}

interface PageContainerProps {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}

export default function PageContainer({
  title,
  children,
  action,
}: PageContainerProps) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const clearSearch = useSearch((state) => state.clear);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const savedPosition =
      navigationType === "POP"
        ? scrollPositions.get(location.key)
        : undefined;
    const targetContainerPosition = savedPosition?.container ?? 0;
    const targetViewportPosition = savedPosition?.viewport ?? 0;
    const scrollingElement =
      document.scrollingElement ?? document.documentElement;
    let animationFrame = 0;
    let attempts = 0;

    const restorePosition = () => {
      container.scrollTop = targetContainerPosition;
      scrollingElement.scrollTop = targetViewportPosition;
      attempts++;

      // Lists can finish loading after the route has rendered. Retry until the
      // container is tall enough to accept the saved position, with a bounded
      // loop so normal user scrolling is never continuously overridden.
      const restoredContainer =
        Math.abs(container.scrollTop - targetContainerPosition) < 1;
      const restoredViewport =
        Math.abs(scrollingElement.scrollTop - targetViewportPosition) < 1;
      const restored = restoredContainer && restoredViewport;
      if (!restored && attempts < 120) {
        animationFrame = requestAnimationFrame(restorePosition);
      }
    };

    restorePosition();

    return () => {
      cancelAnimationFrame(animationFrame);
      saveScrollPosition(location.key, {
        container: container.scrollTop,
        viewport: scrollingElement.scrollTop,
      });
    };
  }, [location.key, navigationType]);

  // 监听路由变化，如果当前路径不在 /search 下，则清空之前的搜索内容
  useEffect(() => {
    if (!location.pathname.startsWith("/search")) {
      clearSearch();
    }
  }, [location.pathname, clearSearch]);

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto pb-20 md:pb-0 bg-gray-50 dark:bg-gray-950 transition-colors duration-200"
    >
      <div className="max-w-5xl mx-auto px-4 py-6 sm:px-6">
        {(title || action) && (
          <div className="flex items-center justify-between mb-6">
            {title && (
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {title}
              </h1>
            )}
            {action && <div>{action}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
