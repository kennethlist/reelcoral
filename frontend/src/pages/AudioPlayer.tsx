import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { audioUrl, getConfig, browse, BrowseEntry, setFileStatus } from "../api";
import { useMusicPlayer } from "../hooks/useMusicPlayer";

const PROFILE_KEY = "rc-music-profile";

function loadProfile(): string {
  try {
    return localStorage.getItem(PROFILE_KEY) || "Original";
  } catch {
    return "Original";
  }
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function AudioPlayer() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const filePath = searchParams.get("path") || "";
  const audioRef = useRef<HTMLAudioElement>(null);
  const music = useMusicPlayer();

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [profile, setProfile] = useState(loadProfile);
  const [availableProfiles, setAvailableProfiles] = useState<{ name: string; bitrate?: string }[]>([]);
  const [showQuality, setShowQuality] = useState(false);
  const qualityRef = useRef<HTMLDivElement>(null);

  // Sibling navigation
  const [siblings, setSiblings] = useState<BrowseEntry[]>([]);
  const [siblingIndex, setSiblingIndex] = useState(-1);

  const fileName = filePath.split("/").pop() || "";

  // Dismiss music bar on mount
  useEffect(() => {
    if (music.isVisible) music.dismiss();
  }, []);

  // Load config for profiles
  useEffect(() => {
    getConfig()
      .then((cfg) => setAvailableProfiles(cfg.music_profiles || []))
      .catch(() => {});
  }, []);

  // Load audio source
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !filePath) return;
    audio.src = audioUrl(filePath, profile);
    audio.volume = volume;
    audio.muted = muted;
    audio.play().catch(() => {});
  }, [filePath, profile]);

  // Load siblings
  useEffect(() => {
    if (!filePath) return;
    const parentDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    let search = "";
    let letter: string | undefined;
    let sort: string | undefined;
    let sortDir: string | undefined;
    try {
      const raw = sessionStorage.getItem("rc-dir-state");
      if (raw) {
        const saved = JSON.parse(raw)[parentDir];
        if (saved) {
          search = saved.search || "";
          letter = saved.letter || undefined;
          sort = saved.sort || undefined;
          sortDir = saved.sortDir || undefined;
        }
      }
    } catch {}
    browse(parentDir, 1, 200, search, letter, sort, sortDir).then((data) => {
      const files = data.entries.filter((e) => !e.is_dir);
      setSiblings(files);
      const idx = files.findIndex((e) => e.path === filePath);
      setSiblingIndex(idx >= 0 ? idx : -1);
    }).catch(() => {});
  }, [filePath]);

  const hasPrev = siblingIndex > 0;
  const hasNext = siblingIndex >= 0 && siblingIndex < siblings.length - 1;

  const goToSibling = useCallback((delta: number) => {
    const nextIdx = siblingIndex + delta;
    if (nextIdx < 0 || nextIdx >= siblings.length) return;
    // Mark current file as viewed before navigating away
    if (filePath) setFileStatus(filePath, "opened").catch(() => {});
    const entry = siblings[nextIdx];
    const ext = "." + entry.name.split(".").pop()?.toLowerCase();
    const readerExts = new Set([".epub", ".pdf", ".cbr", ".cbz", ".md"]);
    if (entry.is_image) {
      navigate(`/gallery?path=${encodeURIComponent(entry.path)}`, { replace: true });
    } else if (entry.is_audio) {
      navigate(`/audio?path=${encodeURIComponent(entry.path)}`, { replace: true });
    } else if (entry.is_ebook || entry.is_comic || entry.is_markdown || readerExts.has(ext)) {
      navigate(`/read?path=${encodeURIComponent(entry.path)}`, { replace: true });
    } else {
      navigate(`/play?path=${encodeURIComponent(entry.path)}`, { replace: true });
    }
  }, [filePath, siblingIndex, siblings, navigate]);

  // Audio event listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onVolumeChange = () => {
      setVolume(audio.volume);
      setMuted(audio.muted);
    };
    const onEnded = () => {
      if (hasNext) {
        goToSibling(1);
      } else {
        setIsPlaying(false);
      }
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("volumechange", onVolumeChange);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("volumechange", onVolumeChange);
      audio.removeEventListener("ended", onEnded);
    };
  }, [hasNext, goToSibling]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const audio = audioRef.current;
      if (!audio) return;
      if (e.key === " ") {
        e.preventDefault();
        audio.paused ? audio.play() : audio.pause();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goToSibling(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToSibling(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        audio.volume = Math.min(1, audio.volume + 0.05);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        audio.volume = Math.max(0, audio.volume - 0.05);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [goToSibling]);

  // MediaSession API — enables background audio & lock screen controls
  useEffect(() => {
    if (!("mediaSession" in navigator) || !filePath) return;

    const trackName = fileName.replace(/\.[^/.]+$/, "");
    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackName,
      artist: "",
    });

    navigator.mediaSession.setActionHandler("play", () => {
      audioRef.current?.play().catch(() => {});
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      audioRef.current?.pause();
    });
    navigator.mediaSession.setActionHandler("nexttrack", hasNext ? () => goToSibling(1) : null);
    navigator.mediaSession.setActionHandler("previoustrack", hasPrev ? () => goToSibling(-1) : null);
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null && audioRef.current) {
        audioRef.current.currentTime = details.seekTime;
      }
    });
  }, [filePath, fileName, hasNext, hasPrev, goToSibling]);

  // MediaSession playback state
  useEffect(() => {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }
  }, [isPlaying]);

  // MediaSession position state
  useEffect(() => {
    if ("mediaSession" in navigator && duration > 0 && isFinite(duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.min(currentTime, duration),
          playbackRate: 1,
        });
      } catch {}
    }
  }, [currentTime, duration]);

  // Close quality dropdown on outside click
  useEffect(() => {
    if (!showQuality) return;
    function handleClick(e: MouseEvent) {
      if (qualityRef.current && !qualityRef.current.contains(e.target as Node)) setShowQuality(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showQuality]);

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.paused ? audio.play() : audio.pause();
  }

  function handleSeek(e: React.MouseEvent<HTMLDivElement>) {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseFloat(e.target.value);
    const audio = audioRef.current;
    if (audio) {
      audio.volume = v;
      audio.muted = v === 0;
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    if (audio) audio.muted = !audio.muted;
  }

  function handleProfileChange(newProfile: string) {
    const audio = audioRef.current;
    const pos = audio?.currentTime || 0;
    setProfile(newProfile);
    localStorage.setItem(PROFILE_KEY, newProfile);
    setShowQuality(false);
    // Restore position after source change
    setTimeout(() => {
      if (audioRef.current && pos > 0) {
        audioRef.current.currentTime = pos;
      }
    }, 100);
  }

  function goBack() {
    const parentDir = filePath.substring(0, filePath.lastIndexOf("/")) || "/";
    const params = new URLSearchParams({ path: parentDir });
    try {
      const raw = sessionStorage.getItem("rc-dir-state");
      if (raw) {
        const saved = JSON.parse(raw)[parentDir];
        if (saved) {
          if (saved.page > 1) params.set("page", String(saved.page));
          if (saved.search) params.set("search", saved.search);
          if (saved.letter) params.set("letter", saved.letter);
          if (saved.sort) params.set("sort", saved.sort);
          if (saved.sortDir) params.set("dir", saved.sortDir);
        }
      }
    } catch {}
    navigate(`/?${params}`);
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="relative w-full h-screen bg-gray-950 flex flex-col">
      <audio ref={audioRef} preload="auto" style={{ display: "none" }} />

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 pt-[max(0.75rem,calc(env(safe-area-inset-top)+0.5rem))]">
        <button
          onClick={goBack}
          className="text-gray-300 hover:text-white transition-colors shrink-0 cursor-pointer"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        {siblings.length > 1 && siblingIndex >= 0 && (
          <div className="text-sm text-gray-400 tabular-nums whitespace-nowrap">
            {siblingIndex + 1} / {siblings.length}
          </div>
        )}
      </div>

      {/* Center content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 gap-6">
        {/* Music note icon */}
        <div className="w-32 h-32 bg-gray-800 rounded-2xl flex items-center justify-center">
          <svg className="w-16 h-16 text-gray-500" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
          </svg>
        </div>

        {/* Filename */}
        <div className="text-white text-lg font-medium text-center max-w-md truncate w-full">
          {fileName}
        </div>

        {/* Progress bar */}
        <div className="w-full max-w-md">
          <div
            className="h-1.5 bg-gray-700 rounded-full cursor-pointer group relative"
            onClick={handleSeek}
          >
            <div
              className="h-full bg-blue-500 rounded-full relative"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs text-gray-400 tabular-nums">{formatTime(currentTime)}</span>
            <span className="text-xs text-gray-400 tabular-nums">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-6">
          <button
            onClick={() => goToSibling(-1)}
            disabled={!hasPrev}
            className={`p-2 transition-colors cursor-pointer ${hasPrev ? "text-gray-300 hover:text-white" : "text-gray-700 cursor-default"}`}
            title="Previous"
          >
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
            </svg>
          </button>

          <button
            onClick={togglePlayPause}
            className="bg-white text-gray-900 hover:bg-gray-200 rounded-full p-4 transition-colors cursor-pointer"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            onClick={() => goToSibling(1)}
            disabled={!hasNext}
            className={`p-2 transition-colors cursor-pointer ${hasNext ? "text-gray-300 hover:text-white" : "text-gray-700 cursor-default"}`}
            title="Next"
          >
            <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          </button>
        </div>

        {/* Quality + Volume row */}
        <div className="flex items-center gap-4">
          {/* Quality selector */}
          {availableProfiles.length > 0 && (
            <div ref={qualityRef} className="relative">
              <button
                onClick={() => setShowQuality((v) => !v)}
                className="text-xs text-gray-400 hover:text-white transition-colors cursor-pointer px-2 py-1 border border-gray-700 rounded"
                title="Audio quality"
              >
                {profile}
              </button>
              {showQuality && (
                <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-gray-900 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
                  {availableProfiles.map((p) => (
                    <button
                      key={p.name}
                      onClick={() => handleProfileChange(p.name)}
                      className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                        profile === p.name ? "text-blue-400 bg-gray-800" : "text-gray-300 hover:bg-gray-800 hover:text-white"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Volume */}
          <div className="flex items-center gap-1">
            <button onClick={toggleMute} className="text-gray-400 hover:text-white transition-colors p-1 cursor-pointer">
              {muted || volume === 0 ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : volume < 0.5 ? (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              className="w-20 accent-blue-500 cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Desktop side arrows */}
      {!("ontouchend" in window) && hasPrev && (
        <button
          onClick={() => goToSibling(-1)}
          className="absolute left-0 top-14 bottom-14 w-16 flex items-center justify-center cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </div>
        </button>
      )}
      {!("ontouchend" in window) && hasNext && (
        <button
          onClick={() => goToSibling(1)}
          className="absolute right-0 top-14 bottom-14 w-16 flex items-center justify-center cursor-pointer opacity-0 hover:opacity-100 transition-opacity"
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      )}
    </div>
  );
}
