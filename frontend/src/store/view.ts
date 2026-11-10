import { create } from "zustand";

// App-level view switching for the Magnific-style sidebar:
//   canvas   — the node canvas (default)
//   flows    — gallery of boards ("Spaces" page)
//   imagegen — standalone single-image generator
//   library  — all generated/uploaded media
//   accounts — Google Flow accounts (Chrome profiles) and auto switching
//   templates — shared template library
//   team     — admin: Flowboard user accounts
export type AppView = "canvas" | "flows" | "imagegen" | "library" | "accounts" | "templates" | "team";

interface ViewState {
  view: AppView;
  setView(v: AppView): void;
}

export const useViewStore = create<ViewState>((set) => ({
  view: "canvas",
  setView: (v) => set({ view: v }),
}));
