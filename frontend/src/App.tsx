import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useState, useEffect, type ReactNode } from "react";
import Login from "./pages/Login";
import Browse from "./pages/Browse";
import Player from "./pages/Player";
import AudioPlayer from "./pages/AudioPlayer";
import Gallery from "./pages/Gallery";
import Reader from "./pages/Reader";
import { checkAuth, loginWithKey, migrateLocalStorage, onAuthLost } from "./api";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicBar from "./components/MusicBar";
import { RouteTracker, restoreStandaloneRoute, clearSavedRoute } from "./hooks/useRouteRestore";

function useMigration(authed: boolean | null) {
  useEffect(() => {
    if (authed !== true) return;
    const MIGRATED_KEY = "rc-migrated-to-db";
    try {
      if (localStorage.getItem(MIGRATED_KEY)) return;
    } catch {}

    const data: Record<string, unknown> = {};

    // Gather preferences
    try {
      const prefs = localStorage.getItem("media_preferences");
      if (prefs) data.preferences = JSON.parse(prefs);
    } catch {}

    // Gather music volume/profile
    try {
      const vol = localStorage.getItem("rc-music-volume");
      if (vol !== null) data.music_volume = parseFloat(vol);
      const profile = localStorage.getItem("rc-music-profile");
      if (profile) data.music_profile = profile;
    } catch {}

    // Gather read positions
    try {
      const positions = localStorage.getItem("rc-read-position");
      if (positions) data.read_positions = JSON.parse(positions);
    } catch {}

    // Gather reader settings
    try {
      const settings = localStorage.getItem("rc-reader-settings");
      if (settings) data.reader_settings = JSON.parse(settings);
    } catch {}

    if (Object.keys(data).length === 0) {
      try {
        localStorage.setItem(MIGRATED_KEY, "1");
      } catch {}
      return;
    }

    migrateLocalStorage(data)
      .then(() => {
        try {
          localStorage.setItem(MIGRATED_KEY, "1");
        } catch {}
      })
      .catch(() => {});
  }, [authed]);
}

function RequireAuth({ authed, children }: { authed: boolean; children: ReactNode }) {
  const location = useLocation();
  if (authed) return <>{children}</>;
  return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
}

function LoginRoute({ authed, onLogin }: { authed: boolean; onLogin: () => void }) {
  const location = useLocation();
  if (!authed) return <Login onLogin={onLogin} />;
  const from = (location.state as { from?: string } | null)?.from;
  const target = from && from.startsWith("/") && !from.startsWith("/login") ? from : "/";
  return <Navigate to={target} replace />;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    // Must run before BrowserRouter mounts so the router picks up the restored URL.
    restoreStandaloneRoute();

    const params = new URLSearchParams(window.location.search);
    const key = params.get("key");

    if (key) {
      // Strip the key from the URL so it isn't left in history / shared again.
      params.delete("key");
      const search = params.toString();
      const newUrl =
        window.location.pathname +
        (search ? `?${search}` : "") +
        window.location.hash;
      window.history.replaceState({}, "", newUrl);

      loginWithKey(key).then((ok) => {
        if (ok) setAuthed(true);
        else checkAuth().then(setAuthed);
      });
      return;
    }

    checkAuth().then(setAuthed);
  }, []);

  useEffect(() => {
    return onAuthLost(() => setAuthed(false));
  }, []);

  // Run migration after auth check
  useMigration(authed);

  if (authed === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <MusicPlayerProvider>
      <BrowserRouter>
        <RouteTracker />
        <Routes>
          <Route
            path="/login"
            element={<LoginRoute authed={authed} onLogin={() => setAuthed(true)} />}
          />
          <Route path="/play" element={<RequireAuth authed={authed}><Player /></RequireAuth>} />
          <Route path="/audio" element={<RequireAuth authed={authed}><AudioPlayer /></RequireAuth>} />
          <Route path="/gallery" element={<RequireAuth authed={authed}><Gallery /></RequireAuth>} />
          <Route path="/read" element={<RequireAuth authed={authed}><Reader /></RequireAuth>} />
          <Route
            path="*"
            element={
              <RequireAuth authed={authed}>
                <Browse
                  onLogout={() => {
                    clearSavedRoute();
                    setAuthed(false);
                  }}
                />
              </RequireAuth>
            }
          />
        </Routes>
        <MusicBar />
      </BrowserRouter>
    </MusicPlayerProvider>
  );
}
