import { cachedKBSync, storeKBSync } from './cache';
import { generateKBSync } from './generate';
import { throwIfAborted, waitFor } from '../../utils/abort';
import type { Account } from '../../types';

export { hardwareIDFromDeviceIdentifier } from './generate';

interface Job {
  key: string;
  deviceIdentifier: string;
  dsid: number;
  foreground: boolean;
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: unknown) => void;
}
const jobs = new Map<string, Job>();
const queue: Job[] = [];
let active: { job: Job; controller: AbortController; preempted: boolean } | undefined;

function pump(): void {
  if (active || !queue.length) return;
  const index = Math.max(0, queue.findIndex((job) => job.foreground));
  const job = queue.splice(index, 1)[0];
  const run = { job, controller: new AbortController(), preempted: false };
  active = run;
  void generateKBSync(job.deviceIdentifier, job.dsid, undefined, run.controller.signal).then((blob) => {
    storeKBSync(job.dsid, job.deviceIdentifier, blob);
    job.resolve(blob);
    jobs.delete(job.key);
  }, (error) => {
    if (run.preempted) queue.push(job);
    else { job.reject(error); jobs.delete(job.key); }
  }).finally(() => { active = undefined; pump(); });
}

/** Returns the cached kbsync, or generates and caches one, sharing in-flight work. */
export function obtainKBSync(deviceIdentifier: string, dsid: number, signal?: AbortSignal, background = false): Promise<string> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(dsid) || dsid <= 0) return Promise.reject(new Error('Invalid account DSID'));
  const cached = cachedKBSync(dsid, deviceIdentifier);
  if (cached) {
    return Promise.resolve(cached);
  }
  const key = `${dsid}:${deviceIdentifier.toLowerCase()}`;
  let job = jobs.get(key);
  if (!job) {
    let resolve!: Job['resolve'];
    let reject!: Job['reject'];
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    job = { key, deviceIdentifier, dsid, foreground: !background, promise, resolve, reject };
    jobs.set(key, job);
    queue.push(job);
  } else if (!background) job.foreground = true;
  if (!background && active && active.job !== job && !active.job.foreground) {
    active.preempted = true;
    active.controller.abort(new DOMException('Foreground signing requested', 'AbortError'));
  }
  queueMicrotask(pump);
  return waitFor(job.promise, signal);
}

/** Generates missing kbsync blobs one account at a time, ahead of the first download. */
export function prefetchKBSync(accounts: Account[]): void {
  for (const account of accounts) {
    const dsid = Number(account.directoryServicesIdentifier);
    if (
      !Number.isSafeInteger(dsid) ||
      dsid <= 0 ||
      !/^[0-9a-f]{12}$/i.test(account.deviceIdentifier) ||
      cachedKBSync(dsid, account.deviceIdentifier)
    ) {
      continue;
    }
    void obtainKBSync(account.deviceIdentifier, dsid, undefined, true).catch(() => undefined);
  }
}
