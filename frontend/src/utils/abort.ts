// Use explicit controllers so older Safari versions do not need AbortSignal.any/timeout.
export function requestScope(parent?: AbortSignal, timeoutMs = 30_000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => controller.abort(new DOMException('Cancelled', 'AbortError')),
    dispose() { clearTimeout(timer); parent?.removeEventListener('abort', cancel); },
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelled', 'AbortError');
}

// Cancels a caller's wait without cancelling shared work needed by other callers.
export function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export interface SharedWork<T> { promise: Promise<T>; controller: AbortController; users: number; settled: boolean }
export function sharedWork<T>(task: (signal: AbortSignal) => Promise<T>): SharedWork<T> {
  const controller = new AbortController();
  const work: SharedWork<T> = { controller, users: 0, settled: false, promise: Promise.resolve().then(() => task(controller.signal)) };
  work.promise = work.promise.finally(() => { work.settled = true; });
  return work;
}
export function joinWork<T>(work: SharedWork<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  work.users++;
  return waitFor(work.promise, signal).finally(() => {
    work.users--;
    if (!work.users && !work.settled) work.controller.abort(new DOMException('No active readers', 'AbortError'));
  });
}
