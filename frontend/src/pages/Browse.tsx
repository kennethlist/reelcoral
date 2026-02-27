import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { browse, logout, getConfig, BrowseResult, BrowseEntry, downloadUrl, downloadBulk } from "../api";
import VideoCard from "../components/VideoCard";
import Breadcrumbs from "../components/Breadcrumbs";
import SearchBar from "../components/SearchBar";
import Pagination from "../components/Pagination";
import ThumbnailPicker from "../components/ThumbnailPicker";
import { useMusicPlayer, type MusicTrack } from "../hooks/useMusicPlayer";
import { usePreferences } from "../hooks/usePreferences";

function formatSize(bytes?: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

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
  const music = useMusicPlayer();
  const { prefs } = usePreferences();
  const gridClass = prefs.grid_size === "large"
    ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4"
    : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";
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
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloading, setDownloading] = useState(false);

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
    setSelectMode(false);
    setSelected(new Set());
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

  function buildPlaylist(entries: BrowseEntry[], albumName?: string, coverArt?: string): MusicTrack[] {
    return entries
      .filter((e) => !e.is_dir && e.is_audio)
      .map((e) => ({
        name: e.name,
        path: e.path,
        albumName,
        coverArt,
      }));
  }

  function handlePlayAll() {
    if (!data) return;
    const albumName = data.breadcrumbs[data.breadcrumbs.length - 1]?.name;
    const tracks = buildPlaylist(data.entries, albumName, data.cover_art);
    if (tracks.length > 0) music.playAll(tracks, 0);
  }

  // Play All from an album folder card (fetches that folder's contents)
  const handlePlayAlbum = useCallback(async (albumEntry: BrowseEntry) => {
    try {
      const result = await browse(albumEntry.path, 1, 200);
      const albumName = albumEntry.name;
      const coverArt = albumEntry.cover_art || result.cover_art;
      const tracks = result.entries
        .filter((e) => !e.is_dir && e.is_audio)
        .map((e) => ({
          name: e.name,
          path: e.path,
          albumName,
          coverArt,
        }));
      if (tracks.length > 0) music.playAll(tracks, 0);
    } catch {}
  }, [music]);

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!data) return;
    const files = data.entries.filter((e) => !e.is_dir);
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((e) => e.path)));
    }
  }

  async function handleBulkDownload() {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      const blob = await downloadBulk(Array.from(selected));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "download.zip";
      a.click();
      URL.revokeObjectURL(url);
      setSelectMode(false);
      setSelected(new Set());
    } catch {} finally {
      setDownloading(false);
    }
  }

  function handleEntryClick(entry: BrowseEntry) {
    if (entry.is_dir) {
      navigate(entry.path);
    } else if (entry.is_audio && data?.is_music_folder) {
      const albumName = data.breadcrumbs[data.breadcrumbs.length - 1]?.name;
      music.playSingle({
        name: entry.name,
        path: entry.path,
        albumName,
        coverArt: data.cover_art,
      });
    } else {
      // Save dir state and scroll position before leaving browse page
      saveDirState(currentPath, currentDirState());
      saveScrollPos(currentPath, window.scrollY);
      if (music.isVisible) music.dismiss();
      if (entry.is_image) {
        nav(`/gallery?path=${encodeURIComponent(entry.path)}`);
      } else if (entry.is_audio) {
        nav(`/audio?path=${encodeURIComponent(entry.path)}`);
      } else if (entry.is_ebook || entry.is_comic || entry.is_markdown) {
        nav(`/read?path=${encodeURIComponent(entry.path)}`);
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
    <div className={`min-h-screen ${music.isVisible ? "pb-20" : ""}`}>
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
            {!data?.is_music_folder && !data?.is_music_context && (
              <button
                onClick={() => { setSelectMode((v) => !v); setSelected(new Set()); }}
                className={`text-xs px-2 py-1 rounded transition-colors cursor-pointer mr-2 ${selectMode ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:text-white"}`}
              >
                {selectMode ? "Cancel" : "Select"}
              </button>
            )}
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

        {data && data.entries.length > 0 && data.is_music_folder && (
          <>
            {/* Album level: Play All header + song list */}
            <div className="mb-4 flex items-center gap-3">
              {data.cover_art && (
                <img
                  src={`/api/image?path=${encodeURIComponent(data.cover_art)}`}
                  alt=""
                  className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
                />
              )}
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-white truncate">
                  {data.breadcrumbs[data.breadcrumbs.length - 1]?.name}
                </h2>
                <div className="text-xs text-gray-400">
                  {data.entries.filter((e) => e.is_audio).length} tracks
                </div>
              </div>
              <button
                onClick={handlePlayAll}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors cursor-pointer text-sm font-medium flex-shrink-0"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play All
              </button>
            </div>
            <div className="flex flex-col rounded-lg overflow-hidden mr-8">
              {data.entries.filter((e) => e.is_audio).map((entry, i) => {
                const isCurrentTrack = music.isVisible && music.playlist[music.currentIndex]?.path === entry.path;
                return (
                  <div
                    key={entry.path}
                    className={`flex items-center gap-3 px-4 py-3 transition-colors group/row ${
                      isCurrentTrack ? "bg-blue-600/20 text-white" : `${i % 2 === 0 ? "bg-gray-900" : "bg-gray-900/60"} hover:bg-gray-800 text-gray-300 hover:text-white`
                    }`}
                  >
                    <button
                      onClick={() => handleEntryClick(entry)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <span className="w-8 text-center text-xs text-gray-500 flex-shrink-0">
                        {isCurrentTrack && music.isPlaying ? (
                          <span className="inline-flex items-end gap-0.5 h-3">
                            <span className="w-0.5 bg-blue-400 rounded-sm animate-[eq1_0.8s_ease-in-out_infinite]" style={{ height: "60%" }} />
                            <span className="w-0.5 bg-blue-400 rounded-sm animate-[eq2_0.6s_ease-in-out_infinite]" style={{ height: "100%" }} />
                            <span className="w-0.5 bg-blue-400 rounded-sm animate-[eq3_0.7s_ease-in-out_infinite]" style={{ height: "40%" }} />
                            <style>{`
                              @keyframes eq1 { 0%, 100% { height: 60%; } 50% { height: 20%; } }
                              @keyframes eq2 { 0%, 100% { height: 100%; } 50% { height: 30%; } }
                              @keyframes eq3 { 0%, 100% { height: 40%; } 50% { height: 80%; } }
                            `}</style>
                          </span>
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span className="flex-1 text-sm truncate">{entry.name}</span>
                    </button>
                    {entry.size != null && (
                      <span className="text-xs text-gray-500 flex-shrink-0">{formatSize(entry.size)}</span>
                    )}
                    <button
                      onClick={() => handleEntryClick(entry)}
                      className="text-gray-500 hover:text-white transition-colors cursor-pointer p-1 flex-shrink-0 opacity-0 group-hover/row:opacity-100"
                      title="Play"
                    >
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {data && data.entries.length > 0 && !data.is_music_folder && data.is_music_context && (() => {
          const hasAlbums = data.entries.some((e) => e.is_album);
          return hasAlbums ? (
            <>
              {/* Album grid (1:1 square cards with cover art) */}
              <div className={`grid ${gridClass} gap-4 pr-8`}>
                {data.entries.map((entry) => (
                  <VideoCard
                    key={entry.path}
                    entry={entry}
                    onClick={() => handleEntryClick(entry)}
                    onPlayAll={entry.is_dir ? () => handlePlayAlbum(entry) : undefined}
                    thumbVersion={thumbVersion}
                    generateOnFly={generateOnFly}
                    musicMode
                    coverArt={entry.cover_art}
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
          ) : (
            <>
              {/* Artist list (no albums at this level) */}
              <div className="flex flex-col rounded-lg overflow-hidden mr-8">
                {data.entries.map((entry, i) => (
                  <div
                    key={entry.path}
                    className={`flex items-center gap-3 px-4 py-3 ${i % 2 === 0 ? "bg-gray-900" : "bg-gray-900/60"} hover:bg-gray-800 text-gray-300 hover:text-white transition-colors group/row`}
                  >
                    <button
                      onClick={() => handleEntryClick(entry)}
                      className="flex items-center flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <span className="flex-1 text-sm truncate">{entry.name}</span>
                    </button>
                  </div>
                ))}
              </div>
              <Pagination
                page={data.page}
                total={data.total}
                limit={data.limit}
                onPageChange={handlePageChange}
              />
            </>
          );
        })()}

        {data && data.entries.length > 0 && !data.is_music_folder && !data.is_music_context && (
          <>
            {/* Select mode bar */}
            {selectMode && (
              <div className="flex items-center gap-3 mb-4 px-2 py-2 bg-gray-900 rounded-lg mr-8">
                <button
                  onClick={toggleSelectAll}
                  className="text-xs px-3 py-1 rounded bg-gray-800 text-gray-300 hover:text-white transition-colors cursor-pointer"
                >
                  {selected.size === data.entries.filter((e) => !e.is_dir).length ? "Deselect All" : "Select All"}
                </button>
                <span className="text-xs text-gray-400">{selected.size} selected</span>
                <div className="flex-1" />
                <button
                  onClick={handleBulkDownload}
                  disabled={selected.size === 0 || downloading}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40 transition-colors cursor-pointer"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                    <path strokeLinecap="round" d="M5 20h14" />
                  </svg>
                  {downloading ? "Downloading..." : "Download"}
                </button>
              </div>
            )}
            {/* Normal grid for non-music content */}
            <div className={`grid ${gridClass} gap-4 pr-8`}>
              {data.entries.map((entry) => (
                <div key={entry.path} className="relative group/card">
                  {selectMode && !entry.is_dir && (
                    <div
                      onClick={(e) => { e.stopPropagation(); toggleSelect(entry.path); }}
                      className="absolute top-2 left-2 z-10 cursor-pointer"
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                        selected.has(entry.path) ? "bg-blue-600 border-blue-600" : "border-gray-400 bg-black/40"
                      }`}>
                        {selected.has(entry.path) && (
                          <svg className="w-3 h-3 text-white" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                    </div>
                  )}
                  {/* Per-file download button (hover) */}
                  {!selectMode && !entry.is_dir && (
                    <a
                      href={downloadUrl(entry.path)}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-2 right-2 z-10 bg-black/60 hover:bg-black/80 rounded p-1 opacity-0 group-hover/card:opacity-100 transition-opacity cursor-pointer"
                      title="Download"
                    >
                      <svg className="w-4 h-4 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12l7 7 7-7" />
                        <path strokeLinecap="round" d="M5 20h14" />
                      </svg>
                    </a>
                  )}
                  <VideoCard
                    entry={entry}
                    onClick={() => selectMode && !entry.is_dir ? toggleSelect(entry.path) : handleEntryClick(entry)}
                    onEditThumbnail={selectMode ? undefined : () => setEditingThumbnail(entry.path)}
                    thumbVersion={thumbVersion}
                    generateOnFly={generateOnFly}
                  />
                </div>
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
          <div className={`fixed right-1 top-[52px] ${music.isVisible ? "bottom-16" : "bottom-0"} z-20 flex flex-col items-center justify-evenly py-4`}>
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
