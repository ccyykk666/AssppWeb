import { useCallback, useLayoutEffect, useRef } from 'react';

// Capture the committed UI context, including an unmount or a switch away/back.
// Network work may finish, but it must not write results into a different view.
export function useRequestContext(contextKey: string) {
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current++;
    return () => { generation.current++; };
  }, [contextKey]);

  return useCallback(() => {
    const current = generation.current;
    return () => current === generation.current;
  }, []);
}
