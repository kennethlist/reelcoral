import { useState, useEffect, useRef } from "react";
import {
  getThumbnailCandidates,
  selectThumbnailCandidate,
  uploadCustomThumbnail,
  resetThumbnail,
} from "../api";

interface Props {
  path: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function ThumbnailPicker({ path, onClose, onSaved }: Props) {
  const [candidates, setCandidates] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  function loadCandidates() {
    setLoading(true);
    setError("");
    setCandidates([]);
    getThumbnailCandidates(path)
      .then((data) => setCandidates(data.candidates))
      .catch(() => setError("Failed to generate candidates"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadCandidates();
  }, [path]);

  async function handleSelect(index: number) {
    setSaving(true);
    try {
      await selectThumbnailCandidate(path, index);
      onSaved();
    } catch {
      setError("Failed to select thumbnail");
      setSaving(false);
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    try {
      await uploadCustomThumbnail(path, file);
      onSaved();
    } catch {
      setError("Failed to upload thumbnail");
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await resetThumbnail(path);
      onSaved();
    } catch {
      setError("Failed to reset thumbnail");
      setSaving(false);
    }
  }

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === backdropRef.current) onClose();
  }

  return (
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
    >
      <div className="bg-gray-900 rounded-xl max-w-lg w-full p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Choose Thumbnail</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white cursor-pointer"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {error && <div className="text-red-400 text-sm">{error}</div>}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="ml-3 text-gray-400">Generating candidates...</span>
          </div>
        ) : candidates.length > 0 ? (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              {candidates.map((url, i) =>
                url ? (
                  <button
                    key={i}
                    onClick={() => handleSelect(i)}
                    disabled={saving}
                    className="aspect-video rounded overflow-hidden hover:ring-2 hover:ring-blue-500 transition-all cursor-pointer disabled:opacity-50"
                  >
                    <img
                      src={url}
                      alt={`Candidate ${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ) : (
                  <div
                    key={i}
                    className="aspect-video rounded bg-gray-800 flex items-center justify-center text-gray-600 text-xs"
                  >
                    Failed
                  </div>
                )
              )}
            </div>
            <button
              onClick={loadCandidates}
              disabled={saving}
              className="text-sm text-gray-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
            >
              Shuffle
            </button>
          </div>
        ) : (
          <div className="text-gray-400 text-sm py-4">
            No frame candidates available for this item. You can upload a custom image below.
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={saving}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50"
          >
            Upload Custom Image
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="hidden"
          />
          <button
            onClick={handleReset}
            disabled={saving}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors cursor-pointer disabled:opacity-50"
          >
            Reset to Default
          </button>
        </div>
      </div>
    </div>
  );
}
