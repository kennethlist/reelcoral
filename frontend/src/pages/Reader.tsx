import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  browse,
  BrowseEntry,
  getEbookInfo,
  getEbookChapter,
  EbookInfo,
  getComicInfo,
  comicPageUrl,
  getPdfInfo,
  pdfPageUrl,
  downloadUrl,
  getMarkdownContent,
  getConfig,
} from "../api";

function isTouchDevice() {
  return "ontouchstart" in window || navigator.maxTouchPoints > 0;
}

type FileFormat = "epub" | "pdf" | "cbr" | "cbz" | "md";

function detectFormat(path: string): FileFormat {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  if (ext === "epub") return "epub";
  if (ext === "pdf") return "pdf";
  if (ext === "cbr") return "cbr";
  if (ext === "cbz") return "cbz";
  if (ext === "md") return "md";
  return "pdf";
}

// --- Reading Position Persistence ---
const POSITION_KEY = "rc-read-position";

interface ReadPosition {
  chapter?: number;
  page?: number;
  progress?: number;
  scrollY?: number;
}

function savePosition(path: string, pos: ReadPosition) {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[path] = pos;
    localStorage.setItem(POSITION_KEY, JSON.stringify(map));
  } catch {}
}

function getPosition(path: string): ReadPosition | null {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[path] || null;
  } catch {
    return null;
  }
}

// --- Reader Settings Persistence ---
const SETTINGS_KEY = "rc-reader-settings";

interface ReaderSettings {
  // EPUB
  epubMargin: "small" | "medium" | "large";
  epubFontSize: number;
  epubBg: "dark" | "light" | "amber";
  epubFontFamily: string;
  epubFontWeight: number;
  epubLineHeight: number;
  showEpubPages: boolean;
  // PDF
  pdfFit: "width" | "height" | "page";
  // All
  navMode: "page" | "scroll";
}

const defaultSettings: ReaderSettings = {
  epubMargin: "medium",
  epubFontSize: 18,
  epubBg: "dark",
  epubFontFamily: "Ubuntu",
  epubFontWeight: 400,
  epubLineHeight: 1.7,
  showEpubPages: true,
  pdfFit: "width",
  navMode: "page",
};

function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultSettings };
}

function persistSettings(s: ReaderSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

// --- EPUB Reader Sub-component ---
function EpubReader({
  path,
  settings,
  onPageInfo,
  controlsVisible,
}: {
  path: string;
  settings: ReaderSettings;
  onPageInfo: (current: number, total: number) => void;
  controlsVisible: boolean;
}) {
  const [info, setInfo] = useState<EbookInfo | null>(null);
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Pagination state (page-flip mode)
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [contentWidth, setContentWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  // Track reading progress as a fraction (0..1) so resizes keep the same position
  const progressRef = useRef(0);
  // Don't save position until the book is fully loaded and position is restored
  const positionRestoredRef = useRef(false);

  // Load all chapters, then display
  useEffect(() => {
    let cancelled = false;

    // Reset state for new book
    setCurrentPage(0);
    setTotalPages(1);
    progressRef.current = 0;
    positionRestoredRef.current = false;
    setLoading(true);
    setLoadProgress("Loading book info...");

    getEbookInfo(path).then(async (data) => {
      if (cancelled) return;
      setInfo(data);

      const saved = getPosition(path);
      const count = data.chapter_count;
      const parts: string[] = new Array(count);
      const BATCH = 5;
      for (let start = 0; start < count; start += BATCH) {
        if (cancelled) return;
        const end = Math.min(start + BATCH, count);
        setLoadProgress(`Loading chapters ${start + 1}–${end} / ${count}...`);
        const batch = await Promise.all(
          Array.from({ length: end - start }, (_, j) => getEbookChapter(path, start + j))
        );
        if (cancelled) return;
        for (let j = 0; j < batch.length; j++) parts[start + j] = batch[j].html;
      }

      const fullHtml = parts.join('<hr class="epub-chapter-break" />');
      setHtml(fullHtml);
      setLoading(false);

      // Restore saved position after full content is rendered
      if (settings.navMode === "scroll" && saved?.scrollY) {
        requestAnimationFrame(() => {
          contentRef.current?.scrollTo({ top: saved.scrollY });
        });
      } else if (settings.navMode === "page" && saved?.progress != null) {
        progressRef.current = saved.progress;
      }
      positionRestoredRef.current = true;
    });

    return () => { cancelled = true; };
  }, [path]);

  // Clipping wrapper ref — used to measure the single-page width and height.
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Phase 1: measure the clipping wrapper's dimensions.
  const measureSize = useCallback(() => {
    if (settings.navMode !== "page" || !wrapperRef.current) return;
    const colW = wrapperRef.current.clientWidth;
    const colH = wrapperRef.current.clientHeight;
    if (colW > 0) setContentWidth(colW);
    if (colH > 0) setContentHeight(colH);
  }, [settings.navMode]);

  // Phase 2: count pages from the inner div's actual scrollWidth.
  // CSS multi-column with fixed height creates overflow columns horizontally.
  // scrollWidth includes all overflow columns, so pages = scrollWidth / pageWidth.
  // Uses progressRef to maintain reading position proportionally across resizes.
  const countPages = useCallback(() => {
    if (settings.navMode !== "page" || !innerRef.current || !wrapperRef.current) return;
    const pageWidth = wrapperRef.current.clientWidth;
    if (pageWidth <= 0) return;
    const scrollW = innerRef.current.scrollWidth;
    if (scrollW <= 0) return;
    const pages = Math.max(1, Math.round(scrollW / pageWidth));
    setTotalPages(pages);
    // Restore position from progress fraction
    const newPage = Math.min(Math.round(progressRef.current * (pages - 1)), pages - 1);
    setCurrentPage(newPage);
  }, [settings.navMode]);

  // Re-measure width when html, font settings, or navMode change
  useEffect(() => {
    if (loading || settings.navMode !== "page") return;
    const t = setTimeout(measureSize, 50);
    return () => clearTimeout(t);
  }, [html, loading, settings.epubFontSize, settings.epubMargin, settings.epubFontFamily, settings.epubFontWeight, settings.epubLineHeight, settings.navMode, measureSize]);

  // Recount pages after contentWidth/contentHeight changes or content changes.
  // Use rAF so the browser has applied the column CSS before we measure.
  useEffect(() => {
    if (loading || settings.navMode !== "page" || contentWidth <= 0) return;
    const id = requestAnimationFrame(() => countPages());
    return () => cancelAnimationFrame(id);
  }, [contentWidth, contentHeight, html, loading, settings.navMode, settings.epubFontSize, settings.epubMargin, settings.epubFontFamily, settings.epubFontWeight, settings.epubLineHeight, countPages]);

  // Window resize listener — recalculate page dimensions on any resize (debounced)
  useEffect(() => {
    if (settings.navMode !== "page") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => measureSize(), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, [settings.navMode, measureSize]);

  // Recount pages when embedded images finish loading (they affect column layout).
  // Debounced: many images loading in quick succession only trigger one recount.
  const imgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (settings.navMode !== "page" || !innerRef.current || !html) return;
    const imgs = innerRef.current.querySelectorAll("img");
    if (imgs.length === 0) return;
    const onLoad = () => {
      if (imgTimerRef.current) clearTimeout(imgTimerRef.current);
      imgTimerRef.current = setTimeout(() => countPages(), 200);
    };
    imgs.forEach((img) => img.addEventListener("load", onLoad));
    return () => {
      imgs.forEach((img) => img.removeEventListener("load", onLoad));
      if (imgTimerRef.current) clearTimeout(imgTimerRef.current);
    };
  }, [html, settings.navMode, countPages]);

  // Apply page transform directly on the DOM element (avoids React re-rendering the
  // massive dangerouslySetInnerHTML content on every page flip).
  useEffect(() => {
    if (settings.navMode !== "page" || !innerRef.current || contentWidth <= 0) return;
    innerRef.current.style.transform = `translate3d(-${currentPage * contentWidth}px, 0, 0)`;
  }, [currentPage, contentWidth, settings.navMode]);

  // Update page info for parent and save position (debounced to avoid
  // re-rendering the entire component tree on every rapid page flip).
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!info || settings.navMode !== "page") return;
    onPageInfo(currentPage + 1, totalPages);
    // Update progress ref immediately (used for resize repositioning)
    progressRef.current = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    // Debounce the localStorage write
    if (positionRestoredRef.current) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const progress = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
        const chapter = info ? Math.max(0, Math.min(Math.floor(progress * info.chapter_count), info.chapter_count - 1)) : 0;
        savePosition(path, { page: currentPage, progress, chapter });
      }, 300);
    }
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [currentPage, totalPages, settings.navMode, info]);

  // Save scroll position on scroll (scroll mode only)
  const handleScroll = useCallback(() => {
    if (settings.navMode !== "scroll") return;
    const y = contentRef.current?.scrollTop || 0;
    savePosition(path, { scrollY: y });
  }, [path, settings.navMode]);

  // Page-flip navigation
  const goPage = useCallback(
    (delta: number) => {
      if (settings.navMode === "scroll") return;
      const nextPage = currentPage + delta;
      if (nextPage >= 0 && nextPage < totalPages) {
        setCurrentPage(nextPage);
        progressRef.current = totalPages > 1 ? nextPage / (totalPages - 1) : 0;
      }
    },
    [currentPage, totalPages, settings.navMode]
  );

  // Go to absolute page (0-indexed)
  const goToPage = useCallback(
    (page: number) => {
      if (settings.navMode === "scroll") return;
      const clamped = Math.max(0, Math.min(page, totalPages - 1));
      setCurrentPage(clamped);
      progressRef.current = totalPages > 1 ? clamped / (totalPages - 1) : 0;
    },
    [totalPages, settings.navMode]
  );

  // Expose navigation for parent
  useEffect(() => {
    (window as any).__readerNav = goPage;
    (window as any).__readerGoToPage = goToPage;
    return () => {
      delete (window as any).__readerNav;
      delete (window as any).__readerGoToPage;
    };
  }, [goPage, goToPage]);

  const marginMap = { small: "1rem", medium: "2rem", large: "4rem" };
  const bgMap = {
    dark: { bg: "#1a1a2e", color: "#e0e0e0" },
    light: { bg: "#fafafa", color: "#222" },
    amber: { bg: "#f5e6c8", color: "#3d2c14" },
  };
  const bgStyle = bgMap[settings.epubBg];

  // Memoize the heavy content so page-flip state changes (currentPage) don't
  // cause React to re-evaluate or re-apply styles on the massive HTML content.
  // Only re-render when layout-affecting values actually change.
  const isPageFlip = settings.navMode === "page";
  const memoizedContent = useMemo(() => {
    if (isPageFlip) {
      return (
        <div ref={wrapperRef} style={{ overflow: "hidden", height: "100%", ["--epub-page-height" as string]: contentHeight > 0 ? `${contentHeight}px` : "100%" }}>
          <div
            ref={innerRef}
            className="epub-content"
            style={{
              height: "100%",
              columnWidth: `${contentWidth || 9999}px`,
              columnGap: 0,
              columnFill: "auto" as const,
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      );
    }
    return (
      <div
        ref={innerRef}
        className="epub-content max-w-3xl mx-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }, [html, isPageFlip, contentWidth, contentHeight]);

  const containerStyle = useMemo(() => ({
    backgroundColor: bgStyle.bg,
    color: bgStyle.color,
    padding: `2rem ${marginMap[settings.epubMargin]} 1rem`,
    fontSize: `${settings.epubFontSize}px`,
    fontFamily: settings.epubFontFamily,
    fontWeight: settings.epubFontWeight,
    lineHeight: settings.epubLineHeight,
    ...(isPageFlip ? { maxWidth: "56rem", margin: "0 auto", width: "100%" } : {}),
  }), [bgStyle, settings.epubMargin, settings.epubFontSize, settings.epubFontFamily, settings.epubFontWeight, settings.epubLineHeight, isPageFlip]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-2">
        <div>{loadProgress}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      {/* Content */}
      <div
        ref={contentRef}
        className={`flex-1 ${isPageFlip ? "overflow-hidden" : "overflow-y-auto"}`}
        style={containerStyle}
        onScroll={handleScroll}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) e.preventDefault();
        }}
      >
        {memoizedContent}
      </div>
    </div>
  );
}

// --- Image Page Reader (PDF, CBR, CBZ) ---
function ImagePageReader({
  path,
  format,
  settings,
  onPageInfo,
  controlsVisible,
}: {
  path: string;
  format: "pdf" | "cbr" | "cbz";
  settings: ReaderSettings;
  onPageInfo: (current: number, total: number) => void;
  controlsVisible: boolean;
}) {
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 1200, height: 800 });

  // Measure container (use viewport height for fit-height so it behaves like viewing an image)
  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: window.innerHeight,
        });
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Load info
  useEffect(() => {
    setLoading(true);
    const fetchInfo = format === "pdf" ? getPdfInfo(path) : getComicInfo(path);
    fetchInfo.then((data) => {
      setPageCount(data.page_count);
      const saved = getPosition(path);
      const startPage = saved?.page != null && saved.page < data.page_count ? saved.page : 0;
      setCurrentPage(startPage);
      onPageInfo(startPage + 1, data.page_count);
      setLoading(false);
    });
  }, [path, format]);

  // Update page info when page changes
  useEffect(() => {
    if (pageCount > 0) {
      onPageInfo(currentPage + 1, pageCount);
      savePosition(path, { page: currentPage });
    }
  }, [currentPage, pageCount]);

  const goPage = useCallback(
    (delta: number) => {
      setCurrentPage((p) => {
        const next = p + delta;
        if (next >= 0 && next < pageCount) return next;
        return p;
      });
    },
    [pageCount]
  );

  // Go to absolute page (0-indexed)
  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(0, Math.min(page, pageCount - 1));
      setCurrentPage(clamped);
    },
    [pageCount]
  );

  // Expose nav for parent
  useEffect(() => {
    (window as any).__readerNav = goPage;
    (window as any).__readerGoToPage = goToPage;
    return () => {
      delete (window as any).__readerNav;
      delete (window as any).__readerGoToPage;
    };
  }, [goPage, goToPage]);

  const imageUrl = useMemo(() => {
    if (format === "pdf") {
      const dpr = window.devicePixelRatio || 1;
      return pdfPageUrl(path, currentPage, settings.pdfFit, Math.round(containerSize.width * dpr), Math.round(containerSize.height * dpr));
    }
    return comicPageUrl(path, currentPage);
  }, [path, currentPage, format, settings.pdfFit, containerSize]);

  // Preload next page
  useEffect(() => {
    if (currentPage < pageCount - 1) {
      const img = new Image();
      if (format === "pdf") {
        const dpr = window.devicePixelRatio || 1;
        img.src = pdfPageUrl(path, currentPage + 1, settings.pdfFit, Math.round(containerSize.width * dpr), Math.round(containerSize.height * dpr));
      } else {
        img.src = comicPageUrl(path, currentPage + 1);
      }
    }
  }, [currentPage, pageCount, path, format, settings.pdfFit, containerSize]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  if (settings.navMode === "scroll") {
    return (
      <div ref={containerRef} className="flex-1 overflow-y-auto bg-gray-950">
        <div className="flex flex-col items-center gap-1">
          {Array.from({ length: pageCount }, (_, i) => (
            <img
              key={i}
              src={
                format === "pdf"
                  ? pdfPageUrl(path, i, settings.pdfFit, Math.round(containerSize.width * (window.devicePixelRatio || 1)), Math.round(containerSize.height * (window.devicePixelRatio || 1)))
                  : comicPageUrl(path, i)
              }
              alt={`Page ${i + 1}`}
              className="max-w-full"
              loading="lazy"
              style={
                settings.pdfFit === "width"
                  ? { width: "100%" }
                  : settings.pdfFit === "page"
                  ? { maxHeight: containerSize.height, objectFit: "contain" }
                  : {}
              }
            />
          ))}
        </div>
      </div>
    );
  }

  // For fit-width: allow vertical scroll since the page may be taller than viewport
  // For fit-height/fit-page: contain within viewport
  const needsScroll = settings.pdfFit === "width";

  return (
    <div
      ref={containerRef}
      className={`flex-1 bg-gray-950 ${needsScroll ? "overflow-y-auto overflow-x-hidden" : "flex items-center justify-center overflow-hidden"}`}
    >
      <img
        src={imageUrl}
        alt={`Page ${currentPage + 1}`}
        className={needsScroll ? "w-full" : settings.pdfFit === "height" ? "h-full object-contain" : "max-w-full max-h-full object-contain"}
        draggable={false}
      />
    </div>
  );
}

// --- Markdown Reader Sub-component ---
function MarkdownReader({
  path,
  settings,
}: {
  path: string;
  settings: ReaderSettings;
}) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    getMarkdownContent(path).then((data) => {
      setHtml(data.html);
      setLoading(false);
      // Restore scroll position
      const saved = getPosition(path);
      if (saved?.scrollY) {
        requestAnimationFrame(() => {
          contentRef.current?.scrollTo({ top: saved.scrollY });
        });
      }
    });
  }, [path]);

  // Save scroll position
  const handleScroll = useCallback(() => {
    const y = contentRef.current?.scrollTop || 0;
    savePosition(path, { scrollY: y });
  }, [path]);

  // No page navigation needed for markdown
  useEffect(() => {
    (window as any).__readerNav = () => {};
    (window as any).__readerGoToPage = () => {};
    return () => {
      delete (window as any).__readerNav;
      delete (window as any).__readerGoToPage;
    };
  }, []);

  const marginMap = { small: "1rem", medium: "2rem", large: "4rem" };
  const bgMap = {
    dark: { bg: "#1a1a2e", color: "#e0e0e0" },
    light: { bg: "#fafafa", color: "#222" },
    amber: { bg: "#f5e6c8", color: "#3d2c14" },
  };
  const bgStyle = bgMap[settings.epubBg];

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div
        ref={contentRef}
        className="flex-1 overflow-y-auto"
        style={{
          backgroundColor: bgStyle.bg,
          color: bgStyle.color,
          padding: `2rem ${marginMap[settings.epubMargin]} 1rem`,
          fontSize: `${settings.epubFontSize}px`,
          fontFamily: settings.epubFontFamily,
          fontWeight: settings.epubFontWeight,
          lineHeight: settings.epubLineHeight,
        }}
        onScroll={handleScroll}
      >
        <div
          className="markdown-content max-w-3xl mx-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

// --- Settings Panel ---
function SettingsPanel({
  format,
  settings,
  onChange,
  onClose,
}: {
  format: FileFormat;
  settings: ReaderSettings;
  onChange: (s: ReaderSettings) => void;
  onClose: () => void;
}) {
  const update = (partial: Partial<ReaderSettings>) => {
    const next = { ...settings, ...partial };
    onChange(next);
    persistSettings(next);
  };

  return (
    <div
      data-controls
      className="absolute top-12 right-0 z-30 w-full sm:max-w-sm bg-gray-900 border border-gray-700 sm:rounded-l-xl sm:rounded-br-xl shadow-2xl"
    >
      <div className="p-4 flex items-center justify-between border-b border-gray-800">
        <span className="text-sm font-medium text-white">Reader Settings</span>
        <button onClick={onClose} className="text-gray-400 hover:text-white cursor-pointer">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {/* Navigation mode — all formats except markdown (always scroll) */}
        {format !== "md" && (
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Navigation</label>
          <div className="flex gap-2">
            {(["page", "scroll"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => update({ navMode: mode })}
                className={`px-3 py-1.5 rounded text-sm cursor-pointer ${
                  settings.navMode === mode ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                }`}
              >
                {mode === "page" ? "Page Flip" : "Scroll"}
              </button>
            ))}
          </div>
        </div>
        )}

        {/* EPUB / Markdown settings */}
        {(format === "epub" || format === "md") && (
          <>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Font Size: {settings.epubFontSize}px</label>
              <input
                type="range"
                min={12}
                max={32}
                value={settings.epubFontSize}
                onChange={(e) => update({ epubFontSize: Number(e.target.value) })}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Font Family</label>
              <select
                value={settings.epubFontFamily}
                onChange={(e) => update({ epubFontFamily: e.target.value })}
                className="w-full px-3 py-1.5 rounded text-sm bg-gray-800 text-gray-200 border border-gray-700 cursor-pointer"
                style={{ fontFamily: settings.epubFontFamily }}
              >
                {[
                  "serif", "sans-serif", "monospace",
                  "Liberation Serif", "Liberation Sans",
                  "Ubuntu",
                  "Noto Serif", "Noto Sans",
                  "Roboto",
                  "DejaVu Serif", "DejaVu Sans",
                ].map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>{f === "serif" ? "Serif" : f === "sans-serif" ? "Sans-Serif" : f === "monospace" ? "Monospace" : f}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Font Weight: {settings.epubFontWeight}</label>
              <input
                type="range"
                min={100}
                max={900}
                step={100}
                value={settings.epubFontWeight}
                onChange={(e) => update({ epubFontWeight: Number(e.target.value) })}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Line Height: {settings.epubLineHeight.toFixed(1)}</label>
              <input
                type="range"
                min={1.0}
                max={3.0}
                step={0.1}
                value={settings.epubLineHeight}
                onChange={(e) => update({ epubLineHeight: Number(e.target.value) })}
                className="w-full"
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Margin</label>
              <div className="flex gap-2">
                {(["small", "medium", "large"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => update({ epubMargin: m })}
                    className={`px-3 py-1.5 rounded text-sm capitalize cursor-pointer ${
                      settings.epubMargin === m ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            {format === "epub" && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-400">Show page numbers</label>
              <button
                onClick={() => update({ showEpubPages: !settings.showEpubPages })}
                className={`w-10 h-5 rounded-full transition-colors cursor-pointer ${
                  settings.showEpubPages ? "bg-blue-600" : "bg-gray-700"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform mx-0.5 ${
                    settings.showEpubPages ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
            )}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Background</label>
              <div className="flex gap-2">
                {(
                  [
                    { key: "dark", label: "Dark", preview: "bg-[#1a1a2e] text-gray-200" },
                    { key: "light", label: "Light", preview: "bg-[#fafafa] text-gray-900" },
                    { key: "amber", label: "Amber", preview: "bg-[#f5e6c8] text-[#3d2c14]" },
                  ] as const
                ).map((bg) => (
                  <button
                    key={bg.key}
                    onClick={() => update({ epubBg: bg.key })}
                    className={`px-3 py-1.5 rounded text-sm cursor-pointer border-2 ${bg.preview} ${
                      settings.epubBg === bg.key ? "border-blue-500" : "border-transparent"
                    }`}
                  >
                    {bg.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* PDF / Comic fit settings */}
        {(format === "pdf" || format === "cbr" || format === "cbz") && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Fit Mode</label>
            <div className="flex gap-2">
              {(["width", "height", "page"] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => update({ pdfFit: f })}
                  className={`px-3 py-1.5 rounded text-sm capitalize cursor-pointer ${
                    settings.pdfFit === f ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                  }`}
                >
                  {f === "width" ? "Fit Width" : f === "height" ? "Fit Height" : "Fit Page"}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main Reader Component ---
export default function Reader() {
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const currentPath = searchParams.get("path") || "";
  const format = useMemo(() => detectFormat(currentPath), [currentPath]);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pageInputFocused, setPageInputFocused] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");
  const [isTouch] = useState(() => isTouchDevice());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressShowUntilRef = useRef(0); // timestamp to suppress showControls after click-toggle
  const containerRef = useRef<HTMLDivElement>(null);

  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);

  // Apply server defaults for book font settings (only if user hasn't saved a preference)
  useEffect(() => {
    getConfig().then((cfg) => {
      const saved = localStorage.getItem(SETTINGS_KEY);
      const parsed = saved ? JSON.parse(saved) : {};
      const updates: Partial<ReaderSettings> = {};
      if (!parsed.epubFontFamily && cfg.defaults.book_font) updates.epubFontFamily = cfg.defaults.book_font;
      if (!parsed.epubFontWeight && cfg.defaults.book_font_weight) updates.epubFontWeight = cfg.defaults.book_font_weight;
      if (!parsed.epubLineHeight && cfg.defaults.book_line_height) updates.epubLineHeight = cfg.defaults.book_line_height;
      if (Object.keys(updates).length > 0) {
        setSettings((prev) => ({ ...prev, ...updates }));
      }
    }).catch(() => {});
  }, []);

  const [pageInfo, setPageInfo] = useState({ current: 0, total: 0 });

  // Sibling files
  const [allFiles, setAllFiles] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const READER_EXTS = new Set([".epub", ".pdf", ".cbr", ".cbz", ".md"]);

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
    browse(parentDir, 1, 200, search, letter, sort, sortDir)
      .then((data) => {
        const files = data.entries.filter((e) => !e.is_dir);
        setAllFiles(files);
      })
      .finally(() => setLoading(false));
  }, []);

  const readerFiles = useMemo(
    () => allFiles.filter((e) => {
      const ext = "." + e.name.split(".").pop()?.toLowerCase();
      return READER_EXTS.has(ext);
    }),
    [allFiles]
  );

  const currentFileIndex = useMemo(
    () => allFiles.findIndex((e) => e.path === currentPath),
    [allFiles, currentPath]
  );

  const hasPrev = currentFileIndex > 0;
  const hasNext = currentFileIndex >= 0 && currentFileIndex < allFiles.length - 1;

  const goToSibling = useCallback(
    (delta: number) => {
      const nextIdx = currentFileIndex + delta;
      if (nextIdx < 0 || nextIdx >= allFiles.length) return;
      const next = allFiles[nextIdx];
      const ext = "." + next.name.split(".").pop()?.toLowerCase();
      if (READER_EXTS.has(ext)) {
        setSearchParams({ path: next.path }, { replace: true });
        window.location.reload();
      } else if (next.is_image) {
        nav(`/gallery?path=${encodeURIComponent(next.path)}`, { replace: true });
      } else if (next.is_audio) {
        nav(`/audio?path=${encodeURIComponent(next.path)}`, { replace: true });
      } else {
        nav(`/play?path=${encodeURIComponent(next.path)}`, { replace: true });
      }
    },
    [currentFileIndex, allFiles, nav, setSearchParams]
  );

  // Controls visibility
  const showControls = useCallback(() => {
    // Don't auto-show if a click-toggle just happened (prevents flicker)
    if (Date.now() < suppressShowUntilRef.current) return;
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (!settingsOpen && !pageInputFocused) setControlsVisible(false);
    }, 500);
  }, [settingsOpen, pageInputFocused]);

  useEffect(() => {
    if (isTouch) {
      setControlsVisible(true);
    } else {
      showControls();
    }
  }, [showControls, isTouch]);

  const handleMouseMove = useCallback(() => {
    if (!isTouch) showControls();
  }, [showControls, isTouch]);

  const handleMouseLeave = useCallback(() => {
    if (!isTouch && !settingsOpen && !pageInputFocused) {
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

  useEffect(() => {
    if (pageInputFocused) {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    }
  }, [pageInputFocused]);

  // Note: tap zones (transparent overlay divs) handle all tap/click navigation
  // and overlay toggling — see the JSX below. No manual touch/click handlers needed.

  // Keyboard
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (settingsOpen) {
          setSettingsOpen(false);
        } else {
          goBack();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (window as any).__readerNav?.(-1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        (window as any).__readerNav?.(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        (window as any).__readerNav?.(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        (window as any).__readerNav?.(1);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [controlsVisible, settingsOpen, goToSibling]);

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

  const filename = currentPath.split("/").pop() || "";

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 bg-gray-950 flex flex-col select-none ${!isTouch && !controlsVisible ? "cursor-none" : ""}`}
      style={{ touchAction: "manipulation" }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Top bar overlay */}
      <div
        data-controls
        className={`absolute top-0 left-0 right-0 z-20 px-5 py-5 pt-[max(1.25rem,calc(env(safe-area-inset-top)+0.5rem))] bg-gradient-to-b from-black/90 via-black/60 to-transparent transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        style={{ paddingBottom: "3rem" }}
      >
        <div className="flex items-center gap-4">
          <button onClick={goBack} className="text-gray-300 hover:text-white transition-colors shrink-0 cursor-pointer">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1" />
          <div className="text-sm text-gray-200 truncate max-w-[50%]">{filename}</div>
          {pageInfo.total > 0 && format !== "md" && (format !== "epub" || settings.showEpubPages) && (
            <div className="text-sm text-gray-200 tabular-nums whitespace-nowrap">
              {pageInfo.current} / {pageInfo.total}
            </div>
          )}

          {/* Download */}
          <a
            href={downloadUrl(currentPath)}
            className="text-white/80 hover:text-white transition-colors cursor-pointer"
            title="Download"
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
              <path strokeLinecap="round" d="M5 20h14" />
            </svg>
          </a>

          {/* Settings gear */}
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
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex flex-col pt-0 overflow-hidden">
        {format === "epub" && (
          <EpubReader
            path={currentPath}
            settings={settings}
            onPageInfo={(c, t) => setPageInfo({ current: c, total: t })}
            controlsVisible={controlsVisible}
          />
        )}
        {format === "md" && (
          <MarkdownReader
            path={currentPath}
            settings={settings}
          />
        )}
        {(format === "pdf" || format === "cbr" || format === "cbz") && (
          <ImagePageReader
            path={currentPath}
            format={format}
            settings={settings}
            onPageInfo={(c, t) => setPageInfo({ current: c, total: t })}
            controlsVisible={controlsVisible}
          />
        )}
      </div>

      {/* Invisible tap zones for navigation and overlay toggle */}
      {!settingsOpen && !pageInputFocused && (
        settings.navMode === "page" ? (
          <div className="absolute inset-0 z-10 flex">
            <div
              className="w-1/3 h-full"
              onClick={() => (window as any).__readerNav?.(-1)}
            />
            <div
              className="w-1/3 h-full"
              onClick={() => {
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                suppressShowUntilRef.current = Date.now() + 300;
                setControlsVisible((v) => !v);
              }}
            />
            <div
              className="w-1/3 h-full"
              onClick={() => (window as any).__readerNav?.(1)}
            />
          </div>
        ) : (
          /* Scroll mode: only a center overlay toggle that doesn't block scrolling */
          <div className="absolute inset-0 z-10 flex pointer-events-none">
            <div className="w-1/3 h-full" />
            <div
              className="w-1/3 h-full pointer-events-auto"
              onClick={() => {
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                suppressShowUntilRef.current = Date.now() + 300;
                setControlsVisible((v) => !v);
              }}
            />
            <div className="w-1/3 h-full" />
          </div>
        )
      )}

      {/* Bottom bar overlay — page-flip mode only, not for markdown */}
      {settings.navMode === "page" && format !== "md" && (
        <div
          data-controls
          className={`absolute bottom-0 left-0 right-0 z-20 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300 ${controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
          style={{ paddingTop: "2.5rem" }}
        >
          <div className="flex flex-col gap-2 max-w-lg mx-auto">
            {/* Slider */}
            {pageInfo.total > 1 && (format !== "epub" || settings.showEpubPages) && (
              <input
                type="range"
                min={1}
                max={pageInfo.total}
                value={pageInfo.current}
                onChange={(e) => (window as any).__readerGoToPage?.(Number(e.target.value) - 1)}
                className="w-full h-1.5 rounded-full appearance-none bg-white/20 cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-lg [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:shadow-lg"
              />
            )}
            {/* Prev / page input / Next */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => (window as any).__readerNav?.(-1)}
                onPointerDown={(e) => { if (e.pointerType === "touch") { e.preventDefault(); (window as any).__readerNav?.(-1); } }}
                className="text-white/80 hover:text-white p-2 cursor-pointer"
                title="Previous page"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              {pageInfo.total > 0 && (format !== "epub" || settings.showEpubPages) && (
                <span className="text-sm text-white/90 tabular-nums flex items-center gap-1">
                  <span>Page</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={pageInputFocused ? pageInputValue : String(pageInfo.current)}
                    onChange={(e) => setPageInputValue(e.target.value.replace(/[^0-9]/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      e.stopPropagation();
                    }}
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                    onFocus={(e) => {
                      setPageInputFocused(true);
                      setPageInputValue(String(pageInfo.current));
                      requestAnimationFrame(() => (e.target as HTMLInputElement).select());
                    }}
                    onBlur={() => {
                      const val = Number(pageInputValue);
                      if (val >= 1 && val <= pageInfo.total) {
                        (window as any).__readerGoToPage?.(val - 1);
                      }
                      setPageInputFocused(false);
                    }}
                    className="w-12 text-center bg-white/10 rounded px-1 py-0.5 text-sm text-white border border-white/20 focus:border-blue-500 focus:outline-none"
                  />
                  <span>/ {pageInfo.total}</span>
                </span>
              )}
              <button
                onClick={() => (window as any).__readerNav?.(1)}
                onPointerDown={(e) => { if (e.pointerType === "touch") { e.preventDefault(); (window as any).__readerNav?.(1); } }}
                className="text-white/80 hover:text-white p-2 cursor-pointer"
                title="Next page"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Side arrows for sibling navigation */}
      {hasPrev && controlsVisible && (
        <button
          data-controls
          onClick={() => goToSibling(-1)}
          className="absolute left-0 top-14 bottom-0 w-12 flex items-center justify-center transition-opacity duration-300 cursor-pointer opacity-60 hover:opacity-100"
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </div>
        </button>
      )}
      {hasNext && controlsVisible && (
        <button
          data-controls
          onClick={() => goToSibling(1)}
          className="absolute right-0 top-14 bottom-0 w-12 flex items-center justify-center transition-opacity duration-300 cursor-pointer opacity-60 hover:opacity-100"
        >
          <div className="bg-black/50 rounded-full p-2">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </div>
        </button>
      )}

      {/* Settings panel */}
      {settingsOpen && (
        <SettingsPanel
          format={format}
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* EPUB global styles */}
      <style>{`
        .epub-content img { max-width: 100%; height: auto; max-height: var(--epub-page-height, 80vh); object-fit: contain; break-inside: avoid; display: block; margin-left: auto; margin-right: auto; }
        .epub-content figure, .epub-content picture { max-width: 100%; break-inside: avoid; }
        .epub-content svg { max-width: 100%; max-height: var(--epub-page-height, 80vh); break-inside: avoid; }
        .epub-content h1, .epub-content h2, .epub-content h3 { margin: 1em 0 0.5em; }
        .epub-content p { margin: 0.5em 0; }
        .epub-content a { color: inherit; text-decoration: none; }
        .epub-content hr.epub-chapter-break { border: none; margin: 2em 0; break-before: column; }
        .markdown-content h1 { font-size: 2em; font-weight: bold; margin: 0.67em 0; border-bottom: 1px solid currentColor; padding-bottom: 0.3em; opacity: 0.9; }
        .markdown-content h2 { font-size: 1.5em; font-weight: bold; margin: 0.83em 0; border-bottom: 1px solid currentColor; padding-bottom: 0.2em; opacity: 0.8; }
        .markdown-content h3 { font-size: 1.25em; font-weight: bold; margin: 1em 0 0.5em; }
        .markdown-content h4 { font-size: 1.1em; font-weight: bold; margin: 1em 0 0.5em; }
        .markdown-content h5, .markdown-content h6 { font-size: 1em; font-weight: bold; margin: 1em 0 0.5em; }
        .markdown-content p { margin: 0.75em 0; }
        .markdown-content a { color: #60a5fa; text-decoration: underline; }
        .markdown-content code { background: rgba(128,128,128,0.2); padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
        .markdown-content pre { background: rgba(0,0,0,0.3); padding: 1em; border-radius: 8px; overflow-x: auto; margin: 1em 0; }
        .markdown-content pre code { background: none; padding: 0; font-size: 0.85em; }
        .markdown-content blockquote { border-left: 4px solid rgba(128,128,128,0.4); margin: 1em 0; padding: 0.5em 1em; opacity: 0.85; }
        .markdown-content ul, .markdown-content ol { margin: 0.75em 0; padding-left: 2em; }
        .markdown-content li { margin: 0.25em 0; }
        .markdown-content ul { list-style-type: disc; }
        .markdown-content ol { list-style-type: decimal; }
        .markdown-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        .markdown-content th, .markdown-content td { border: 1px solid rgba(128,128,128,0.3); padding: 0.5em 0.75em; text-align: left; }
        .markdown-content th { font-weight: bold; background: rgba(128,128,128,0.1); }
        .markdown-content hr { border: none; border-top: 1px solid rgba(128,128,128,0.3); margin: 2em 0; }
        .markdown-content img { max-width: 100%; height: auto; }
      `}</style>
    </div>
  );
}
