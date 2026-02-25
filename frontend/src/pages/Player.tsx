import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import Hls from "hls.js";
import { getMediaInfo, startStream, stopStream, MediaInfo } from "../api";
import TrackSelector from "../components/TrackSelector";
import { usePreferences } from "../hooks/usePreferences";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Player() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const filePath = searchParams.get("path") || "";
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const seekOffsetRef = useRef(0); // server-side start time offset

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const { prefs, setPrefs } = usePreferences();
  const [profile, setProfile] = useState(prefs.preferred_profile);
  const [audioIdx, setAudioIdx] = useState<number | null>(null);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [seekTarget, setSeekTarget] = useState<number | null>(null); // pending seek in seconds

  // Playback state
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null); // visual preview during drag

  const totalDuration = info?.duration ?? 0;
  // Effective display time: server offset + video local time, or preview while dragging
  const displayTime = seekPreview !== null ? seekPreview : seekOffsetRef.current + currentTime;

  // Load media info
  useEffect(() => {
    if (!filePath) return;
    getMediaInfo(filePath).then((data) => {
      setInfo(data);
      const preferredAudio = data.audio_tracks.find(
        (t) => t.lang === prefs.preferred_audio_lang
      );
      setAudioIdx(preferredAudio?.index ?? data.audio_tracks[0]?.index ?? 0);
      if (prefs.subtitles_enabled) {
        const preferredSub = data.subtitle_tracks.find(
          (t) => t.lang === prefs.preferred_subtitle_lang && !t.bitmap
        );
        setSubIdx(preferredSub?.index ?? null);
      }
    }).catch(() => setError("Failed to load media info"));
  }, [filePath]);

  const destroySession = useCallback(async () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (sessionRef.current) {
      await stopStream(sessionRef.current).catch(() => {});
      sessionRef.current = null;
    }
  }, []);

  // Start/restart stream (also triggered by seekTarget changes)
  useEffect(() => {
    if (!info || audioIdx === null) return;
    let cancelled = false;
    setLoading(true);
    setError("");

    const startAt = seekTarget ?? 0;
    seekOffsetRef.current = startAt;
    setCurrentTime(0);
    setSeekPreview(null);

    (async () => {
      await destroySession();
      try {
        const sess = await startStream(filePath, profile, audioIdx, startAt);
        if (cancelled) {
          await stopStream(sess.session_id).catch(() => {});
          return;
        }
        sessionRef.current = sess.session_id;
        const video = videoRef.current;
        if (!video) return;

        if (Hls.isSupported()) {
          const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60 });
          hlsRef.current = hls;
          hls.loadSource(sess.playlist);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            video.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setError("Playback error");
              setLoading(false);
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = sess.playlist;
          video.addEventListener("loadedmetadata", () => {
            setLoading(false);
            video.play().catch(() => {});
          });
        }
      } catch {
        if (!cancelled) {
          setError("Failed to start stream");
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [info, profile, audioIdx, filePath, seekTarget, destroySession]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { destroySession(); };
  }, [destroySession]);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onVolumeChange = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolumeChange);
    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, []);

  // Fullscreen change listener
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Auto-hide controls
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused && !settingsOpen) {
        setControlsVisible(false);
      }
    }, 3000);
  }, [settingsOpen]);

  // Keep controls visible while paused or settings open
  useEffect(() => {
    if (paused || settingsOpen) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    } else {
      showControls();
    }
  }, [paused, settingsOpen, showControls]);

  const handleMouseMove = useCallback(() => {
    showControls();
  }, [showControls]);

  const handleMouseLeave = useCallback(() => {
    if (!paused && !settingsOpen) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(false);
    }
  }, [paused, settingsOpen]);

  // Mobile: tap video area to toggle controls
  const handleVideoClick = useCallback((e: React.MouseEvent) => {
    // Don't toggle if clicking on controls
    if ((e.target as HTMLElement).closest("[data-controls]")) return;
    const isMobile = "ontouchend" in window;
    if (isMobile) {
      setControlsVisible((v) => !v);
    }
  }, []);

  // Close settings when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsOpen]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const video = videoRef.current;
      if (!video) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        video.paused ? video.play() : video.pause();
      } else if (e.key === "f") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "m") {
        e.preventDefault();
        video.muted = !video.muted;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekTo(seekOffsetRef.current + video.currentTime - 10);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekTo(seekOffsetRef.current + video.currentTime + 10);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [totalDuration]);

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }

  // Seek by restarting stream at new position
  function seekTo(seconds: number) {
    const clamped = Math.max(0, Math.min(totalDuration, seconds));
    setSeekTarget(clamped);
  }

  function handleSeekMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!totalDuration) return;
    setIsSeeking(true);

    const bar = e.currentTarget;
    const getFraction = (clientX: number) => {
      const rect = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    // Show preview immediately
    setSeekPreview(getFraction(e.clientX) * totalDuration);

    const onMove = (ev: MouseEvent) => {
      setSeekPreview(getFraction(ev.clientX) * totalDuration);
    };
    const onUp = (ev: MouseEvent) => {
      const targetTime = getFraction(ev.clientX) * totalDuration;
      setIsSeeking(false);
      setSeekPreview(null);
      seekTo(targetTime);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseFloat(e.target.value);
    const video = videoRef.current;
    if (video) {
      video.volume = v;
      video.muted = v === 0;
    }
  }

  function toggleMute() {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }

  function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  }

  function handleProfileChange(newProfile: string) {
    setProfile(newProfile);
    setPrefs({ preferred_profile: newProfile });
  }

  function handleAudioChange(idx: number | null) {
    if (idx === null) return;
    setAudioIdx(idx);
    const track = info?.audio_tracks.find((t) => t.index === idx);
    if (track) setPrefs({ preferred_audio_lang: track.lang });
  }

  function handleSubChange(idx: number | null) {
    setSubIdx(idx);
    setPrefs({ subtitles_enabled: idx !== null });
    if (idx !== null) {
      const track = info?.subtitle_tracks.find((t) => t.index === idx);
      if (track) setPrefs({ preferred_subtitle_lang: track.lang });
    }
  }

  const progressFraction = totalDuration > 0 ? displayTime / totalDuration : 0;

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-screen bg-black select-none ${!controlsVisible && !paused ? "cursor-none" : ""}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleVideoClick}
    >
      {/* Video */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        crossOrigin="anonymous"
      >
        {subIdx !== null && (
          <track
            key={subIdx}
            kind="subtitles"
            src={`/api/subtitle?path=${encodeURIComponent(filePath)}&track=${subIdx}`}
            default
          />
        )}
      </video>

      {/* Loading overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="text-gray-400 text-lg">Loading stream...</div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-20">
          <div className="text-red-400 text-lg">{error}</div>
        </div>
      )}

      {/* Controls overlay */}
      <div
        data-controls
        className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        {/* Top gradient bar */}
        <div className="bg-gradient-to-b from-black/70 to-transparent px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="text-sm text-gray-300 hover:text-white transition-colors shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="text-sm text-gray-200 truncate">
            {filePath.split("/").pop()}
          </div>
        </div>

        {/* Spacer — clicking here toggles play on desktop */}
        <div className="flex-1" onClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-controls-inner]")) {
            togglePlayPause();
          }
        }} />

        {/* Bottom controls area */}
        <div data-controls-inner className="bg-gradient-to-t from-black/70 to-transparent px-4 pb-4 pt-8">
          {/* Progress bar */}
          <div
            className="group relative h-1.5 bg-white/20 rounded-full cursor-pointer mb-3 hover:h-2.5 transition-all"
            onMouseDown={handleSeekMouseDown}
          >
            {/* Played portion */}
            <div
              className="absolute inset-y-0 left-0 bg-blue-500 rounded-full pointer-events-none"
              style={{ width: `${progressFraction * 100}%` }}
            />
            {/* Seek thumb */}
            <div
              className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3.5 h-3.5 bg-blue-500 rounded-full shadow transition-opacity ${isSeeking ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              style={{ left: `${progressFraction * 100}%` }}
            />
          </div>

          {/* Controls row */}
          <div className="flex items-center gap-3">
            {/* Play/Pause */}
            <button onClick={togglePlayPause} className="text-white hover:text-blue-400 transition-colors">
              {paused ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>

            {/* Time */}
            <div className="text-sm text-gray-300 tabular-nums whitespace-nowrap">
              {formatTime(displayTime)} / {formatTime(totalDuration)}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Volume + Settings + Fullscreen grouped together */}
            <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 group/vol">
              <button onClick={toggleMute} className="text-white hover:text-blue-400 transition-colors p-1">
                {muted || volume === 0 ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                  </svg>
                ) : volume < 0.5 ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
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
                className="w-0 group-hover/vol:w-20 transition-all duration-200 accent-blue-500 cursor-pointer opacity-0 group-hover/vol:opacity-100"
              />
            </div>

            {/* Settings gear */}
            <div className="relative flex items-center" ref={settingsRef}>
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                className={`p-1 text-white hover:text-blue-400 transition-colors ${settingsOpen ? "text-blue-400" : ""}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.6 3.6 0 0112 15.6z" />
                </svg>
              </button>

              {/* Settings popup */}
              {settingsOpen && (
                <div className="absolute bottom-full right-0 mb-2 bg-gray-900/95 backdrop-blur border border-gray-700 rounded-lg p-3 min-w-[240px] space-y-3 shadow-xl">
                  {info && (
                    <>
                      {/* Quality */}
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Quality</label>
                        <select
                          value={profile}
                          onChange={(e) => handleProfileChange(e.target.value)}
                          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                        >
                          {info.profiles.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>

                      {/* Audio */}
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Audio</label>
                        <TrackSelector
                          label=""
                          tracks={info.audio_tracks}
                          selected={audioIdx}
                          onChange={handleAudioChange}
                        />
                      </div>

                      {/* Subtitles */}
                      <div>
                        <label className="text-xs text-gray-400 mb-1 block">Subtitles</label>
                        <TrackSelector
                          label=""
                          tracks={info.subtitle_tracks}
                          selected={subIdx}
                          onChange={handleSubChange}
                          allowNone
                        />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="text-white hover:text-blue-400 transition-colors p-1">
              {isFullscreen ? (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
                </svg>
              )}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
