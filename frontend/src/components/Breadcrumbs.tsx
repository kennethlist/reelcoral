import { Breadcrumb } from "../api";

interface Props {
  breadcrumbs: Breadcrumb[];
  onNavigate: (path: string) => void;
}

const HomeIcon = (
  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12L12 3l9 9" />
    <path d="M9 21V12h6v9" />
  </svg>
);

function label(bc: Breadcrumb, i: number) {
  return i === 0 && bc.name === "Home" ? HomeIcon : bc.name;
}

export default function Breadcrumbs({ breadcrumbs, onNavigate }: Props) {
  return (
    <nav className="flex items-center gap-1 text-sm text-gray-400 overflow-x-auto pb-1">
      {breadcrumbs.map((bc, i) => (
        <span key={bc.path} className="flex items-center gap-1 shrink-0">
          {i > 0 && <span className="text-gray-600">/</span>}
          {i < breadcrumbs.length - 1 || (i === 0 && bc.name === "Home") ? (
            <button
              onClick={() => onNavigate(bc.path)}
              className={`min-h-[44px] min-w-[44px] flex items-center justify-center hover:text-white transition-colors cursor-pointer ${i === 0 && bc.name === "Home" ? "p-2" : "px-2 py-2"}`}
            >
              {label(bc, i)}
            </button>
          ) : (
            <span className="min-h-[44px] flex items-center px-2 py-2 text-gray-200">{label(bc, i)}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
