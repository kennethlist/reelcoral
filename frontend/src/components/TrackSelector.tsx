import { langName } from "../utils/languages";

interface Track {
  index: number;
  codec: string;
  lang: string;
  title: string;
  channels?: number;
  bitmap?: boolean;
}

interface Props {
  label: string;
  tracks: Track[];
  selected: number | null;
  onChange: (index: number | null) => void;
  allowNone?: boolean;
}

function trackLabel(t: Track): string {
  const parts = [langName(t.lang)];
  if (t.title) parts.push(t.title);
  if (t.channels) parts.push(`${t.channels}ch`);
  if (t.bitmap) parts.push("(bitmap - unsupported)");
  parts.push(`[${t.codec}]`);
  return parts.join(" - ");
}

export default function TrackSelector({
  label,
  tracks,
  selected,
  onChange,
  allowNone,
}: Props) {
  if (tracks.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {label && <label className="text-sm text-gray-400 shrink-0">{label}:</label>}
      <select
        value={selected ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? null : Number(v));
        }}
        className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
      >
        {allowNone && <option value="">Off</option>}
        {tracks.map((t) => (
          <option key={t.index} value={t.index} disabled={t.bitmap}>
            {trackLabel(t)}
          </option>
        ))}
      </select>
    </div>
  );
}
