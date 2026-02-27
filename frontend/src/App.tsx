import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import Login from "./pages/Login";
import Browse from "./pages/Browse";
import Player from "./pages/Player";
import AudioPlayer from "./pages/AudioPlayer";
import Gallery from "./pages/Gallery";
import ThumbnailGen from "./pages/ThumbnailGen";
import Preferences from "./pages/Preferences";
import { checkAuth } from "./api";
import { MusicPlayerProvider } from "./hooks/useMusicPlayer";
import MusicBar from "./components/MusicBar";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    checkAuth().then(setAuthed);
  }, []);

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
            path="/preferences"
            element={authed ? <Preferences /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/thumbnails"
            element={authed ? <ThumbnailGen /> : <Navigate to="/login" replace />}
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
