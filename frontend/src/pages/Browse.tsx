import { useState, useEffect, useMemo, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { browse, logout, getConfig, BrowseResult } from "../api";
import VideoCard from "../components/VideoCard";
import Breadcrumbs from "../components/Breadcrumbs";
import SearchBar from "../components/SearchBar";
import Pagination from "../components/Pagination";
import ThumbnailPicker from "../components/ThumbnailPicker";

const DIR_STATE_KEY = "rc-dir-state";
const SCROLL_STATE_KEY = "rc-scroll-state";

interface DirState {
  page: number;
  search?: string;
  letter?: string;
  sort?: string;
  sortDir?: string;
}

function saveDirState(path: string, state: DirState) {
  try {
    const raw = sessionStorage.getItem(DIR_STATE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[path] = state;
    sessionStorage.setItem(DIR_STATE_KEY, JSON.stringify(map));
  } catch {}
}

function getDirState(path: string): DirState | null {
  try {
    const raw = sessionStorage.getItem(DIR_STATE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[path] && typeof map[path].page === "number" ? map[path] : null;
  } catch {
    return null;
  }
}

function saveScrollPos(path: string, y: number) {
  try {
    const raw = sessionStorage.getItem(SCROLL_STATE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[path] = y;
    sessionStorage.setItem(SCROLL_STATE_KEY, JSON.stringify(map));
  } catch {}
}

function popScrollPos(path: string): number | null {
  try {
    const raw = sessionStorage.getItem(SCROLL_STATE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    const y = typeof map[path] === "number" ? map[path] : null;
    if (y !== null) {
      delete map[path];
      sessionStorage.setItem(SCROLL_STATE_KEY, JSON.stringify(map));
    }
    return y;
  } catch {
    return null;
  }
}

function AccountMenu({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-gray-400 hover:text-white transition-colors cursor-pointer"
      >
        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 bg-gray-900 border border-gray-700 rounded-lg shadow-lg py-1 min-w-[200px] z-50">
          <button
            onClick={() => { setOpen(false); nav("/preferences"); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors cursor-pointer"
          >
            Preferences
          </button>
          <button
            onClick={() => { setOpen(false); nav("/thumbnails"); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors cursor-pointer"
          >
            Thumbnails
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button
            onClick={() => { setOpen(false); onLogout(); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition-colors cursor-pointer"
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}

export default function Browse({ onLogout }: { onLogout: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const [generateOnFly, setGenerateOnFly] = useState(true);
  const currentPath = searchParams.get("path") || "/";
  const currentPage = Number(searchParams.get("page") || "1");
  const currentSearch = searchParams.get("search") || "";
  const activeLetter = searchParams.get("letter") || null;
  const currentSort = searchParams.get("sort") || "alpha";
  const currentSortDir = searchParams.get("dir") || "asc";

  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState("");
  const [editingThumbnail, setEditingThumbnail] = useState<string | null>(null);
  const [thumbVersion, setThumbVersion] = useState(0);

  // Compute parent path for back button
  const parentPath = useMemo(() => {
    const trimmed = currentPath.replace(/\/+$/, "");
    if (!trimmed || trimmed === "/") return null;
    const idx = trimmed.lastIndexOf("/");
    return idx <= 0 ? "/" : trimmed.substring(0, idx);
  }, [currentPath]);

  useEffect(() => {
    getConfig()
      .then((cfg) => setGenerateOnFly(cfg.generate_on_fly))
      .catch(() => {});
  }, []);



  useEffect(() => {
    setError("");
    browse(currentPath, currentPage, 50, currentSearch, activeLetter || undefined, currentSort, currentSortDir)
      .then((result) => {
        setData(result);
        // Restore scroll position if returning from player/gallery
        const savedY = popScrollPos(currentPath);
        if (savedY !== null) {
          requestAnimationFrame(() => window.scrollTo({ top: savedY, behavior: "instant" }));
        }
      })
      .catch(() => setError("Failed to load directory"));
  }, [currentPath, currentPage, currentSearch, activeLetter, currentSort, currentSortDir]);

  function addSortParams(params: Record<string, string>, sort = currentSort, dir = currentSortDir) {
    if (sort !== "alpha") params.sort = sort;
    if (dir !== "asc") params.dir = dir;
  }

  function currentDirState(): DirState {
    return { page: currentPage, search: currentSearch || undefined, letter: activeLetter || undefined, sort: currentSort !== "alpha" ? currentSort : undefined, sortDir: currentSortDir !== "asc" ? currentSortDir : undefined };
  }

  function navigate(path: string) {
    saveDirState(currentPath, currentDirState());
    saveScrollPos(currentPath, window.scrollY);
    const params: Record<string, string> = { path };
    addSortParams(params);
    setSearchParams(params);
    window.scrollTo({ top: 0 });
  }

  function navigateBack(path: string) {
    saveDirState(currentPath, currentDirState());
    saveScrollPos(currentPath, window.scrollY);
    const saved = getDirState(path);
    const params: Record<string, string> = { path };
    if (saved) {
      if (saved.page > 1) params.page = String(saved.page);
      if (saved.search) params.search = saved.search;
      if (saved.letter) params.letter = saved.letter;
      if (saved.sort) params.sort = saved.sort;
      if (saved.sortDir) params.dir = saved.sortDir;
    }
    setSearchParams(params);
  }

  function handleSearch(search: string) {
    const params: Record<string, string> = { path: currentPath };
    if (search) params.search = search;
    addSortParams(params);
    setSearchParams(params);
  }

  function handlePageChange(page: number) {
    const params: Record<string, string> = { path: currentPath, page: String(page) };
    if (currentSearch) params.search = currentSearch;
    if (activeLetter) params.letter = activeLetter;
    addSortParams(params);
    setSearchParams(params);
    window.scrollTo({ top: 0 });
  }

  function handleSortChange(sort: string, dir: string) {
    const params: Record<string, string> = { path: currentPath };
    if (currentSearch) params.search = currentSearch;
    if (activeLetter) params.letter = activeLetter;
    addSortParams(params, sort, dir);
    setSearchParams(params);
  }

  function handleEntryClick(entry: { path: string; is_dir: boolean; is_image?: boolean }) {
    if (entry.is_dir) {
      navigate(entry.path);
    } else {
      // Save dir state and scroll position before leaving browse page
      saveDirState(currentPath, currentDirState());
      saveScrollPos(currentPath, window.scrollY);
      if (entry.is_image) {
        nav(`/gallery?path=${encodeURIComponent(entry.path)}`);
      } else {
        nav(`/play?path=${encodeURIComponent(entry.path)}`);
      }
    }
  }

  // Available letters from server response
  const availableLetters = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.letters);
  }, [data]);

  function handleLetterClick(letter: string) {
    const newLetter = activeLetter === letter ? null : letter;
    const params: Record<string, string> = { path: currentPath };
    if (currentSearch) params.search = currentSearch;
    if (newLetter) params.letter = newLetter;
    addSortParams(params);
    setSearchParams(params);
  }

  async function handleLogout() {
    await logout();
    onLogout();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 bg-gray-950/90 backdrop-blur border-b border-gray-800 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] z-10">
        <div className="w-full flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            {data && (
              <Breadcrumbs breadcrumbs={data.breadcrumbs} onNavigate={navigate} />
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <SearchBar value={currentSearch} onChange={handleSearch} />
            <AccountMenu onLogout={handleLogout} />
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          {parentPath !== null ? (
            <button
              onClick={() => navigateBack(parentPath)}
              className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors cursor-pointer"
              title="Go back"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              Back
            </button>
          ) : (
            <div className="h-5" />
          )}
          <div className="flex items-center gap-2 mr-6">
            <span className="text-xs text-gray-500">Sort</span>
            <select
              value={currentSort}
              onChange={(e) => handleSortChange(e.target.value, currentSortDir)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              <option value="alpha">Name</option>
              <option value="newest">Date</option>
              <option value="largest">Size</option>
            </select>
            <button
              onClick={() => handleSortChange(currentSort, currentSortDir === "asc" ? "desc" : "asc")}
              className="text-gray-400 hover:text-white transition-colors cursor-pointer p-1"
              title={currentSortDir === "asc" ? "Ascending" : "Descending"}
            >
              {currentSortDir === "asc" ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12l7-7 7 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7 7 7-7" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {error && (
          <div className="text-red-400 text-center py-8">{error}</div>
        )}

        {data && data.entries.length === 0 && !activeLetter && (
          <div className="text-gray-500 text-center py-16">
            {currentSearch ? "No matching files" : "Empty directory"}
          </div>
        )}

        {data && data.entries.length === 0 && activeLetter && (
          <div className="text-gray-500 text-center py-16">
            No items matching &ldquo;{activeLetter}&rdquo;
          </div>
        )}

        {data && data.entries.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 pr-8">
              {data.entries.map((entry) => (
                <VideoCard
                  key={entry.path}
                  entry={entry}
                  onClick={() => handleEntryClick(entry)}
                  onEditThumbnail={() => setEditingThumbnail(entry.path)}
                  thumbVersion={thumbVersion}
                  generateOnFly={generateOnFly}
                />
              ))}
            </div>
            <Pagination
              page={data.page}
              total={data.total}
              limit={data.limit}
              onPageChange={handlePageChange}
            />
          </>
        )}

        {/* A-Z sidebar — fixed to right edge, fits between header and bottom */}
        {data && (data.entries.length > 0 || activeLetter) && (
          <div className="fixed right-1 top-[52px] bottom-0 z-20 flex flex-col items-center justify-evenly py-4">
            {"ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("").map((letter) => {
              const isAvailable = availableLetters.has(letter);
              return (
                <button
                  key={letter}
                  onClick={() => handleLetterClick(letter)}
                  disabled={!isAvailable && activeLetter !== letter}
                  className={`text-[10px] leading-none w-5 min-h-0 flex items-center justify-center rounded
                    ${activeLetter === letter ? "!text-blue-500 font-bold cursor-pointer" : isAvailable ? "text-gray-300 cursor-pointer" : "text-gray-700 cursor-default"}`}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        )}
      </main>

      {editingThumbnail && (
        <ThumbnailPicker
          path={editingThumbnail}
          onClose={() => setEditingThumbnail(null)}
          onSaved={() => {
            setEditingThumbnail(null);
            setThumbVersion((v) => v + 1);
          }}
        />
      )}
    </div>
  );
}
