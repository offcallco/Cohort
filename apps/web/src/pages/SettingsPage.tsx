import { NavLink, Outlet } from "react-router";

// Settings: boring on purpose.
export function SettingsPage() {
  return (
    <>
      <h1>Settings</h1>
      <nav className="tabs">
        <NavLink to="/settings/tokens">Access tokens</NavLink>
      </nav>
      <Outlet />
    </>
  );
}
