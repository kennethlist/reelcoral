import { useState, useEffect, useCallback } from "react";
import { getConfig, getUserPreferences, saveUserPreferences } from "../api";

export type SubtitleFontSize = "small" | "medium" | "large" | "extra-large";

export interface Preferences {
  preferred_audio_lang: string;
  preferred_subtitle_lang: string;
  preferred_profile: string;
  subtitles_enabled: boolean;
  subtitle_mode: "burn" | "external";
  subtitle_font_size: SubtitleFontSize;
  thumbnail_candidates: 3 | 6 | 9;
  grid_size: "small" | "large";
  page_size: number;
  music_volume?: number;
  music_profile?: string;
}

const STORAGE_KEY = "media_preferences";

const hardcodedDefaults: Preferences = {
  preferred_audio_lang: "eng",
  preferred_subtitle_lang: "eng",
  preferred_profile: "720p",
  subtitles_enabled: true,
  subtitle_mode: "external",
  subtitle_font_size: "medium",
  thumbnail_candidates: 3,
  grid_size: "small",
  page_size: 12,
};

function load(defaults: Preferences): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {}
  return { ...defaults };
}

export function usePreferences() {
  const [prefs, setPrefsState] = useState<Preferences>(() => load(hardcodedDefaults));

  useEffect(() => {
    // Load server defaults from config, then overlay server-saved preferences
    getConfig()
      .then((cfg) => {
        const serverDefaults: Preferences = {
          preferred_profile: cfg.defaults.quality,
          preferred_audio_lang: cfg.defaults.audio_lang,
          preferred_subtitle_lang: cfg.defaults.subtitle_lang,
          subtitles_enabled: cfg.defaults.subtitles_enabled,
          subtitle_mode: cfg.defaults.subtitle_mode as "burn" | "external",
          subtitle_font_size: "medium",
          thumbnail_candidates: (cfg.defaults.thumbnail_candidates || 3) as 3 | 6 | 9,
          grid_size: (cfg.defaults.grid_size || "small") as "small" | "large",
          page_size: cfg.defaults.page_size || 12,
        };
        // Load from localStorage over server defaults
        const localPrefs = load(serverDefaults);

        // Now fetch server-saved preferences and merge (server wins over localStorage)
        getUserPreferences()
          .then((serverPrefs) => {
            if (serverPrefs && Object.keys(serverPrefs).length > 0) {
              const merged = { ...localPrefs, ...serverPrefs } as Preferences;
              setPrefsState(merged);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
            } else {
              setPrefsState(localPrefs);
            }
          })
          .catch(() => {
            setPrefsState(localPrefs);
          });
      })
      .catch(() => {});
  }, []);

  const setPrefs = useCallback((update: Partial<Preferences>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...update };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      // Fire-and-forget save to server
      saveUserPreferences(next).catch(() => {});
      return next;
    });
  }, []);

  return { prefs, setPrefs };
}
