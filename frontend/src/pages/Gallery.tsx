import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { browse, BrowseEntry, setFileStatus } from "../api";

function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

export default function Gallery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const currentPath = searchParams.get("path") || "";

  const [allFiles, setAllFiles] = useState<BrowseEntry[]>([]);
  const [images, setImages] = useState<BrowseEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isTouch] = useState(() => isTouchDevice());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load all media files from the parent directory,
  // respecting any active filters from the browse page
  useEffect(() => {
    if (!currentPath) return;
    const parentDir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
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
    setLoading(true);
    browse(parentDir, 1, 0, search, letter, sort, sortDir)
      .then((data) => {
        const files = data.entries.filter((e) => !e.is_dir);
        setAllFiles(files);
        const imgs = files.filter((e) => e.is_image);
        setImages(imgs);
        const idx = imgs.findIndex((e) => e.path === currentPath);
        setCurrentIndex(idx >= 0 ? idx : 0);
      })
      .finally(() => setLoading(false));
  }, []);

  // Sync URL when currentIndex changes
  useEffect(() => {
    if (images.length === 0) return;
    const img = images[currentIndex];
    if (img && img.path !== currentPath) {
      setSearchParams({ path: img.path }, { replace: true });
    }
    // Auto-complete when viewing the last image
    if (currentIndex === images.length - 1 && images.length > 0) {
      setFileStatus(images[currentIndex].path, "completed").catch(() => {});
    }
  }, [currentIndex, images]);

  const goTo = useCallback(
    (delta: number) => {
      // Navigate within all files (images + videos) in directory order
      const currentImage = images[currentIndex];
      if (!currentImage) return;
      const allIdx = allFiles.findIndex((e) => e.path === currentImage.path);
      if (allIdx < 0) return;
      const nextAllIdx = allIdx + delta;
      if (nextAllIdx < 0 || nextAllIdx >= allFiles.length) return;
      const nextEntry = allFiles[nextAllIdx];
      if (nextEntry.is_image) {
        // Find index in images array
        const nextImgIdx = images.findIndex((e) => e.path === nextEntry.path);
        if (nextImgIdx >= 0) setCurrentIndex(nextImgIdx);
      } else if (nextEntry.is_audio) {
        nav(`/audio?path=${encodeURIComponent(nextEntry.path)}`, { replace: true });
      } else {
        // Navigate to video player
        nav(`/play?path=${encodeURIComponent(nextEntry.path)}`, { replace: true });
      }
    },
    [images, currentIndex, allFiles, nav]
  );

  // Desktop: auto-hide controls on mouse move
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 500);
  }, []);

  // Show controls on mount
  useEffect(() => {
    if (isTouch) {
      // On mobile, start with controls visible (no auto-hide)
      setControlsVisible(true);
    } else {
      showControls();
    }
  }, [showControls, isTouch]);

  const handleMouseMove = useCallback(() => {
    if (!isTouch) showControls();
  }, [showControls, isTouch]);

  const handleMouseLeave = useCallback(() => {
    if (!isTouch) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(false);
    }
  }, [isTouch]);

  // Mobile: tap zones — left third prev, right third next, middle toggles overlay
  const handleTap = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isTouch) return;
      // Don't handle taps on the overlay controls themselves
      if ((e.target as HTMLElement).closest("[data-controls]")) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const third = rect.width / 3;

      if (x < third) {
        goTo(-1);
      } else if (x > third * 2) {
        goTo(1);
      } else {
        setControlsVisible((v) => !v);
      }
    },
    [isTouch, goTo]
  );

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { goTo(-1); }
      else if (e.key === "ArrowRight") { goTo(1); }
      else if (e.key === "Escape") goBack();
      else if (e.key === "f") toggleFullscreen();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [goTo, nav, showControls]);

  const currentImage = images[currentIndex];
  // Determine prev/next based on position in allFiles (not just images)
  const allIdx = currentImage ? allFiles.findIndex((e) => e.path === currentImage.path) : -1;
  const hasPrev = allIdx > 0;
  const hasNext = allIdx >= 0 && allIdx < allFiles.length - 1;

  function goBack() {
    const parentDir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
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
    nav(`/?${params}`);
  }

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 bg-black flex flex-col select-none ${!isTouch && !controlsVisible ? "cursor-none" : ""}`}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleTap}
    >
      {/* Top bar */}
      <div
        data-controls
        className={`absolute top-0 left-0 right-0 z-10 px-5 py-5 pt-[max(1.25rem,calc(env(safe-area-inset-top)+1rem))] bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={goBack}
            className="text-white/80 hover:text-white transition-colors shrink-0 cursor-pointer"
          >
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1" />
          <div className="text-sm text-gray-200 truncate max-w-[50%]">
            {currentImage?.name}
          </div>
          {allFiles.length > 1 && allIdx >= 0 && (
            <div className="text-sm text-gray-400 tabular-nums whitespace-nowrap">
              {allIdx + 1} / {allFiles.length}
            </div>
          )}
        </div>
      </div>

      {/* Image area */}
      {currentImage && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <img
            src={`/api/image?path=${encodeURIComponent(currentImage.path)}`}
            alt={currentImage.name}
            className="w-full h-full object-contain"
            draggable={false}
          />
        </div>
      )}

      {/* Desktop-only left arrow */}
      {!isTouch && hasPrev && (
        <button
          onClick={() => goTo(-1)}
          className={`absolute left-0 top-14 bottom-0 w-16 flex items-center justify-center transition-opacity duration-300 cursor-pointer ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </div>
        </button>
      )}

      {/* Desktop-only right arrow */}
      {!isTouch && hasNext && (
        <button
          onClick={() => goTo(1)}
          className={`absolute right-0 top-14 bottom-0 w-16 flex items-center justify-center transition-opacity duration-300 cursor-pointer ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      )}

      {/* Fullscreen button (desktop only) */}
      {!isTouch && (
        <button
          data-controls
          onClick={toggleFullscreen}
          className={`absolute bottom-4 right-4 z-10 transition-opacity duration-300 cursor-pointer ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <div className="bg-black/50 rounded-full p-2">
            {isFullscreen ? (
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5M15 15l5.25 5.25" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9M20.25 20.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            )}
          </div>
        </button>
      )}
    </div>
  );
}
