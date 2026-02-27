import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getConfig, AppConfig } from "../api";
import { usePreferences } from "../hooks/usePreferences";
import { languageList } from "../utils/languages";

export default function Preferences() {
  const nav = useNavigate();
  const { prefs, setPrefs } = usePreferences();
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    getConfig().then(setConfig).catch(() => {});
  }, []);

  const profiles = config?.profiles ?? [];
  const subtitleValue = prefs.subtitles_enabled ? prefs.preferred_subtitle_lang : "off";

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
          <h1 className="text-lg font-medium">Preferences</h1>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8 space-y-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400 shrink-0">Quality</span>
            <select
              value={prefs.preferred_profile}
              onChange={(e) => setPrefs({ preferred_profile: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {[...profiles]
                .sort((a, b) => (a.name === "original" ? -1 : b.name === "original" ? 1 : 0))
                .map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name === "original" ? "Original" : p.name}{p.video_bitrate ? ` (${p.video_bitrate})` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400 shrink-0">Audio</span>
            <select
              value={prefs.preferred_audio_lang}
              onChange={(e) => setPrefs({ preferred_audio_lang: e.target.value })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              {languageList.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400 shrink-0">Subtitles</span>
            <select
              value={subtitleValue}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "off") {
                  setPrefs({ subtitles_enabled: false });
                } else {
                  setPrefs({ subtitles_enabled: true, preferred_subtitle_lang: v });
                }
              }}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="off">Off</option>
              {languageList.map((l) => (
                <option key={l.code} value={l.code}>{l.name}</option>
              ))}
            </select>
          </div>

          {prefs.subtitles_enabled && (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-400 shrink-0">Subtitle Mode</span>
                <select
                  value={prefs.subtitle_mode}
                  onChange={(e) => setPrefs({ subtitle_mode: e.target.value as "burn" | "external" })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="external">External</option>
                  <option value="burn">Burn-in</option>
                </select>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-400 shrink-0">Subtitle Size</span>
                <select
                  value={prefs.subtitle_font_size}
                  onChange={(e) => setPrefs({ subtitle_font_size: e.target.value as any })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                  <option value="extra-large">Extra Large</option>
                </select>
              </div>
            </>
          )}
        </div>

        <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide pt-4">Browse</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400 shrink-0">Thumbnail Candidates</span>
            <select
              value={prefs.thumbnail_candidates}
              onChange={(e) => setPrefs({ thumbnail_candidates: Number(e.target.value) as 3 | 6 | 9 })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value={3}>3</option>
              <option value={6}>6</option>
              <option value={9}>9</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-gray-400 shrink-0">Grid Size</span>
            <select
              value={prefs.grid_size}
              onChange={(e) => setPrefs({ grid_size: e.target.value as "small" | "large" })}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="small">Small (more columns)</option>
              <option value="large">Large (fewer columns)</option>
            </select>
          </div>
        </div>
      </main>
    </div>
  );
}
