import { useState } from "react";

interface Props {
  page: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

function getPageNumbers(current: number, total: number): (number | null)[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | null)[] = [1];

  if (current <= 4) {
    // Near start: 1 2 3 4 5 ... last
    for (let i = 2; i <= 5; i++) pages.push(i);
    pages.push(null, total);
  } else if (current >= total - 3) {
    // Near end: 1 ... n-4 n-3 n-2 n-1 last
    pages.push(null);
    for (let i = total - 4; i <= total; i++) pages.push(i);
  } else {
    // Middle: 1 ... c-1 c c+1 ... last
    pages.push(null, current - 1, current, current + 1, null, total);
  }

  return pages;
}

const btn =
  "px-2 py-1 rounded text-sm transition-colors cursor-pointer disabled:cursor-default";
const navBtn = `${btn} bg-gray-800 disabled:opacity-30 hover:bg-gray-700`;

export default function Pagination({ page, total, limit, onPageChange }: Props) {
  const totalPages = Math.ceil(total / limit);
  const [jumpValue, setJumpValue] = useState("");

  if (totalPages <= 1) return null;

  const pages = getPageNumbers(page, totalPages);

  function handleJump() {
    const num = parseInt(jumpValue, 10);
    if (num >= 1 && num <= totalPages && num !== page) {
      onPageChange(num);
    }
    setJumpValue("");
  }

  return (
    <div className="flex items-center gap-1.5 justify-center py-4 flex-wrap">
      {/* First / Prev */}
      <button
        onClick={() => onPageChange(1)}
        disabled={page <= 1}
        className={navBtn}
        title="First page"
      >
        &laquo;
      </button>
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className={navBtn}
        title="Previous page"
      >
        &lsaquo;
      </button>

      {/* Page numbers */}
      {pages.map((p, i) =>
        p === null ? (
          <span key={`e${i}`} className="text-gray-500 text-sm px-1">
            ...
          </span>
        ) : (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={`${btn} ${
              p === page
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {p}
          </button>
        )
      )}

      {/* Next / Last */}
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className={navBtn}
        title="Next page"
      >
        &rsaquo;
      </button>
      <button
        onClick={() => onPageChange(totalPages)}
        disabled={page >= totalPages}
        className={navBtn}
        title="Last page"
      >
        &raquo;
      </button>

      {/* Jump to page */}
      {totalPages > 7 && (
        <div className="flex items-center gap-1 ml-2">
          <input
            type="number"
            min={1}
            max={totalPages}
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleJump()}
            placeholder="#"
            className="w-14 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-center text-gray-200 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button onClick={handleJump} className={navBtn}>
            Go
          </button>
        </div>
      )}
    </div>
  );
}
