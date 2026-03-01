import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import Login from "./pages/Login";
import Browse from "./pages/Browse";
import Player from "./pages/Player";
import AudioPlayer from "./pages/AudioPlayer";
import Gallery from "./pages/Gallery";
import Reader from "./pages/Reader";
import { checkAuth, migrateLocalStorage } from "./api";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicBar from "./components/MusicBar";

function useMigration() {
  useEffect(() => {
    const MIGRATED_KEY = "rc-migrated-to-db";
    if (localStorage.getItem(MIGRATED_KEY)) return;

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
      localStorage.setItem(MIGRATED_KEY, "1");
      return;
    }

    migrateLocalStorage(data)
      .then(() => localStorage.setItem(MIGRATED_KEY, "1"))
      .catch(() => {});
  }, []);
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

  // Run migration after auth check
  useMigration();

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
        <Routes>
          <Route
            path="/login"
            element={
              authed ? (
                <Navigate to="/" replace />
              ) : (
                <Login onLogin={() => setAuthed(true)} />
              )
            }
          />
          <Route
            path="/play"
            element={authed ? <Player /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/audio"
            element={authed ? <AudioPlayer /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/gallery"
            element={authed ? <Gallery /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/read"
            element={authed ? <Reader /> : <Navigate to="/login" replace />}
          />
          <Route
            path="*"
            element={
              authed ? <Browse onLogout={() => setAuthed(false)} /> : <Navigate to="/login" replace />
            }
          />
        </Routes>
        <MusicBar />
      </BrowserRouter>
    </MusicPlayerProvider>
  );
}
