import { useState, useCallback } from "react";

export interface Preferences {
  preferred_audio_lang: string;
  preferred_subtitle_lang: string;
  preferred_profile: string;
  subtitles_enabled: boolean;
}

const STORAGE_KEY = "kmc_preferences";

const defaults: Preferences = {
  preferred_audio_lang: "eng",
  preferred_subtitle_lang: "eng",
  preferred_profile: "720p",
  subtitles_enabled: true,
};

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {}
  return { ...defaults };
}

export function usePreferences() {
  const [prefs, setPrefsState] = useState<Preferences>(load);

  const setPrefs = useCallback((update: Partial<Preferences>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...update };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { prefs, setPrefs };
}
