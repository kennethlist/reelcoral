import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { browse, logout, BrowseResult } from "../api";
import VideoCard from "../components/VideoCard";
import Breadcrumbs from "../components/Breadcrumbs";
import SearchBar from "../components/SearchBar";
import Pagination from "../components/Pagination";

export default function Browse({ onLogout }: { onLogout: () => void }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const nav = useNavigate();
  const currentPath = searchParams.get("path") || "/";
  const currentPage = Number(searchParams.get("page") || "1");
  const currentSearch = searchParams.get("search") || "";

  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState("");
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  useEffect(() => {
    setError("");
    setActiveLetter(null);
    browse(currentPath, currentPage, 50, currentSearch)
      .then(setData)
      .catch(() => setError("Failed to load directory"));
  }, [currentPath, currentPage, currentSearch]);

  function navigate(path: string) {
    setSearchParams({ path });
  }

  function handleSearch(search: string) {
    const params: Record<string, string> = { path: currentPath };
    if (search) params.search = search;
    setSearchParams(params);
  }

  function handlePageChange(page: number) {
    const params: Record<string, string> = { path: currentPath, page: String(page) };
    if (currentSearch) params.search = currentSearch;
    setSearchParams(params);
  }

  function handleEntryClick(entry: { path: string; is_dir: boolean }) {
    if (entry.is_dir) {
      navigate(entry.path);
    } else {
      nav(`/play?path=${encodeURIComponent(entry.path)}`);
    }
  }

  // Build available letters from current entries
  const availableLetters = useMemo(() => {
    if (!data) return new Set<string>();
    const letters = new Set<string>();
    for (const entry of data.entries) {
      const first = entry.name[0]?.toUpperCase();
      if (first) letters.add(first);
    }
    return letters;
  }, [data]);

  function handleLetterClick(letter: string) {
    // Toggle: clicking the same letter again clears the filter
    setActiveLetter((prev) => (prev === letter ? null : letter));
  }

  // Filter entries by active letter
  const filteredEntries = useMemo(() => {
    if (!data || !activeLetter) return data?.entries ?? [];
    return data.entries.filter((entry) => {
      const first = entry.name[0]?.toUpperCase() || "";
      if (activeLetter === "#") return !/^[A-Za-z]/.test(entry.name);
      return first === activeLetter;
    });
  }, [data, activeLetter]);

  async function handleLogout() {
    await logout();
    onLogout();
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 bg-gray-950/90 backdrop-blur border-b border-gray-800 px-4 py-3 z-10">
        <div className="w-full flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            {data && (
              <Breadcrumbs breadcrumbs={data.breadcrumbs} onNavigate={navigate} />
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <SearchBar value={currentSearch} onChange={handleSearch} />
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-white transition-colors cursor-pointer"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-6">
        {error && (
          <div className="text-red-400 text-center py-8">{error}</div>
        )}

        {data && data.entries.length === 0 && (
          <div className="text-gray-500 text-center py-16">
            {currentSearch ? "No matching files" : "Empty directory"}
          </div>
        )}

        {data && data.entries.length > 0 && (
          <>
            {filteredEntries.length === 0 ? (
              <div className="text-gray-500 text-center py-16">
                No items matching &ldquo;{activeLetter}&rdquo;
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 pr-8">
                {filteredEntries.map((entry) => (
                  <VideoCard
                    key={entry.path}
                    entry={entry}
                    onClick={() => handleEntryClick(entry)}
                  />
                ))}
              </div>
            )}
            <Pagination
              page={data.page}
              total={data.total}
              limit={data.limit}
              onPageChange={handlePageChange}
            />
          </>
        )}

        {/* A-Z sidebar — fixed to right edge, fits between header and bottom */}
        {data && data.entries.length > 0 && (
          <div className="fixed right-1 top-[52px] bottom-0 z-20 flex flex-col items-center justify-evenly py-4">
            {"ABCDEFGHIJKLMNOPQRSTUVWXYZ#".split("").map((letter) => {
              const isAvailable = letter === "#"
                ? data.entries.some((e) => /^[^A-Za-z]/.test(e.name))
                : availableLetters.has(letter);
              return (
                <button
                  key={letter}
                  onClick={() => handleLetterClick(letter)}
                  disabled={!isAvailable}
                  className={`text-[10px] leading-none w-5 min-h-0 flex items-center justify-center rounded transition-colors
                    ${isAvailable ? "text-gray-300 hover:text-white hover:bg-gray-700 cursor-pointer" : "text-gray-700 cursor-default"}
                    ${activeLetter === letter ? "bg-blue-600 text-white" : ""}`}
                >
                  {letter}
                </button>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
