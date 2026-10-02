import { create } from "zustand";

interface NavigationState {
  pending: boolean;
  start: () => void;
  finish: () => void;
}

let safetyTimer: ReturnType<typeof setTimeout> | undefined;

export const useNavigationStore = create<NavigationState>((set) => ({
  pending: false,
  start: () => {
    if (safetyTimer) clearTimeout(safetyTimer);
    set({ pending: true });
    safetyTimer = setTimeout(() => set({ pending: false }), 20_000);
  },
  finish: () => {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = undefined;
    set({ pending: false });
  },
}));
