import { useState, useEffect, useCallback, useRef } from "react";
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
  /** Paginate the root folder. Off by default: the root lists every item. */
  root_pagination: boolean;
  image_max_width: number;
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
  root_pagination: false,
  image_max_width: 0,
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
  const prefsRef = useRef(prefs);
  // Keys the user changed locally since mount; these win over the async load
  const dirtyKeysRef = useRef<Set<keyof Preferences>>(new Set());

  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  useEffect(() => {
    // Apply a loaded preference set, but keep any keys the user changed in the meantime
    const applyLoaded = (loaded: Preferences): Preferences => {
      const result = { ...loaded };
      for (const key of dirtyKeysRef.current) {
        (result as Record<string, unknown>)[key] = prefsRef.current[key];
      }
      setPrefsState(result);
      return result;
    };

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
          root_pagination: cfg.defaults.root_pagination ?? false,
          image_max_width: 0,
        };
        // Load from localStorage over server defaults
        const localPrefs = load(serverDefaults);

        // Now fetch server-saved preferences and merge (server wins over localStorage)
        getUserPreferences()
          .then((serverPrefs) => {
            if (serverPrefs && Object.keys(serverPrefs).length > 0) {
              const merged = applyLoaded({ ...localPrefs, ...serverPrefs } as Preferences);
              try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
              } catch {}
            } else {
              applyLoaded(localPrefs);
            }
          })
          .catch(() => {
            applyLoaded(localPrefs);
          });
      })
      .catch(() => {});
  }, []);

  const setPrefs = useCallback((update: Partial<Preferences>) => {
    const next = { ...prefsRef.current, ...update };
    prefsRef.current = next;
    for (const key of Object.keys(update)) {
      dirtyKeysRef.current.add(key as keyof Preferences);
    }
    setPrefsState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
    // Fire-and-forget save to server
    saveUserPreferences(next).catch(() => {});
  }, []);

  return { prefs, setPrefs };
}
