import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import Hls from "hls.js";
import { getMediaInfo, startStream, stopStream, MediaInfo, browse, BrowseEntry } from "../api";
import TrackSelector from "../components/TrackSelector";
import { usePreferences, SubtitleFontSize } from "../hooks/usePreferences";

const subtitleSizeClass: Record<SubtitleFontSize, string> = {
  "small": "text-xl",
  "medium": "text-3xl",
  "large": "text-4xl",
  "extra-large": "text-5xl",
};

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function Player() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const filePath = searchParams.get("path") || "";
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const seekOffsetRef = useRef(0); // server-side start time offset (requested position)
  const subOffsetRef = useRef(0);  // actual keyframe start for subtitle sync

  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const { prefs, setPrefs } = usePreferences();
  const [profile, setProfile] = useState(prefs.preferred_profile);
  const [audioIdx, setAudioIdx] = useState<number | null>(null);
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [subMode, setSubMode] = useState<"burn" | "external">(prefs.subtitle_mode);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);
  const subCuesRef = useRef<{ start: number; end: number; text: string }[]>([]);
  const [subText, setSubText] = useState("");
  const [videoBottom, setVideoBottom] = useState(0); // px from bottom of container to bottom of video content

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
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState(0); // px offset within progress bar

  // Sibling files for next/prev navigation
  const [siblings, setSiblings] = useState<BrowseEntry[]>([]);
  const [siblingIndex, setSiblingIndex] = useState(-1);

  // Burn-in subtitle index: only meaningful when burning in on a non-original profile
  const burnSubIdx = subMode === "burn" && profile !== "original" ? subIdx : null;

  const totalDuration = info?.duration ?? 0;
  // Effective display time: server offset + video local time, or preview while dragging
  const displayTime = seekPreview !== null ? seekPreview : seekOffsetRef.current + currentTime;

  const destroySession = useCallback(async () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    subCuesRef.current = [];
    if (sessionRef.current) {
      await stopStream(sessionRef.current).catch(() => {});
      sessionRef.current = null;
    }
  }, []);

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
        const langSubs = data.subtitle_tracks.filter(
          (t) => t.lang === prefs.preferred_subtitle_lang && !t.bitmap
        );
        let bestSub = langSubs[0] ?? null;
        if (langSubs.length > 1) {
          // Prefer tracks with "full" in the title
          const fullSub = langSubs.find(
            (t) => t.title.toLowerCase().includes("full")
          );
          if (fullSub) {
            bestSub = fullSub;
          } else {
            // Avoid tracks that are "songs" only
            const nonSongs = langSubs.filter(
              (t) => !t.title.toLowerCase().includes("song")
            );
            if (nonSongs.length > 0) bestSub = nonSongs[0];
          }
        }
        setSubIdx(bestSub?.index ?? null);
      }
    }).catch(() => setError("Failed to load media info"));
  }, [filePath]);

  // Load sibling files from parent directory for next/prev navigation,
  // respecting any active filters from the browse page
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
      // Navigate to another video — update search params to trigger re-init
      setSearchParams({ path: entry.path }, { replace: true });
    }
  }, [siblingIndex, siblings, navigate, setSearchParams]);

  // Stream effect — only fires when actual stream params change
  useEffect(() => {
    if (!info || audioIdx === null) return;
    let cancelled = false;
    setLoading(true);
    setError("");

    const startAt = seekTarget ?? 0;

    const oldSessionId = sessionRef.current;
    const oldHls = hlsRef.current;

    (async () => {
      try {
        const sess = await startStream(filePath, profile, audioIdx, startAt, burnSubIdx, oldSessionId);
        if (cancelled) {
          await stopStream(sess.session_id).catch(() => {});
          return;
        }
        sessionRef.current = sess.session_id;
        // For copy-mode streams, the backend returns the actual keyframe
        // start time which may differ from the requested startAt.
        const actualStart = sess.actual_start ?? startAt;

        const video = videoRef.current;
        if (!video) return;

        if (Hls.isSupported()) {
          const isOriginal = profile === "original";
          const newHls = new Hls({
            maxBufferLength: isOriginal ? 15 : 30,
            maxMaxBufferLength: isOriginal ? 30 : 60,
            startPosition: 0,
          });

          // Make-before-break: load source without attaching to video yet
          newHls.loadSource(sess.playlist);

          let networkRetries = 0;
          newHls.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                networkRetries++;
                if (networkRetries <= 3) {
                  newHls.startLoad();
                } else {
                  const pos = seekOffsetRef.current + (video.currentTime || 0);
                  setSeekTarget(pos);
                }
              } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                newHls.recoverMediaError();
              } else {
                setError("Playback error");
                setLoading(false);
              }
            } else {
              networkRetries = 0;
            }
          });

          newHls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (cancelled) return;
            // Tear down old HLS now that the new one is ready
            if (oldHls) {
              oldHls.detachMedia();
              oldHls.destroy();
            }
            setSubText("");
            // Attach new HLS and start playing
            newHls.attachMedia(video);
            hlsRef.current = newHls;
            setLoading(false);
            // Calibrate offsets once playback actually starts, then clear
            // the seek preview so displayTime switches to the real value.
            // seekOffsetRef uses requested startAt (for progress bar display).
            // subOffsetRef uses actualStart (keyframe-snapped, for subtitle sync).
            const onPlaying = () => {
              seekOffsetRef.current = startAt - video.currentTime;
              subOffsetRef.current = actualStart - video.currentTime;
              setCurrentTime(video.currentTime);
              setSeekPreview(null);
              video.removeEventListener("playing", onPlaying);
            };
            video.addEventListener("playing", onPlaying);
            video.play().catch(() => {});
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari native HLS — no make-before-break possible
          if (oldHls) { oldHls.destroy(); }
          hlsRef.current = null;
          if (oldSessionId && oldSessionId !== sess.session_id) {
            await stopStream(oldSessionId).catch(() => {});
          }
          setSubText("");
          video.src = sess.playlist;
          video.addEventListener("loadedmetadata", () => {
            setLoading(false);
            const onPlaying = () => {
              seekOffsetRef.current = startAt - video.currentTime;
              subOffsetRef.current = actualStart - video.currentTime;
              setCurrentTime(video.currentTime);
              setSeekPreview(null);
              video.removeEventListener("playing", onPlaying);
            };
            video.addEventListener("playing", onPlaying);
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

    return () => {
      cancelled = true;
    };
  }, [info, profile, audioIdx, burnSubIdx, filePath, seekTarget]);

  // Subtitle effect — handles external subtitle cue fetching independently
  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    subCuesRef.current = [];
    setSubText("");

    const effectiveSubMode = profile === "original" ? "external" : subMode;
    if (effectiveSubMode === "external" && subIdx !== null) {
      (async () => {
        try {
          const res = await fetch(
            `/api/subtitle?path=${encodeURIComponent(filePath)}&track=${subIdx}&fmt=json`
          );
          if (res.ok && !cancelled) {
            subCuesRef.current = await res.json();
          }
        } catch {}
      })();
    }

    return () => { cancelled = true; };
  }, [info, subIdx, subMode, profile, filePath]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { destroySession(); };
  }, [destroySession]);


  // Calculate the letterbox offset so subtitles sit above the video bottom
  useEffect(() => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container) return;

    const calcBottom = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) { setVideoBottom(0); return; }
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const videoAspect = vw / vh;
      const containerAspect = cw / ch;
      if (videoAspect > containerAspect) {
        // Pillarboxed (bars top/bottom)
        const renderedH = cw / videoAspect;
        setVideoBottom((ch - renderedH) / 2);
      } else {
        // Letterboxed (bars left/right) or exact fit
        setVideoBottom(0);
      }
    };

    calcBottom();
    // Catch cases where metadata is already loaded synchronously (cached video)
    const rafId = requestAnimationFrame(() => setTimeout(calcBottom, 0));
    video.addEventListener("loadedmetadata", calcBottom);
    video.addEventListener("loadeddata", calcBottom);
    video.addEventListener("playing", calcBottom);
    window.addEventListener("resize", calcBottom);
    const onFs = () => requestAnimationFrame(calcBottom);
    document.addEventListener("fullscreenchange", onFs);
    // Orientation changes on mobile may not update layout immediately
    const onOrientation = () => {
      requestAnimationFrame(calcBottom);
      setTimeout(calcBottom, 100);
      setTimeout(calcBottom, 300);
    };
    window.addEventListener("orientationchange", onOrientation);
    // ResizeObserver catches layout changes that resize/orientationchange may miss
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(calcBottom);
      ro.observe(container);
    }
    return () => {
      cancelAnimationFrame(rafId);
      video.removeEventListener("loadedmetadata", calcBottom);
      video.removeEventListener("loadeddata", calcBottom);
      video.removeEventListener("playing", calcBottom);
      window.removeEventListener("resize", calcBottom);
      document.removeEventListener("fullscreenchange", onFs);
      window.removeEventListener("orientationchange", onOrientation);
      ro?.disconnect();
    };
  }, []);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      // Match external subtitle cues against absolute file time
      const cues = subCuesRef.current;
      if (cues.length > 0) {
        const absTime = subOffsetRef.current + video.currentTime;
        const active = cues.find((c) => absTime >= c.start && absTime < c.end);
        setSubText(active ? active.text : "");
      } else {
        setSubText("");
      }
    };
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

  // Auto-hide controls — use refs to avoid stale closures
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  const isMobileRef = useRef("ontouchend" in window);

  const scheduleHide = useCallback((delay?: number) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    const d = delay ?? (isMobileRef.current ? 3000 : 500);
    hideTimerRef.current = setTimeout(() => {
      if (!videoRef.current?.paused && !settingsOpenRef.current) {
        setControlsVisible(false);
      }
    }, d);
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    scheduleHide();
  }, [scheduleHide]);

  // Keep controls visible while paused or settings open
  useEffect(() => {
    if (paused || settingsOpen) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    } else {
      scheduleHide();
    }
  }, [paused, settingsOpen, scheduleHide]);

  const handleMouseMove = useCallback(() => {
    if ("ontouchend" in window) return; // Ignore phantom mouse events on touch devices
    showControls();
  }, [showControls]);

  const handleMouseLeave = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (!videoRef.current?.paused && !settingsOpenRef.current) {
      setControlsVisible(false);
    }
  }, []);

  // Click handler: mobile toggles overlay, desktop toggles play/pause
  const handleVideoClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Ignore clicks on interactive controls (buttons, inputs, seek bar, settings)
    if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("[data-controls-inner]")) return;
    if ("ontouchend" in window) {
      // Mobile: tap to toggle overlay visibility (does NOT pause/play)
      const video = videoRef.current;
      if (!video) return;
      // When paused, overlay stays visible — don't allow dismissing
      if (video.paused) return;
      if (controlsVisible) {
        // Dismiss immediately
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        setControlsVisible(false);
      } else {
        setControlsVisible(true);
        scheduleHide(3000);
      }
    } else {
      // Desktop: click empty area to toggle play/pause
      togglePlayPause();
    }
  }, [scheduleHide, controlsVisible]);

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
        goToSibling(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goToSibling(1);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [totalDuration, goToSibling]);

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }

  // Seek by restarting stream at new position — show target immediately
  function seekTo(seconds: number) {
    const clamped = Math.max(0, Math.min(totalDuration, seconds));
    setSeekPreview(clamped);
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
      seekTo(targetTime);
      // Keep overlay visible after seeking, reschedule auto-hide
      setControlsVisible(true);
      scheduleHide();
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

  function currentPosition() {
    return seekOffsetRef.current + (videoRef.current?.currentTime ?? 0);
  }

  function handleProfileChange(newProfile: string) {
    setSeekTarget(currentPosition());
    setProfile(newProfile);
    setPrefs({ preferred_profile: newProfile });
  }

  function handleAudioChange(idx: number | null) {
    if (idx === null) return;
    setSeekTarget(currentPosition());
    setAudioIdx(idx);
    const track = info?.audio_tracks.find((t) => t.index === idx);
    if (track) setPrefs({ preferred_audio_lang: track.lang });
  }

  function handleSubChange(idx: number | null) {
    // Only restart stream if burn-in subtitle is changing (affects stream params)
    if (subMode === "burn" && profile !== "original") {
      setSeekTarget(currentPosition());
    }
    setSubIdx(idx);
    setPrefs({ subtitles_enabled: idx !== null });
    if (idx !== null) {
      const track = info?.subtitle_tracks.find((t) => t.index === idx);
      if (track) setPrefs({ preferred_subtitle_lang: track.lang });
    }
  }

  function handleSubModeChange(mode: "burn" | "external") {
    // Only restart stream if burnSubIdx actually changes
    const oldBurn = subMode === "burn" && profile !== "original" ? subIdx : null;
    const newBurn = mode === "burn" && profile !== "original" ? subIdx : null;
    if (oldBurn !== newBurn) {
      setSeekTarget(currentPosition());
    }
    setSubMode(mode);
    setPrefs({ subtitle_mode: mode });
  }

  const isMobile = "ontouchend" in window;

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
      />

      {/* External subtitle overlay — positioned just above the video bottom edge */}
      {subText && (
        <div
          className="absolute left-0 right-0 flex justify-center z-10 pointer-events-none px-8"
          style={{ bottom: `${videoBottom + 16}px` }}
        >
          <span
            className={`text-white ${subtitleSizeClass[prefs.subtitle_font_size]} font-bold whitespace-pre-line text-center`}
            style={{ textShadow: "-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 -2px 0 #000, 0 2px 0 #000, -2px 0 0 #000, 2px 0 0 #000" }}
            dangerouslySetInnerHTML={{ __html: subText.replace(/\n/g, "<br/>") }}
          />
        </div>
      )}

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
        <div className="bg-gradient-to-b from-black/70 to-transparent px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] flex items-center gap-3">
          <button
            onClick={goBack}
            className="text-gray-300 hover:text-white transition-colors shrink-0 cursor-pointer"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1" />
          <div className="text-sm text-gray-200 truncate max-w-[50%]">
            {filePath.split("/").pop()}
          </div>
          {siblings.length > 1 && siblingIndex >= 0 && (
            <div className="text-sm text-gray-400 tabular-nums whitespace-nowrap">
              {siblingIndex + 1} / {siblings.length}
            </div>
          )}
        </div>

        {/* Center area — prev / play-pause / next spread across, pointer-events pass through to video behind */}
        <div className="flex-1 flex items-center justify-between px-8 pointer-events-none">
          {/* Prev button */}
          {hasPrev ? (
            <button
              data-controls
              onClick={(e) => { e.stopPropagation(); goToSibling(-1); }}
              className="pointer-events-auto bg-black/40 rounded-full p-3 text-white hover:text-blue-400 transition-all cursor-pointer"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          ) : (
            <div className="w-14" />
          )}

          {/* Large centered play/pause button */}
          <button
            data-controls
            onClick={(e) => { e.stopPropagation(); const wasPaused = videoRef.current?.paused; togglePlayPause(); if (isMobile && wasPaused) setControlsVisible(false); }}
            className="pointer-events-auto bg-black/40 rounded-full p-4 text-white hover:text-blue-400 transition-all hover:scale-110 cursor-pointer"
          >
            {paused ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-12 h-12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            )}
          </button>

          {/* Next button */}
          {hasNext ? (
            <button
              data-controls
              onClick={(e) => { e.stopPropagation(); goToSibling(1); }}
              className="pointer-events-auto bg-black/40 rounded-full p-3 text-white hover:text-blue-400 transition-all cursor-pointer"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <div className="w-14" />
          )}
        </div>

        {/* Bottom controls area */}
        <div data-controls-inner className="bg-gradient-to-t from-black/70 to-transparent px-4 pb-4 pt-8">
          {/* Progress bar — outer div is an invisible expanded touch target */}
          <div
            className="group relative cursor-pointer mb-3 py-3 -my-3"
            onMouseDown={handleSeekMouseDown}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
              setHoverTime(frac * totalDuration);
              setHoverX(e.clientX - rect.left);
            }}
            onMouseLeave={() => setHoverTime(null)}
            onTouchStart={(e) => {
              if (!totalDuration) return;
              setIsSeeking(true);
              const bar = e.currentTarget;
              const rect = bar.getBoundingClientRect();
              const touch = e.touches[0];
              const frac = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
              setSeekPreview(frac * totalDuration);
            }}
            onTouchMove={(e) => {
              if (!isSeeking || !totalDuration) return;
              const bar = e.currentTarget;
              const rect = bar.getBoundingClientRect();
              const touch = e.touches[0];
              const frac = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
              setSeekPreview(frac * totalDuration);
            }}
            onTouchEnd={() => {
              if (!isSeeking) return;
              setIsSeeking(false);
              if (seekPreview !== null) seekTo(seekPreview);
              // After seeking, keep overlay visible and reschedule auto-hide
              setControlsVisible(true);
              scheduleHide(3000);
            }}
          >
            {/* Visible track */}
            <div className="relative h-1.5 bg-white/20 rounded-full group-hover:h-2.5 transition-all">
              {/* Hover time tooltip */}
              {hoverTime !== null && totalDuration > 0 && (
                <div
                  className="absolute -top-8 px-1.5 py-0.5 bg-black/80 rounded text-xs text-white tabular-nums pointer-events-none -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${hoverX}px` }}
                >
                  {formatTime(hoverTime)}
                </div>
              )}
              {/* Played portion */}
              <div
                className="absolute inset-y-0 left-0 bg-blue-500 rounded-full pointer-events-none"
                style={{ width: `${progressFraction * 100}%` }}
              />
              {/* Seek thumb — always visible, sized for touch */}
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-5 h-5 bg-blue-500 rounded-full shadow"
                style={{ left: `${progressFraction * 100}%` }}
              />
            </div>
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
                          {[...info.profiles]
                            .sort((a, b) => (a.name === "original" ? -1 : b.name === "original" ? 1 : 0))
                            .map((p) => (
                            <option key={p.name} value={p.name}>
                              {p.name === "original" ? "Original" : p.name}{p.video_bitrate ? ` (${p.video_bitrate})` : ""}
                            </option>
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
                      {info.subtitle_tracks.length > 0 && (
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
                      )}

                      {/* Subtitle mode */}
                      {subIdx !== null && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">Subtitle mode</label>
                          <select
                            value={subMode}
                            onChange={(e) => handleSubModeChange(e.target.value as "burn" | "external")}
                            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                          >
                            <option value="burn">Burn in</option>
                            <option value="external">External</option>
                          </select>
                        </div>
                      )}

                      {/* Subtitle size */}
                      {subIdx !== null && (
                        <div>
                          <label className="text-xs text-gray-400 mb-1 block">Subtitle size</label>
                          <select
                            value={prefs.subtitle_font_size}
                            onChange={(e) => setPrefs({ subtitle_font_size: e.target.value as SubtitleFontSize })}
                            className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                          >
                            <option value="small">Small</option>
                            <option value="medium">Medium</option>
                            <option value="large">Large</option>
                            <option value="extra-large">Extra Large</option>
                          </select>
                        </div>
                      )}
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
