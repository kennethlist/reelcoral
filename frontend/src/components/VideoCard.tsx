import { useState } from "react";
import { BrowseEntry } from "../api";

interface Props {
  entry: BrowseEntry;
  onClick: () => void;
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

export default function VideoCard({ entry, onClick }: Props) {
  const [thumbFailed, setThumbFailed] = useState(false);

  return (
    <button
      onClick={onClick}
      className="bg-gray-900 rounded-lg overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all text-left group w-full flex flex-col cursor-pointer"
    >
      <div className="aspect-video bg-gray-800 relative flex items-center justify-center">
        {!thumbFailed && (
          <img
            src={`/api/thumbnail?path=${encodeURIComponent(entry.path)}`}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        )}
        {entry.is_dir && thumbFailed && (
          <svg
            className="w-12 h-12 text-blue-400 drop-shadow-lg"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
        )}
        {entry.is_dir && !thumbFailed && (
          <div className="absolute bottom-1 right-1 bg-black/60 rounded p-0.5">
            <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          </div>
        )}
      </div>
      <div className="p-3 flex-1">
        <div className="text-sm break-words group-hover:text-white transition-colors">
          {entry.name}
        </div>
        {!entry.is_dir && entry.size != null && (
          <div className="text-xs text-gray-500 mt-1">{formatSize(entry.size)}</div>
        )}
      </div>
    </button>
  );
}
