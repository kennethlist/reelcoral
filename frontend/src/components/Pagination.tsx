interface Props {
  page: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

export default function Pagination({ page, total, limit, onPageChange }: Props) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center gap-2 justify-center py-4">
      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="px-3 py-1 bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors text-sm cursor-pointer disabled:cursor-default"
      >
        Prev
      </button>
      <span className="text-sm text-gray-400">
        {page} / {totalPages}
      </span>
      <button
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="px-3 py-1 bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700 transition-colors text-sm cursor-pointer disabled:cursor-default"
      >
        Next
      </button>
    </div>
  );
}
