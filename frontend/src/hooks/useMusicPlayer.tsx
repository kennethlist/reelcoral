import { createContext, useContext, useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { audioUrl, getConfig, saveUserPreferences, mediaUrl } from "../api";

export interface MusicTrack {
  name: string;
  path: string;
  albumName?: string;
  coverArt?: string;
}

interface MusicPlayerState {
  playlist: MusicTrack[];
  currentIndex: number;
  isPlaying: boolean;
  volume: number;
  isVisible: boolean;
  audioProfile: string;
  availableProfiles: { name: string; bitrate?: string }[];
}

interface MusicTimeState {
  currentTime: number;
  duration: number;
}

interface MusicPlayerActions {
  playAll: (tracks: MusicTrack[], startIndex?: number) => void;
  pause: () => void;
  resume: () => void;
  next: () => void;
  prev: () => void;
  seekTo: (time: number) => void;
  setVolume: (vol: number) => void;
  setAudioProfile: (profile: string) => void;
  dismiss: () => void;
}

type MusicPlayerContextType = MusicPlayerState & MusicPlayerActions;

const MusicPlayerContext = createContext<MusicPlayerContextType | null>(null);

// Separate context for fast-changing time values so timeupdate (~4x/s)
// only re-renders components that actually display time.
const MusicTimeContext = createContext<MusicTimeState | null>(null);

const VOLUME_KEY = "rc-music-volume";
const PROFILE_KEY = "rc-music-profile";

function loadVolume(): number {
  try {
    const v = localStorage.getItem(VOLUME_KEY);
    if (v !== null) {
      const parsed = parseFloat(v);
      if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
    }
  } catch {}
  return 1;
}

function loadProfile(): string {
  try {
    return localStorage.getItem(PROFILE_KEY) || "Original";
  } catch {
    return "Original";
  }
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playlist, setPlaylist] = useState<MusicTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(loadVolume);
  const [isVisible, setIsVisible] = useState(false);
  const [audioProfile, setAudioProfileState] = useState(loadProfile);
  const [availableProfiles, setAvailableProfiles] = useState<{ name: string; bitrate?: string }[]>([]);

  // Load available profiles from config
  useEffect(() => {
    getConfig()
      .then((cfg) => setAvailableProfiles(cfg.music_profiles || []))
      .catch(() => {});
  }, []);

  const currentTrack = playlist[currentIndex] || null;
  const prevSrcTrackRef = useRef<string | null>(null);

  // Update audio src when track or profile changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    const sameTrack = prevSrcTrackRef.current === currentTrack.path;
    prevSrcTrackRef.current = currentTrack.path;
    // If only the profile changed, preserve the playback position
    const resumeAt = sameTrack ? audio.currentTime : 0;
    const url = audioUrl(currentTrack.path, audioProfile);
    const wasPlaying = isPlaying;
    audio.src = url;
    audio.volume = volume;
    if (resumeAt > 0) {
      audio.addEventListener(
        "loadedmetadata",
        () => {
          audio.currentTime = resumeAt;
        },
        { once: true }
      );
    }
    if (wasPlaying) {
      audio.play().catch(() => {});
    }
  }, [currentTrack?.path, audioProfile]);

  // Sync volume
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  const ensureProfiles = useCallback(() => {
    if (availableProfiles.length === 0) {
      getConfig()
        .then((cfg) => setAvailableProfiles(cfg.music_profiles || []))
        .catch(() => {});
    }
  }, [availableProfiles.length]);

  const playAll = useCallback((tracks: MusicTrack[], startIndex = 0) => {
    ensureProfiles();
    setPlaylist(tracks);
    setCurrentIndex(startIndex);
    setIsVisible(true);
    setIsPlaying(true);
    setTimeout(() => {
      audioRef.current?.play().catch(() => {});
    }, 50);
  }, [ensureProfiles]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(() => {});
    setIsPlaying(true);
  }, []);

  const next = useCallback(() => {
    const nextIdx = currentIndex + 1;
    if (nextIdx >= playlist.length) {
      // Stop at end of playlist
      audioRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    setCurrentIndex(nextIdx);
    setIsPlaying(true);
    setTimeout(() => audioRef.current?.play().catch(() => {}), 50);
  }, [currentIndex, playlist.length]);

  const prev = useCallback(() => {
    const audio = audioRef.current;
    // If more than 3 seconds in, restart current track
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (currentIndex <= 0) {
      // Already at the first track: restart it without forcing playback
      if (audio) audio.currentTime = 0;
      return;
    }
    setCurrentIndex(currentIndex - 1);
    setIsPlaying(true);
    setTimeout(() => audioRef.current?.play().catch(() => {}), 50);
  }, [currentIndex]);

  const seekTo = useCallback((time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time;
  }, []);

  const setVolume = useCallback((vol: number) => {
    setVolumeState(vol);
    try {
      localStorage.setItem(VOLUME_KEY, String(vol));
    } catch {}
    saveUserPreferences({ music_volume: vol }).catch(() => {});
  }, []);

  const setAudioProfile = useCallback((profile: string) => {
    setAudioProfileState(profile);
    try {
      localStorage.setItem(PROFILE_KEY, profile);
    } catch {}
    saveUserPreferences({ music_profile: profile }).catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    prevSrcTrackRef.current = null;
    setIsPlaying(false);
    setIsVisible(false);
    setPlaylist([]);
    setCurrentIndex(0);
    setCurrentTime(0);
    setDuration(0);
  }, []);

  // MediaSession API — enables background audio & lock screen controls
  useEffect(() => {
    if (!("mediaSession" in navigator) || !currentTrack) return;

    const trackName = currentTrack.name.replace(/\.[^/.]+$/, "");
    const artworkList: MediaImage[] = currentTrack.coverArt
      ? [{ src: mediaUrl(currentTrack.coverArt), sizes: "512x512", type: "image/jpeg" }]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: trackName,
      artist: currentTrack.albumName || "",
      artwork: artworkList,
    });

    navigator.mediaSession.setActionHandler("play", () => {
      audioRef.current?.play().catch(() => {});
      setIsPlaying(true);
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      audioRef.current?.pause();
      setIsPlaying(false);
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => next());
    navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime != null && audioRef.current) {
        audioRef.current.currentTime = details.seekTime;
      }
    });

    return () => {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("seekto", null);
    };
  }, [currentTrack?.path, currentTrack?.name, currentTrack?.albumName, currentTrack?.coverArt, next, prev]);

  // MediaSession playback state
  useEffect(() => {
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
    }
  }, [isPlaying]);

  // MediaSession position state
  useEffect(() => {
    if ("mediaSession" in navigator && duration > 0 && isFinite(duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.min(currentTime, duration),
          playbackRate: 1,
        });
      } catch {}
    }
  }, [currentTime, duration]);

  // Auto-advance to the next track when one ends
  const handleEnded = useCallback(() => {
    const nextIdx = currentIndex + 1;
    if (nextIdx < playlist.length) {
      setCurrentIndex(nextIdx);
      setTimeout(() => audioRef.current?.play().catch(() => {}), 50);
    } else {
      setIsPlaying(false);
    }
  }, [currentIndex, playlist.length]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  }, []);

  const handleDurationChange = useCallback(() => {
    if (audioRef.current) setDuration(audioRef.current.duration || 0);
  }, []);

  const contextValue = useMemo<MusicPlayerContextType>(
    () => ({
      playlist,
      currentIndex,
      isPlaying,
      volume,
      isVisible,
      audioProfile,
      availableProfiles,
      playAll,
      pause,
      resume,
      next,
      prev,
      seekTo,
      setVolume,
      setAudioProfile,
      dismiss,
    }),
    [
      playlist,
      currentIndex,
      isPlaying,
      volume,
      isVisible,
      audioProfile,
      availableProfiles,
      playAll,
      pause,
      resume,
      next,
      prev,
      seekTo,
      setVolume,
      setAudioProfile,
      dismiss,
    ]
  );

  const timeValue = useMemo<MusicTimeState>(() => ({ currentTime, duration }), [currentTime, duration]);

  return (
    <MusicPlayerContext.Provider value={contextValue}>
      <MusicTimeContext.Provider value={timeValue}>
        {children}
        <audio
          ref={audioRef}
          onEnded={handleEnded}
          onTimeUpdate={handleTimeUpdate}
          onDurationChange={handleDurationChange}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          preload="auto"
          style={{ display: "none" }}
        />
      </MusicTimeContext.Provider>
    </MusicPlayerContext.Provider>
  );
}

export function useMusicPlayer(): MusicPlayerContextType {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) throw new Error("useMusicPlayer must be used within MusicPlayerProvider");
  return ctx;
}

export function useMusicTime(): MusicTimeState {
  const ctx = useContext(MusicTimeContext);
  if (!ctx) throw new Error("useMusicTime must be used within MusicPlayerProvider");
  return ctx;
}
