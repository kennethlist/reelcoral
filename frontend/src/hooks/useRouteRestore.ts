import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const LAST_ROUTE_KEY = "rc-last-route";

function isStandalone(): boolean {
  try {
    if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
    return window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  } catch {
    return false;
  }
}

function saveRoute(route: string) {
  try {
    localStorage.setItem(LAST_ROUTE_KEY, route);
  } catch {}
}

export function clearSavedRoute() {
  try {
    localStorage.removeItem(LAST_ROUTE_KEY);
  } catch {}
}

/**
 * iOS evicts home-screen (standalone) web apps from memory and relaunches
 * them at the manifest start_url, discarding the route the user was on.
 * Call this before the router mounts: on a bare "/" cold launch in
 * standalone mode, swap the URL for the last route we recorded.
 */
export function restoreStandaloneRoute() {
  if (!isStandalone()) return;
  if (window.location.pathname !== "/" || window.location.search) return;
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(LAST_ROUTE_KEY);
  } catch {}
  if (!saved || saved === "/" || !saved.startsWith("/") || saved.startsWith("/login")) return;
  window.history.replaceState({}, "", saved);
}

/** Records the current route so restoreStandaloneRoute can return to it. */
export function RouteTracker() {
  const location = useLocation();
  useEffect(() => {
    if (location.pathname.startsWith("/login")) return;
    saveRoute(location.pathname + location.search);
  }, [location.pathname, location.search]);
  return null;
}
