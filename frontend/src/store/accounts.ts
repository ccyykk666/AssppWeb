import { create } from "zustand";
import { openDB, type IDBPDatabase } from "idb";
import type { Account, Cookie } from "../types";

const DB_NAME = "asspp-accounts";
const STORE_NAME = "accounts";

let dbPromise: Promise<IDBPDatabase> | null = null;
let writes: Promise<unknown> = Promise.resolve();
let revision = 0;

function persist(operation: (db: IDBPDatabase) => Promise<unknown>): Promise<void> {
  const write = writes.then(async () => operation(await getDB()));
  writes = write.catch(() => undefined);
  return write.then(() => undefined);
}

export function sameSession(a: Account, b: Account): boolean {
  return a.email === b.email && a.deviceIdentifier === b.deviceIdentifier &&
    a.directoryServicesIdentifier === b.directoryServicesIdentifier &&
    a.passwordToken === b.passwordToken && a.store === b.store;
}

function mergeSessionCookies(current: Cookie[], before: Cookie[], after: Cookie[]): Cookie[] {
  const key = (c: Cookie) => `${c.domain ?? ''}\u0000${c.path}\u0000${c.name}`;
  const baseline = new Map(before.map((cookie) => [key(cookie), cookie]));
  const merged = new Map(current.map((cookie) => [key(cookie), cookie]));
  for (const cookie of after) {
    const id = key(cookie);
    const old = baseline.get(id);
    if (JSON.stringify(old) === JSON.stringify(cookie)) continue;
    const latest = merged.get(id);
    // Another response already changed this cookie: do not restore an older value.
    if (latest && JSON.stringify(latest) !== JSON.stringify(old)) continue;
    merged.set(id, cookie);
  }
  return [...merged.values()];
}

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "email" });
        }
      },
    });
  }
  return dbPromise;
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: () => Promise<void>;
  addAccount: (account: Account) => Promise<void>;
  removeAccount: (email: string) => Promise<void>;
  updateAccount: (account: Account, expected?: Account) => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: true,

  loadAccounts: async () => {
    const started = revision;
    set({ loading: true });
    await writes;
    const db = await getDB();
    const accounts = await db.getAll(STORE_NAME);
    if (revision === started) set({ accounts, loading: false });
    else set({ loading: false });
  },

  addAccount: async (account: Account) => {
    revision++;
    set({
      accounts: [
        ...get().accounts.filter((a) => a.email !== account.email),
        account,
      ],
    });
    await persist((db) => db.put(STORE_NAME, account));
  },

  removeAccount: async (email: string) => {
    revision++;
    set({ accounts: get().accounts.filter((a) => a.email !== email) });
    await persist((db) => db.delete(STORE_NAME, email));
  },

  updateAccount: async (account: Account, expected?: Account) => {
    const current = get().accounts.find((a) => a.email === account.email);
    if (!current || (expected && !sameSession(current, expected))) return;
    revision++;
    const next = expected && sameSession(account, expected)
      ? { ...current, cookies: mergeSessionCookies(current.cookies, expected.cookies, account.cookies) }
      : account;
    set({
      accounts: get().accounts.map((a) =>
        a.email === account.email ? next : a,
      ),
    });
    await persist((db) => db.put(STORE_NAME, next));
  },
}));

// Auto-load accounts on import
useAccountsStore.getState().loadAccounts();
