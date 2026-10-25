import { useCallback, useLayoutEffect, useRef } from 'react';

// Capture the committed UI context, including an unmount or a switch away/back.
// Network work may finish, but it must not write results into a different view.
export function useRequestContext(contextKey: string) {
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  useLayoutEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      for (const controller of controllers.current) controller.abort(new DOMException('Cancelled', 'AbortError'));
      controllers.current.clear();
    };
  }, [contextKey]);

  return useCallback(() => {
    const current = generation.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    return Object.assign(() => current === generation.current, {
      signal: controller.signal,
      dispose: () => controllers.current.delete(controller),
    });
  }, []);
}
