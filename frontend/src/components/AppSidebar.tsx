import { useState, type ReactNode } from "react";
import { useViewStore, type AppView } from "../store/view";
import { AccountPanel } from "./AccountPanel";
import { AccountSwitcher } from "./AccountSwitcher";
import { UserChip } from "./UserChip";
import { useSessionStore } from "../store/session";
import {
  IconFrame,
  IconGridLayout,
  IconImage,
  IconLayers,
  IconSidebar,
  IconUser,
  IconUsers,
} from "../canvas/icons";

// Magnific-style app sidebar: brand on top, primary destinations below
// (Flows / Image Gen / Library), account pinned to the bottom. The
// panel-toggle collapses it to an icon-only rail (persisted).

const ITEMS: Array<{ view: AppView; label: string; icon: ReactNode }> = [
  { view: "flows", label: "Flows", icon: <IconFrame size={15} /> },
  { view: "imagegen", label: "Image Gen", icon: <IconImage size={15} /> },
  { view: "templates", label: "Thư viện mẫu", icon: <IconLayers size={15} /> },
  { view: "library", label: "Library", icon: <IconGridLayout size={15} /> },
  { view: "accounts", label: "Tài khoản Flow", icon: <IconUser size={15} /> },
];

const ADMIN_ITEMS: Array<{ view: AppView; label: string; icon: ReactNode }> = [
  { view: "team", label: "Nhân viên", icon: <IconUsers size={15} /> },
];

const LS_KEY = "flowboard:sidebarCollapsed";

export function AppSidebar() {
  const view = useViewStore((s) => s.view);
  const user = useSessionStore((s) => s.user);
  const authRequired = useSessionStore((s) => s.authRequired);
  // Local single-user app: show "Nhân viên" so the admin can switch login on.
  const items = !authRequired || user?.role === "admin" ? [...ITEMS, ...ADMIN_ITEMS] : ITEMS;
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
        {items.map((item) => (
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
        <UserChip collapsed={collapsed} />
        <AccountSwitcher collapsed={collapsed} />
        <AccountPanel collapsed={collapsed} />
      </div>
    </div>
  );
}
