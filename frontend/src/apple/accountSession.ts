import { sameSession, useAccountsStore } from '../store/accounts';
import { authenticate } from './authenticate';
import { purchaseApp } from './purchase';
import { throwIfAborted, waitFor } from '../utils/abort';
import type { Account, Software } from '../types';

const renewals = new Map<string, Promise<Account>>();
const accountLanes = new Map<string, Promise<unknown>>();

// Serialize only the Apple exchange, not signature generation or CDN/plist work.
export function accountExchange<T>(account: Account, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const key = `${account.email}:${account.deviceIdentifier}`;
  const previous = accountLanes.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(() => { throwIfAborted(signal); return task(); });
  accountLanes.set(key, result);
  result.finally(() => { if (accountLanes.get(key) === result) accountLanes.delete(key); }).catch(() => undefined);
  return waitFor(result, signal);
}

export function currentAccount(snapshot: Account): Account {
  const current = useAccountsStore.getState().accounts.find((a) => a.email === snapshot.email);
  return current && current.deviceIdentifier === snapshot.deviceIdentifier ? current : snapshot;
}

export function renewAccount(
  expired: Account,
  save: (account: Account, expected?: Account) => Promise<void>,
  renew = authenticate,
  signal?: AbortSignal,
): Promise<Account> {
  const current = currentAccount(expired);
  if (!sameSession(current, expired)) return Promise.resolve(current);
  const key = `${expired.email}:${expired.deviceIdentifier}`;
  let pending = renewals.get(key);
  if (!pending) {
    pending = renew(expired.email, expired.password, undefined, expired.cookies, expired.deviceIdentifier)
      .then(async (account) => { await save(account, expired); return currentAccount(account); });
    renewals.set(key, pending);
    pending.finally(() => { if (renewals.get(key) === pending) renewals.delete(key); }).catch(() => undefined);
  }
  return waitFor(pending, signal);
}

/** Same bounded recovery policy for downloads and metadata; never renew on bare HTTP 403. */
export async function recoverAccountOperation<T extends { updatedCookies: Account['cookies'] }>(
  snapshot: Account,
  app: Software,
  task: (account: Account) => Promise<T>,
  signal?: AbortSignal,
): Promise<T & { updatedAccount: Account }> {
  const save = useAccountsStore.getState().updateAccount;
  let account = currentAccount(snapshot);
  let renewed = false;
  let acquired = false;
  for (;;) {
    throwIfAborted(signal);
    try {
      const result = await task(account);
      const next = { ...account, cookies: result.updatedCookies };
      await save(next, account);
      return { ...result, updatedAccount: currentAccount(next) };
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (!renewed && (code === '2034' || code === '2042')) {
        renewed = true;
        account = await renewAccount(account, save, authenticate, signal);
        continue;
      }
      if (!acquired && code === '9610' && (app.price ?? 0) === 0) {
        acquired = true;
        let license;
        try {
          license = await accountExchange(account, () => purchaseApp(account, app, signal), signal);
        } catch (purchaseError) {
          const purchaseCode = (purchaseError as { code?: string })?.code;
          if (renewed || !['2034', '2042'].includes(purchaseCode ?? '')) throw purchaseError;
          renewed = true;
          account = await renewAccount(account, save, authenticate, signal);
          license = await accountExchange(account, () => purchaseApp(account, app, signal), signal);
        }
        const next = { ...account, cookies: license.updatedCookies };
        await save(next, account);
        account = currentAccount(next);
        continue;
      }
      throw error;
    }
  }
}
