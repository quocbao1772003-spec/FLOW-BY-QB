import { useState, type ReactNode } from "react";
import { useViewStore, type AppView } from "../store/view";
import { AccountPanel } from "./AccountPanel";
import {
  IconFrame,
  IconGridLayout,
  IconImage,
  IconSidebar,
} from "../canvas/icons";

// Magnific-style app sidebar: brand on top, primary destinations below
// (Flows / Image Gen / Library), account pinned to the bottom. The
// panel-toggle collapses it to an icon-only rail (persisted).

const ITEMS: Array<{ view: AppView; label: string; icon: ReactNode }> = [
  { view: "flows", label: "Flows", icon: <IconFrame size={15} /> },
  { view: "imagegen", label: "Image Gen", icon: <IconImage size={15} /> },
  { view: "library", label: "Library", icon: <IconGridLayout size={15} /> },
];

const LS_KEY = "flowboard:sidebarCollapsed";

export function AppSidebar() {
  const view = useViewStore((s) => s.view);
  const setView = useViewStore((s) => s.setView);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(LS_KEY, next ? "1" : "0");
      } catch {
        // non-fatal
      }
      return next;
    });
  }

  return (
    <div className={`app-sidebar${collapsed ? " app-sidebar--collapsed" : ""}`}>
      <div className="app-sidebar__top">
        <button
          type="button"
          className="app-sidebar__brand"
          onClick={() => setView("canvas")}
          title="Back to canvas"
        >
          {collapsed ? "F" : "Flowboard"}
        </button>
        <button
          type="button"
          className="app-sidebar__toggle"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <IconSidebar size={14} />
        </button>
      </div>

      <nav className="app-sidebar__nav" aria-label="Main">
        {ITEMS.map((item) => (
          <button
            key={item.view}
            type="button"
            className={`app-sidebar__item${view === item.view ? " app-sidebar__item--active" : ""}`}
            onClick={() => setView(item.view)}
            title={item.label}
            aria-label={item.label}
          >
            <span className="app-sidebar__icon">{item.icon}</span>
            {!collapsed && item.label}
          </button>
        ))}
      </nav>

      <div className="app-sidebar__bottom">
        <AccountPanel collapsed={collapsed} />
      </div>
    </div>
  );
}
