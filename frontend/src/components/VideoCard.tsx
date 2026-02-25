import { useState } from "react";
import { BrowseEntry } from "../api";

interface Props {
  entry: BrowseEntry;
  onClick: () => void;
  onEditThumbnail?: () => void;
  thumbVersion?: number;
  generateOnFly?: boolean;
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

export default function VideoCard({ entry, onClick, onEditThumbnail, thumbVersion, generateOnFly = true }: Props) {
  const [thumbFailed, setThumbFailed] = useState(false);

  const genParam = generateOnFly ? "" : "&generate=0";
  const thumbUrl = entry.is_image
    ? `/api/image?path=${encodeURIComponent(entry.path)}`
    : `/api/thumbnail?path=${encodeURIComponent(entry.path)}${thumbVersion ? `&v=${thumbVersion}` : ""}${genParam}`;

  return (
    <button
      onClick={onClick}
      className="bg-gray-900 rounded-lg overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all text-left group w-full flex flex-col cursor-pointer"
    >
      <div className="aspect-video bg-gray-800 relative overflow-hidden flex items-center justify-center">
        {!thumbFailed && (
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
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
        {onEditThumbnail && !entry.is_image && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onEditThumbnail();
            }}
            className="absolute top-1 right-1 bg-black/60 hover:bg-black/80 rounded p-1 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            <svg className="w-4 h-4 text-gray-300" viewBox="0 0 20 20" fill="currentColor">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
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
