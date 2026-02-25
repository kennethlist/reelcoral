import { Breadcrumb } from "../api";

interface Props {
  breadcrumbs: Breadcrumb[];
  onNavigate: (path: string) => void;
}

export default function Breadcrumbs({ breadcrumbs, onNavigate }: Props) {
  return (
    <nav className="flex items-center gap-1 text-sm text-gray-400 overflow-x-auto pb-1">
      {breadcrumbs.map((bc, i) => (
        <span key={bc.path} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span className="text-gray-600">/</span>}
          {i < breadcrumbs.length - 1 ? (
            <button
              onClick={() => onNavigate(bc.path)}
              className="hover:text-white transition-colors cursor-pointer"
            >
              {bc.name}
            </button>
          ) : (
            <span className="text-gray-200">{bc.name}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
