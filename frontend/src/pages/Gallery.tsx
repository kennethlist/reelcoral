import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { browse, BrowseEntry, setFileStatus, downloadUrl } from "../api";

function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

const SETTINGS_KEY = "rc-reader-settings";
type PageDirection = "normal" | "reverse" | "horseshoe";
type PageFit = "width" | "height" | "page";

function loadSetting<T>(key: string, valid: T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const val = JSON.parse(raw)[key];
      if ((valid as unknown[]).includes(val)) return val as T;
    }
  } catch {}
  return fallback;
}

function saveSetting(key: string, value: string) {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const settings = raw ? JSON.parse(raw) : {};
    settings[key] = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pageDirection, setPageDirection] = useState<PageDirection>(() => loadSetting("pageDirection", ["normal", "reverse", "horseshoe"], "normal"));
  const [pageFit, setPageFit] = useState<PageFit>(() => loadSetting("galleryFit", ["width", "height", "page"], "page"));
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const currentIndexRef = useRef(currentIndex);
  useEffect(() => { currentIndexRef.current = currentIndex; }, [currentIndex]);

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
    // Mark current image as viewed
    if (img) setFileStatus(img.path, "opened").catch(() => {});
    // Auto-complete when viewing the last image
    if (currentIndex === images.length - 1 && images.length > 0) {
      setFileStatus(images[currentIndex].path, "completed").catch(() => {});
    }
  }, [currentIndex, images]);

  const goTo = useCallback(
    (delta: number) => {
      // Navigate within all files (images + videos) in directory order
      const idx = currentIndexRef.current;
      const currentImage = images[idx];
      if (!currentImage) return;
      // Mark current file as viewed before navigating away
      setFileStatus(currentImage.path, "opened").catch(() => {});
      const allIdx = allFiles.findIndex((e) => e.path === currentImage.path);
      if (allIdx < 0) return;
      const nextAllIdx = allIdx + delta;
      if (nextAllIdx < 0 || nextAllIdx >= allFiles.length) return;
      const nextEntry = allFiles[nextAllIdx];
      if (nextEntry.is_image) {
        // Find index in images array
        const nextImgIdx = images.findIndex((e) => e.path === nextEntry.path);
        if (nextImgIdx >= 0) {
          currentIndexRef.current = nextImgIdx;
          setCurrentIndex(nextImgIdx);
        }
      } else if (nextEntry.is_audio) {
        nav(`/audio?path=${encodeURIComponent(nextEntry.path)}`, { replace: true });
      } else {
        // Navigate to video player
        nav(`/play?path=${encodeURIComponent(nextEntry.path)}`, { replace: true });
      }
    },
    [images, allFiles, nav]
  );

  // Desktop: auto-hide controls on mouse move
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!settingsOpen) setControlsVisible(false);
    }, 500);
  }, [settingsOpen]);

  // Show controls on mount
  useEffect(() => {
    if (isTouch) {
      // On mobile, start with controls hidden — tap center to show
      setControlsVisible(false);
    } else {
      showControls();
    }
  }, [showControls, isTouch]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (isTouch) return;
    const overControls = (e.target as HTMLElement).closest("[data-controls]");
    setControlsVisible(true);
    if (overControls) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    } else {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        if (!settingsOpen) setControlsVisible(false);
      }, 500);
    }
  }, [isTouch, settingsOpen]);

  const handleMouseLeave = useCallback(() => {
    if (!isTouch && !settingsOpen) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setControlsVisible(false);
    }
  }, [isTouch, settingsOpen]);

  // Keep controls visible while settings open
  useEffect(() => {
    if (settingsOpen) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [settingsOpen]);

  // Mobile: tap zones — direction-aware
  const handleTap = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isTouch) return;
      // Don't handle taps on the overlay controls themselves
      if ((e.target as HTMLElement).closest("[data-controls]")) return;

      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (pageDirection === "horseshoe") {
        // 3x3 grid: top row=next, middle(left=next, center=toggle, right=next), bottom(left=next, center=prev, right=next)
        const col = x < rect.width / 3 ? 0 : x > (rect.width * 2) / 3 ? 2 : 1;
        const row = y < rect.height * 0.3 ? 0 : y > rect.height * 0.7 ? 2 : 1;
        if (row === 1 && col === 1) {
          setControlsVisible((v) => !v);
        } else if (row === 2 && col === 1) {
          goTo(-1); // bottom center = prev
        } else {
          goTo(1); // everything else = next
        }
      } else {
        const third = rect.width / 3;
        const leftDelta = pageDirection === "reverse" ? 1 : -1;
        const rightDelta = pageDirection === "reverse" ? -1 : 1;
        if (x < third) {
          goTo(leftDelta);
        } else if (x > third * 2) {
          goTo(rightDelta);
        } else {
          setControlsVisible((v) => !v);
        }
      }
    },
    [isTouch, goTo, pageDirection]
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

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: Event) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [settingsOpen]);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { goTo(pageDirection === "reverse" ? 1 : -1); }
      else if (e.key === "ArrowRight") { goTo(pageDirection === "reverse" ? -1 : 1); }
      else if (e.key === "ArrowUp") { goTo(pageDirection === "horseshoe" ? 1 : -1); }
      else if (e.key === "ArrowDown") { goTo(pageDirection === "horseshoe" ? -1 : 1); }
      else if (e.key === "Escape") goBack();
      else if (e.key === "f") toggleFullscreen();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [goTo, nav, showControls, pageDirection]);

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
        className={`absolute top-0 left-0 right-0 z-20 px-5 py-5 pt-[max(1.25rem,calc(env(safe-area-inset-top)+1rem))] bg-gradient-to-b from-black/90 via-black/60 to-transparent transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        style={{ paddingBottom: "3rem" }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={goBack}
            className="text-gray-300 hover:text-white transition-colors shrink-0 cursor-pointer"
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
            <div className="text-sm text-gray-200 tabular-nums whitespace-nowrap">
              {allIdx + 1} / {allFiles.length}
            </div>
          )}
          {/* Download */}
          {currentImage && (
            <a
              href={downloadUrl(currentImage.path)}
              className="text-white/80 hover:text-white transition-colors cursor-pointer"
              title="Download"
              onClick={(e) => e.stopPropagation()}
            >
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                <path strokeLinecap="round" d="M5 20h14" />
              </svg>
            </a>
          )}
          {/* Settings gear */}
          <div className="relative shrink-0 flex items-center" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              className="text-white/80 hover:text-white transition-colors cursor-pointer"
              title="Settings"
            >
              <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            {settingsOpen && (
              <div
                data-controls
                className="absolute top-full mt-2 right-0 bg-gray-900 border border-gray-700 sm:rounded-l-xl sm:rounded-r-xl rounded-lg shadow-2xl p-4 w-64"
              >
                <label className="text-xs text-gray-400 mb-1 block">Page fit</label>
                <div className="flex gap-1 mb-3">
                  {(["width", "height", "page"] as const).map((fit) => (
                    <button
                      key={fit}
                      onClick={() => { setPageFit(fit); saveSetting("galleryFit", fit); }}
                      className={`flex-1 px-2 py-1 text-xs rounded cursor-pointer ${
                        pageFit === fit
                          ? "bg-blue-600 text-white"
                          : "bg-gray-700 text-gray-300"
                      }`}
                    >
                      {fit[0].toUpperCase() + fit.slice(1)}
                    </button>
                  ))}
                </div>
                <label className="text-xs text-gray-400 mb-1 block">Page direction</label>
                <div className="flex gap-1">
                  {(["normal", "reverse", "horseshoe"] as const).map((dir) => (
                    <button
                      key={dir}
                      onClick={() => { setPageDirection(dir); saveSetting("pageDirection", dir); }}
                      className={`flex-1 px-2 py-1 text-xs rounded cursor-pointer ${
                        pageDirection === dir
                          ? "bg-blue-600 text-white"
                          : "bg-gray-700 text-gray-300"
                      }`}
                    >
                      {dir[0].toUpperCase() + dir.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Image area */}
      {currentImage && (
        <div className={`absolute inset-0 flex ${pageFit === "width" ? "items-start overflow-y-auto" : "items-center"} justify-center`} style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <img
            src={`/api/image?path=${encodeURIComponent(currentImage.path)}`}
            alt={currentImage.name}
            className={pageFit === "width" ? "w-full h-auto" : pageFit === "height" ? "h-full w-auto" : "w-full h-full object-contain"}
            draggable={false}
          />
        </div>
      )}

      {/* Left arrow */}
      {hasPrev && (
        <button
          data-controls
          onClick={() => goTo(-1)}
          className={`absolute left-0 top-14 bottom-0 w-12 z-10 flex items-center justify-center transition-opacity duration-300 cursor-pointer ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </div>
        </button>
      )}

      {/* Right arrow */}
      {hasNext && (
        <button
          data-controls
          onClick={() => goTo(1)}
          className={`absolute right-0 top-14 bottom-0 w-12 z-10 flex items-center justify-center transition-opacity duration-300 cursor-pointer ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
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
