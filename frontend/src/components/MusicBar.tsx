import { useRef, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMusicPlayer } from "../hooks/useMusicPlayer";
import { mediaUrl } from "../api";

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const SWIPE_THRESHOLD = 50; // px
const VELOCITY_THRESHOLD = 0.3; // px/ms

export default function MusicBar() {
  const {
    playlist,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    volume,
    isVisible,
    audioProfile,
    availableProfiles,
    pause,
    resume,
    next,
    prev,
    seekTo,
    setVolume,
    setAudioProfile,
    dismiss,
  } = useMusicPlayer();

  const [showQuality, setShowQuality] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const qualityRef = useRef<HTMLDivElement>(null);
  const mobileQualityRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const mobileProgressRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ startY: 0, startTime: 0, isDragging: false });

  const nav = useNavigate();
  const track = playlist[currentIndex] || null;

  // Close dropdowns on outside click/touch
  useEffect(() => {
    if (!showQuality && !showVolume) return;
    function handleClick(e: Event) {
      if (showQuality) {
        const inDesktop = qualityRef.current?.contains(e.target as Node);
        const inMobile = mobileQualityRef.current?.contains(e.target as Node);
        if (!inDesktop && !inMobile) setShowQuality(false);
      }
      if (showVolume && volumeRef.current && !volumeRef.current.contains(e.target as Node)) setShowVolume(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("touchstart", handleClick);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("touchstart", handleClick);
    };
  }, [showQuality, showVolume]);

  // Collapse when player is dismissed
  useEffect(() => {
    if (!isVisible) setIsExpanded(false);
  }, [isVisible]);

  // Close dropdowns when collapsing
  useEffect(() => {
    if (!isExpanded) {
      setShowQuality(false);
      setShowVolume(false);
    }
  }, [isExpanded]);

  // Track measured height of the expanded section
  const [expandedHeight, setExpandedHeight] = useState(0);

  // Measure expanded section after mount and on resize
  useEffect(() => {
    function measure() {
      const h = expandedRef.current?.offsetHeight || 0;
      setExpandedHeight(h);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [isVisible, track?.path]);

  // Touch gesture handling for swipe expand/collapse
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleTouchStart(e: TouchEvent) {
      if (window.innerWidth >= 768) return;
      const touch = e.touches[0];
      dragState.current = {
        startY: touch.clientY,
        startTime: Date.now(),
        isDragging: false,
      };
    }

    function handleTouchMove(e: TouchEvent) {
      if (window.innerWidth >= 768) return;
      const touch = e.touches[0];
      const deltaY = touch.clientY - dragState.current.startY;

      if (!dragState.current.isDragging && Math.abs(deltaY) < 10) return;

      const target = e.target as HTMLElement;
      if (target.closest('[data-progress-bar]') || target.tagName === 'INPUT') return;

      dragState.current.isDragging = true;
      setIsDragging(true);

      let offset: number;
      if (isExpanded) {
        offset = Math.max(0, Math.min(expandedHeight, deltaY));
      } else {
        offset = Math.max(0, Math.min(expandedHeight, expandedHeight + deltaY));
      }

      container!.style.transform = `translateY(${offset}px)`;
    }

    function handleTouchEnd() {
      if (window.innerWidth >= 768) return;
      if (!dragState.current.isDragging) return;

      const elapsed = Date.now() - dragState.current.startTime;
      const currentOffset = (parseFloat(container!.style.transform.replace(/[^-\d.]/g, '')) || 0);
      const velocity = Math.abs(currentOffset - (isExpanded ? 0 : expandedHeight)) / Math.max(1, elapsed);

      setIsDragging(false);

      if (isExpanded) {
        if (currentOffset > SWIPE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
          setIsExpanded(false);
        }
      } else {
        if ((expandedHeight - currentOffset) > SWIPE_THRESHOLD || velocity > VELOCITY_THRESHOLD) {
          setIsExpanded(true);
        }
      }

      dragState.current.isDragging = false;
    }

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
    };
  }, [isExpanded, expandedHeight]);

  if (!isVisible || !track) return null;

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  function handleDesktopProgressClick(e: React.MouseEvent) {
    const bar = progressRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * duration);
  }

  function handleMobileProgressClick(e: React.MouseEvent) {
    const bar = mobileProgressRef.current;
    if (!bar || !duration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * duration);
  }

  function handleProgressTouch(e: React.TouchEvent) {
    const bar = mobileProgressRef.current;
    if (!bar || !duration) return;
    const touch = e.touches[0];
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    seekTo(ratio * duration);
  }

  const coverUrl = track.coverArt ? mediaUrl(track.coverArt) : null;

  const albumArt = (
    <div className="w-12 h-12 bg-gray-800 rounded flex-shrink-0 overflow-hidden flex items-center justify-center">
      {coverUrl ? (
        <img src={coverUrl} alt="" className="w-full h-full object-cover" />
      ) : (
        <svg className="w-6 h-6 text-gray-500" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
        </svg>
      )}
    </div>
  );

  const trackInfo = (
    <button
      onClick={() => {
        const dir = track.path.substring(0, track.path.lastIndexOf("/")) || "/";
        nav(`/?path=${encodeURIComponent(dir)}`);
      }}
      className="min-w-0 flex-1 md:w-40 md:flex-initial md:flex-shrink-0 text-left cursor-pointer hover:opacity-80 transition-opacity"
      title="Go to album"
    >
      <div className="text-sm text-white truncate">{track.name}</div>
      {track.albumName && (
        <div className="text-xs text-gray-400 truncate">{track.albumName}</div>
      )}
    </button>
  );

  const transportControls = (
    <div className="flex items-center gap-2 flex-shrink-0">
      <button onClick={prev} className="text-gray-400 hover:text-white transition-colors cursor-pointer p-1" title="Previous">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
        </svg>
      </button>
      <button
        onClick={isPlaying ? pause : resume}
        className="text-white hover:text-blue-400 transition-colors cursor-pointer p-1"
        title={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? (
          <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        ) : (
          <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
      <button onClick={next} className="text-gray-400 hover:text-white transition-colors cursor-pointer p-1" title="Next">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
        </svg>
      </button>
    </div>
  );

  const progressBar = (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <span className="text-xs text-gray-400 w-10 text-right flex-shrink-0">{formatTime(currentTime)}</span>
      <div
        ref={progressRef}
        className="flex-1 h-1.5 bg-gray-700 rounded-full cursor-pointer group relative overflow-hidden"
        onClick={handleDesktopProgressClick}
      >
        <div
          className="h-full bg-blue-500 rounded-full relative"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
      <span className="text-xs text-gray-400 w-10 flex-shrink-0">{formatTime(duration)}</span>
    </div>
  );

  const qualityDropdown = showQuality && (
    <div className="absolute bottom-full mb-2 right-0 bg-gray-900 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[120px]">
      {availableProfiles.map((p) => (
        <button
          key={p.name}
          onClick={() => { setAudioProfile(p.name); setShowQuality(false); }}
          className={`w-full text-left px-3 py-1.5 text-sm cursor-pointer transition-colors ${
            audioProfile === p.name ? "text-blue-400 bg-gray-800" : "text-gray-300 hover:bg-gray-800 hover:text-white"
          }`}
        >
          {p.name}
        </button>
      ))}
    </div>
  );

  const qualityButton = (
    <button
      onClick={() => { setShowQuality((v) => !v); setShowVolume(false); }}
      className="text-xs text-gray-400 hover:text-white transition-colors cursor-pointer px-2 py-1 border border-gray-700 rounded"
      title="Audio quality"
    >
      {audioProfile}
    </button>
  );

  const volumeButton = (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      {volume === 0 ? (
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
      ) : volume < 0.5 ? (
        <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
      ) : (
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
      )}
    </svg>
  );

  const dismissButton = (
    <button
      onClick={dismiss}
      className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1 flex-shrink-0"
      title="Dismiss"
    >
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
      </svg>
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={`fixed bottom-0 left-0 right-0 bg-gray-950/95 backdrop-blur border-t border-gray-800 z-50 ${
        isDragging ? "" : "transition-transform duration-300 ease-out"
      } md:!transform-none md:h-16`}
      style={window.innerWidth < 768 && !isDragging ? { transform: `translateY(${isExpanded ? 0 : expandedHeight}px)` } : undefined}
    >
      {/* Drag handle — mobile only */}
      <div
        className="md:hidden flex justify-center pt-1.5 pb-0.5 cursor-grab active:cursor-grabbing"
        style={{ touchAction: "none" }}
        onClick={() => setIsExpanded((v) => !v)}
      >
        <div className={`w-8 h-1 rounded-full transition-colors ${isExpanded ? "bg-gray-400" : "bg-gray-600"}`} />
      </div>

      {/* Collapsed row — always visible */}
      <div className="h-16 flex items-center px-4 gap-3">
        {albumArt}
        {trackInfo}
        {transportControls}

        {/* Desktop-only inline elements */}
        <div className="hidden md:flex items-center gap-3 flex-1 min-w-0">
          {progressBar}
          <div ref={qualityRef} className="relative flex-shrink-0">
            {qualityButton}
            {qualityDropdown}
          </div>

          {/* Desktop volume dropdown */}
          <div ref={volumeRef} className="relative flex-shrink-0">
            <button
              onClick={() => { setShowVolume((v) => !v); setShowQuality(false); }}
              className="text-gray-400 hover:text-white transition-colors cursor-pointer p-1"
              title="Volume"
            >
              {volumeButton}
            </button>
            {showVolume && (
              <div className="absolute bottom-full mb-2 right-0 bg-gray-900 border border-gray-700 rounded-lg shadow-lg p-3 w-10 h-32 flex flex-col items-center overflow-hidden">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-full h-full accent-blue-500 cursor-pointer"
                  style={{ writingMode: "vertical-lr", direction: "rtl" }}
                />
              </div>
            )}
          </div>

          {dismissButton}
        </div>
      </div>

      {/* Expanded section — mobile only */}
      <div ref={expandedRef} className="md:hidden px-4 pb-3 space-y-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
        {/* Full-width progress bar */}
        <div className="flex items-center gap-2" data-progress-bar>
          <span className="text-xs text-gray-400 w-10 text-right flex-shrink-0">{formatTime(currentTime)}</span>
          <div
            ref={mobileProgressRef}
            className="flex-1 h-2 bg-gray-700 rounded-full cursor-pointer group relative overflow-hidden"
            style={{ touchAction: "none" }}
            onClick={handleMobileProgressClick}
            onTouchStart={handleProgressTouch}
            onTouchMove={handleProgressTouch}
          >
            <div
              className="h-full bg-blue-500 rounded-full relative"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute right-0 top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow" />
            </div>
          </div>
          <span className="text-xs text-gray-400 w-10 flex-shrink-0">{formatTime(duration)}</span>
        </div>

        {/* Controls row: quality + volume + dismiss */}
        <div className="flex items-center gap-3">
          <div ref={mobileQualityRef} className="relative flex-shrink-0">
            {qualityButton}
            {qualityDropdown}
          </div>

          {/* Mobile horizontal volume */}
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <button
              onClick={() => setVolume(volume === 0 ? 1 : 0)}
              className="text-gray-400 hover:text-white transition-colors cursor-pointer p-1 flex-shrink-0"
              title="Volume"
            >
              {volumeButton}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="flex-1 h-1.5 accent-blue-500 cursor-pointer"
              style={{ touchAction: "none" }}
            />
          </div>

          {dismissButton}
        </div>
      </div>
    </div>
  );
}
