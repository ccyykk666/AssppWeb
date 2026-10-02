import { create } from "zustand";
import { searchApps, lookupApp } from "../api/search";
import { getErrorMessage } from '../utils/error';
import i18n from '../i18n';
import type { Software } from "../types";

interface SearchState {
  term: string;
  country: string;
  entity: string;
  results: Software[];
  resultsCountry: string;
  loading: boolean;
  error: string | null;
  setSearchParam: (
    param: Partial<Pick<SearchState, "term" | "country" | "entity">>,
  ) => void;
  search: (term: string, country: string, entity: string) => Promise<void>;
  lookup: (bundleId: string, country: string) => Promise<void>;
  clear: () => void; // 新增：清空搜索状态的方法
}

export const useSearch = create<SearchState>((set) => ({
  term: "",
  country: "",
  entity: "",
  results: [],
  resultsCountry: '',
  loading: false,
  error: null,
  setSearchParam: (param) => set((state) => ({ ...state, ...param })),
  search: async (term, country, entity) => {
    set({ loading: true, error: null, term, country, entity });
    try {
      const apps = await searchApps(term, country, entity);
      set({ results: apps, resultsCountry: country });
    } catch (e) {
      set({
        error: getErrorMessage(e, i18n.t('errors.messages.searchFailed')),
        results: [],
        resultsCountry: '',
      });
    } finally {
      set({ loading: false });
    }
  },
  lookup: async (bundleId, country) => {
    set({ loading: true, error: null });
    try {
      const app = await lookupApp(bundleId, country);
      set({ results: app ? [app] : [], resultsCountry: country });
    } catch (e) {
      set({
        error: getErrorMessage(e, i18n.t('errors.messages.lookupFailed')),
        results: [],
        resultsCountry: '',
      });
    } finally {
      set({ loading: false });
    }
  },
  // 清空关键词、结果和错误信息，但保留选择的国家和设备类型（作为用户偏好）
  clear: () => set({ term: "", results: [], resultsCountry: '', error: null }),
}));
