import { useState } from "react";
import { BrowseEntry } from "../api";

interface Props {
  entry: BrowseEntry;
  onClick: () => void;
  onEditThumbnail?: () => void;
  onPlayAll?: () => void;
  thumbVersion?: number;
  generateOnFly?: boolean;
  musicMode?: boolean;
  coverArt?: string;
  isPlaying?: boolean;
}

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

function DiscInFolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none">
      <path d="M4 12a4 4 0 014-4h12l4 4h16a4 4 0 014 4v20a4 4 0 01-4 4H8a4 4 0 01-4-4V12z" fill="currentColor" opacity="0.3" />
      <circle cx="24" cy="27" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
      <circle cx="24" cy="27" r="3" fill="currentColor" />
      <circle cx="24" cy="27" r="6" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4" />
    </svg>
  );
}

function MusicNoteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
    </svg>
  );
}

function NowPlayingIndicator() {
  return (
    <div className="absolute bottom-1 left-1 flex items-end gap-0.5 h-4 p-0.5 bg-black/60 rounded">
      <span className="w-1 bg-blue-400 rounded-sm animate-[eq1_0.8s_ease-in-out_infinite]" style={{ height: "60%" }} />
      <span className="w-1 bg-blue-400 rounded-sm animate-[eq2_0.6s_ease-in-out_infinite]" style={{ height: "100%" }} />
      <span className="w-1 bg-blue-400 rounded-sm animate-[eq3_0.7s_ease-in-out_infinite]" style={{ height: "40%" }} />
      <style>{`
        @keyframes eq1 { 0%, 100% { height: 60%; } 50% { height: 20%; } }
        @keyframes eq2 { 0%, 100% { height: 100%; } 50% { height: 30%; } }
        @keyframes eq3 { 0%, 100% { height: 40%; } 50% { height: 80%; } }
      `}</style>
    </div>
  );
}

export default function VideoCard({ entry, onClick, onEditThumbnail, onPlayAll, thumbVersion, generateOnFly = true, musicMode, coverArt, isPlaying }: Props) {
  const [thumbFailed, setThumbFailed] = useState(false);

  const genParam = generateOnFly ? "" : "&generate=0";

  // Determine thumbnail URL
  let thumbUrl: string | null = null;
  if (musicMode) {
    const art = entry.cover_art || coverArt;
    if (art) {
      thumbUrl = `/api/image?path=${encodeURIComponent(art)}`;
    }
  } else if (entry.is_image) {
    thumbUrl = `/api/image?path=${encodeURIComponent(entry.path)}`;
  } else if (entry.is_ebook) {
    thumbUrl = `/api/ebook/cover?path=${encodeURIComponent(entry.path)}`;
  } else if (entry.is_comic) {
    thumbUrl = `/api/comic/page?path=${encodeURIComponent(entry.path)}&page=0`;
  } else if (entry.is_markdown) {
    thumbUrl = null; // No server-side thumbnail for markdown
  } else if (entry.name.toLowerCase().endsWith(".pdf")) {
    thumbUrl = `/api/pdf/page?path=${encodeURIComponent(entry.path)}&page=0&fit=width&width=320&height=480`;
  } else {
    thumbUrl = `/api/thumbnail?path=${encodeURIComponent(entry.path)}${thumbVersion ? `&v=${thumbVersion}` : ""}${genParam}`;
  }

  const isBookFormat = !musicMode && !entry.is_dir && (entry.is_ebook || entry.is_comic || entry.is_markdown || entry.name.toLowerCase().endsWith(".pdf"));
  const aspectClass = musicMode ? "aspect-square" : isBookFormat ? "aspect-[2/3]" : "aspect-video";

  return (
    <button
      onClick={onClick}
      className={`bg-gray-900 rounded-lg overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all text-left group w-full flex flex-col cursor-pointer ${isPlaying ? "ring-2 ring-blue-500" : ""}`}
    >
      <div className={`${aspectClass} bg-gray-800 relative overflow-hidden flex items-center justify-center`}>
        {thumbUrl && !thumbFailed && (
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        )}
        {/* Music mode fallbacks */}
        {musicMode && (!thumbUrl || thumbFailed) && entry.is_dir && (
          <DiscInFolderIcon className="w-16 h-16 text-blue-400 drop-shadow-lg" />
        )}
        {musicMode && (!thumbUrl || thumbFailed) && !entry.is_dir && (
          <MusicNoteIcon className="w-12 h-12 text-blue-400 drop-shadow-lg" />
        )}
        {/* Default mode fallbacks */}
        {!musicMode && entry.is_dir && thumbFailed && (
          <svg
            className="w-12 h-12 text-blue-400 drop-shadow-lg"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
        )}
        {!musicMode && !entry.is_dir && isBookFormat && (thumbFailed || !thumbUrl) && (
          <svg className="w-12 h-12 text-blue-400 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 2a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6H6zm7 1.5L18.5 9H13V3.5zM8 12h8v1.5H8V12zm0 3h8v1.5H8V15z"/>
          </svg>
        )}
        {!musicMode && entry.is_dir && !thumbFailed && (
          <div className="absolute bottom-1 right-1 bg-black/60 rounded p-0.5">
            <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          </div>
        )}
        {onEditThumbnail && !entry.is_image && !musicMode && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onEditThumbnail();
            }}
            className="absolute top-1 left-1 bg-black/60 hover:bg-black/80 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <svg className="w-4 h-4 text-gray-300" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </div>
        )}
        {isPlaying && <NowPlayingIndicator />}
        {musicMode && entry.is_dir && onPlayAll && (
          <div
            onClick={(e) => { e.stopPropagation(); onPlayAll(); }}
            className="absolute bottom-2 right-2 bg-blue-600 hover:bg-blue-500 rounded-full p-2 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer shadow-lg"
            title="Play All"
          >
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>
      <div className="p-3 flex-1">
        <div className="text-sm break-words group-hover:text-white transition-colors">
          {entry.name}
        </div>
        {!entry.is_dir && entry.size != null && !musicMode && (
          <div className="text-xs text-gray-500 mt-1">{formatSize(entry.size)}</div>
        )}
      </div>
    </button>
  );
}
