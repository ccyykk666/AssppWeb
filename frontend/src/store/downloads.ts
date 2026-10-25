import { create } from "zustand";
import type { DownloadTask, Software, Sinf } from "../types";
import * as downloadsApi from "../api/downloads";
import { useAccountsStore } from './accounts';
import { accountHash } from '../utils/account';
import i18n from '../i18n';
import type { DownloadOutput } from '../types';

interface DownloadsState {
  tasks: DownloadTask[];
  loading: boolean;
  accountHashes: string[];
  setAccountHashes: (hashes: string[]) => void;
  fetchTasks: () => Promise<void>;
  startDownload: (data: {
    software: Software;
    accountHash: string;
    downloadURL: string;
    sinfs: Sinf[];
    bundleVersion?: string;
    pinnedVersion?: boolean;
    iTunesMetadata?: string;
  }) => Promise<void>;
  pauseDownload: (id: string) => Promise<void>;
  resumeDownload: (id: string) => Promise<void>;
  deleteDownload: (id: string) => Promise<void>;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export const useDownloadsStore = create<DownloadsState>((set, get) => ({
  tasks: [],
  loading: false,
  accountHashes: [],

  setAccountHashes: (hashes) => set({ accountHashes: hashes }),

  fetchTasks: async () => {
    const { accountHashes } = get();
    set({ loading: true });
    try {
      const tasks = await downloadsApi.fetchDownloads(accountHashes);
      set({ tasks, loading: false });

      const hasActive = tasks.some(
        (t) =>
          t.status === "downloading" ||
          t.status === "pending" ||
          t.status === "injecting",
      );
      if (hasActive && !pollInterval) {
        pollInterval = setInterval(() => {
          get().fetchTasks();
        }, 2000);
      } else if (!hasActive && pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    } catch {
      set({ loading: false });
    }
  },

  startDownload: async (data) => {
    await downloadsApi.startDownload(data);
    await get().fetchTasks();
  },

  pauseDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.pauseDownload(id, task.accountHash);
    await get().fetchTasks();
  },

  resumeDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    let replacement: DownloadOutput | undefined;
    if (task.error === 'Download URL expired' && task.externalVersionId) {
      const [{ getDownloadInfo }, { recoverAccountOperation }] = await Promise.all([
        import('../apple/download'), import('../apple/accountSession'),
      ]);
      const accounts = useAccountsStore.getState().accounts;
      const hashes = await Promise.all(accounts.map((account) => accountHash(account)));
      const account = accounts[hashes.indexOf(task.accountHash)];
      if (!account) throw new Error(i18n.t('errors.messages.networkFailed'));
      const result = await recoverAccountOperation(account, task.software,
        (current) => getDownloadInfo(current, task.software, task.externalVersionId));
      if (result.output.bundleVersion !== task.bundleVersion || result.output.bundleShortVersionString !== task.software.version) {
        throw new Error(i18n.t('errors.download.mismatchedItem'));
      }
      replacement = result.output;
    }
    await downloadsApi.resumeDownload(id, task.accountHash, replacement);
    await get().fetchTasks();
  },

  deleteDownload: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    await downloadsApi.deleteDownload(id, task.accountHash);
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },
}));
