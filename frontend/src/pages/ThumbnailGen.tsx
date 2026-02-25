import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  scanThumbnails,
  startThumbnailGeneration,
  stopThumbnailGeneration,
  subscribeThumbnailProgress,
  getThumbnailStatus,
  deleteAllThumbnails,
  ThumbnailScanResult,
  ThumbnailGenEvent,
} from "../api";

type Phase = "idle" | "scanning" | "ready" | "generating" | "stopped" | "done";

export default function ThumbnailGen() {
  const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>("idle");
  const [scan, setScan] = useState<ThumbnailScanResult | null>(null);
  const [progress, setProgress] = useState<ThumbnailGenEvent | null>(null);
  const [override, setOverride] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const esRef = useRef<EventSource | null>(null);

  // On mount, check if generation is already running
  useEffect(() => {
    getThumbnailStatus().then((status) => {
      if (status.running) {
        setPhase("generating");
        setProgress(status);
        const es = subscribeThumbnailProgress(
          (event) => {
            setProgress(event);
            if (event.status === "done" || event.status === "stopped") {
              es.close();
              esRef.current = null;
              setPhase(event.status === "done" ? "done" : "stopped");
            }
          },
          (err) => {
            setError(err);
            setPhase("stopped");
            esRef.current = null;
          }
        );
        esRef.current = es;
      }
    }).catch(() => {});

    return () => {
      esRef.current?.close();
    };
  }, []);

  const handleScan = useCallback(async () => {
    setPhase("scanning");
    setError("");
    setSuccess("");
    setScan(null);
    setProgress(null);
    try {
      const result = await scanThumbnails();
      setScan(result);
      setPhase("ready");
    } catch {
      setError("Failed to scan media library");
      setPhase("idle");
    }
  }, []);

  const handleStart = useCallback(() => {
    if (override && !confirmOverride) {
      setConfirmOverride(true);
      return;
    }
    setConfirmOverride(false);
    setPhase("generating");
    setError("");

    const es = startThumbnailGeneration(
      override,
      (event) => {
        setProgress(event);
        if (event.status === "done" || event.status === "stopped") {
          es.close();
          esRef.current = null;
          setPhase(event.status === "done" ? "done" : "stopped");
        }
      },
      (err) => {
        setError(err);
        setPhase("stopped");
        esRef.current = null;
      }
    );
    esRef.current = es;
  }, [override, confirmOverride]);

  const handleStop = useCallback(async () => {
    await stopThumbnailGeneration();
  }, []);

  const handleDeleteAll = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    setDeleting(true);
    setError("");
    setSuccess("");
    try {
      const result = await deleteAllThumbnails();
      setScan(null);
      setProgress(null);
      setPhase("idle");
      if (result.failed > 0) {
        setError(`Deleted ${result.deleted} thumbnails, ${result.failed} failed to delete.`);
      } else {
        setSuccess(`Deleted ${result.deleted} thumbnails.`);
      }
    } catch {
      setError("Failed to delete thumbnails");
    } finally {
      setDeleting(false);
    }
  }, [confirmDelete]);

  const pct = progress && progress.total > 0
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="sticky top-0 bg-gray-950/90 backdrop-blur border-b border-gray-800 px-4 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] z-10">
        <div className="flex items-center gap-4">
          <button
            onClick={() => nav("/")}
            className="text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1 className="text-lg font-medium">Thumbnails</h1>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8 space-y-6">
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-red-300 text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-900/30 border border-green-800 rounded-lg px-4 py-3 text-green-300 text-sm">
            {success}
          </div>
        )}

        {/* Delete all — always visible except during generation */}
        {phase !== "generating" && (
          <div className="space-y-3">
            {!confirmDelete ? (
              <button
                onClick={handleDeleteAll}
                disabled={deleting}
                className="bg-red-700 hover:bg-red-600 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-2 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {deleting ? "Deleting..." : "Delete All Thumbnails"}
              </button>
            ) : (
              <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 text-sm text-red-300 space-y-2">
                <p>This will delete all cached thumbnails. They will need to be regenerated. Continue?</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteAll}
                    className="bg-red-600 hover:bg-red-500 text-white px-3 py-1 rounded text-sm cursor-pointer"
                  >
                    Yes, delete all
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1 rounded text-sm cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Scan section */}
        {(phase === "idle" || phase === "scanning") && (
          <div className="space-y-4">
            <p className="text-gray-400 text-sm">
              Scan your media library to find items missing thumbnails, then generate them all at once.
            </p>
            <button
              onClick={handleScan}
              disabled={phase === "scanning"}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-2 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {phase === "scanning" ? "Scanning..." : "Scan Library"}
            </button>
          </div>
        )}

        {/* Scan results */}
        {scan && phase !== "idle" && phase !== "scanning" && (
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
            <h2 className="text-sm font-medium text-gray-300">Scan Results</h2>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold">{scan.total}</div>
                <div className="text-xs text-gray-500">Total</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-400">{scan.cached}</div>
                <div className="text-xs text-gray-500">Cached</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-yellow-400">{scan.missing}</div>
                <div className="text-xs text-gray-500">Missing</div>
              </div>
            </div>
          </div>
        )}

        {/* Controls */}
        {phase === "ready" && (
          <div className="space-y-4">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => { setOverride(e.target.checked); setConfirmOverride(false); }}
                className="rounded border-gray-600"
              />
              Override all existing thumbnails
            </label>

            {confirmOverride && (
              <div className="bg-yellow-900/30 border border-yellow-800 rounded-lg px-4 py-3 text-sm text-yellow-300 space-y-2">
                <p>This will regenerate all {scan?.total} thumbnails, including existing ones. Continue?</p>
                <div className="flex gap-2">
                  <button
                    onClick={handleStart}
                    className="bg-yellow-600 hover:bg-yellow-500 text-white px-3 py-1 rounded text-sm cursor-pointer"
                  >
                    Yes, regenerate all
                  </button>
                  <button
                    onClick={() => setConfirmOverride(false)}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1 rounded text-sm cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {!confirmOverride && (
              <button
                onClick={handleStart}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg transition-colors cursor-pointer"
              >
                Start Generation
              </button>
            )}
          </div>
        )}

        {/* Progress */}
        {(phase === "generating" || phase === "stopped" || phase === "done") && progress && (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm text-gray-400">
                <span>{progress.current} / {progress.total}</span>
                <span>{pct}%</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    phase === "done" ? "bg-green-500" : phase === "stopped" ? "bg-yellow-500" : "bg-blue-500"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {phase === "generating" && progress.name && (
                <p className="text-xs text-gray-500 truncate">{progress.name}</p>
              )}
            </div>

            {phase === "generating" && (
              <button
                onClick={handleStop}
                className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg transition-colors cursor-pointer"
              >
                Stop
              </button>
            )}

            {(phase === "done" || phase === "stopped") && (
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
                <h2 className="text-sm font-medium text-gray-300">
                  {phase === "done" ? "Complete" : "Stopped"}
                </h2>
                <div className="grid grid-cols-3 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-bold text-green-400">{progress.generated}</div>
                    <div className="text-xs text-gray-500">Generated</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-gray-400">{progress.skipped}</div>
                    <div className="text-xs text-gray-500">Skipped</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-red-400">{progress.failed}</div>
                    <div className="text-xs text-gray-500">Failed</div>
                  </div>
                </div>
                <div className="pt-2 flex gap-2">
                  <button
                    onClick={handleScan}
                    className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded text-sm cursor-pointer"
                  >
                    Scan Again
                  </button>
                  <button
                    onClick={() => nav("/")}
                    className="bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded text-sm cursor-pointer"
                  >
                    Back to Browse
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
