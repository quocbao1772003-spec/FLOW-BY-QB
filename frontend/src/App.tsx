import { useEffect, useRef } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Board } from "./canvas/Board";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
// import { ChatSidebar } from "./components/ChatSidebar";
import { AppSidebar } from "./components/AppSidebar";
import { FlowsPage } from "./components/FlowsPage";
import { ImageGenPage } from "./components/ImageGenPage";
import { LibraryPage } from "./components/LibraryPage";
import { ReferencesPanel } from "./components/ReferencesPanel";
import { Toaster } from "./components/Toaster";
import { GenerationDialog } from "./components/GenerationDialog";
import { ResultViewer } from "./components/ResultViewer";
import { ForcedSetupGate } from "./components/ForcedSetupGate";
import { useBoardStore } from "./store/board";
import { useReferencesStore } from "./store/references";
import { useViewStore } from "./store/view";

export function App() {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loadReferences = useReferencesStore((s) => s.load);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const view = useViewStore((s) => s.view);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    loadInitialBoard();
    // Fire-and-forget: panel renders the loading state inline and the
    // app stays usable even if references fail to hydrate.
    void loadReferences();
  }, [loadInitialBoard, loadReferences]);

  return (
    <div className="app">
      <AppSidebar />
      <ReactFlowProvider>
        {view === "canvas" && (
          <div className="canvas-wrap">
            <Toolbar />
            {loading && boardId === null ? (
              <div className="canvas-loading">Loading board…</div>
            ) : (
              <Board />
            )}
            <StatusBar />
            <ReferencesPanel />
          </div>
        )}
        {view === "flows" && <FlowsPage />}
        {view === "imagegen" && <ImageGenPage />}
        {view === "library" && <LibraryPage />}
      </ReactFlowProvider>
      {/* <ChatSidebar /> */}
      <Toaster />
      <GenerationDialog />
      <ResultViewer />
      <ForcedSetupGate />
    </div>
  );
}
