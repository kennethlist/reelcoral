export async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/check");
    return res.ok;
  } catch {
    return false;
  }
}

export async function login(username: string, password: string): Promise<boolean> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return res.ok;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export interface BrowseEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_image?: boolean;
  size?: number;
  mtime?: number;
}

export interface Breadcrumb {
  name: string;
  path: string;
}

export interface BrowseResult {
  entries: BrowseEntry[];
  total: number;
  page: number;
  limit: number;
  breadcrumbs: Breadcrumb[];
  letters: string[];
}

export async function browse(
  path: string,
  page = 1,
  limit = 50,
  search = "",
  letter?: string,
  sort?: string,
  sortDir?: string
): Promise<BrowseResult> {
  const params = new URLSearchParams({ path, page: String(page), limit: String(limit) });
  if (search) params.set("search", search);
  if (letter) params.set("letter", letter);
  if (sort && sort !== "alpha") params.set("sort", sort);
  if (sortDir && sortDir !== "asc") params.set("dir", sortDir);
  const res = await fetch(`/api/browse?${params}`);
  if (!res.ok) throw new Error("Browse failed");
  return res.json();
}

export interface Track {
  index: number;
  codec: string;
  lang: string;
  title: string;
}

export interface AudioTrack extends Track {
  channels: number;
}

export interface SubtitleTrack extends Track {
  bitmap: boolean;
}

export interface VideoTrack extends Track {
  width: number;
  height: number;
}

export interface Profile {
  name: string;
  video_bitrate?: string;
}

export interface MediaInfo {
  duration: number;
  video_tracks: VideoTrack[];
  audio_tracks: AudioTrack[];
  subtitle_tracks: SubtitleTrack[];
  profiles: Profile[];
}

export async function getMediaInfo(path: string): Promise<MediaInfo> {
  const res = await fetch(`/api/media/info?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Info failed");
  return res.json();
}

export interface StreamSession {
  session_id: string;
  playlist: string;
  media_info?: MediaInfo;
  actual_start?: number;
}

export async function startStream(
  path: string,
  profile: string,
  audioIdx: number,
  start = 0,
  subIdx?: number | null,
  replace?: string | null
): Promise<StreamSession> {
  const params = new URLSearchParams({
    path,
    profile,
    audio: String(audioIdx),
    start: String(start),
  });
  if (subIdx != null) params.set("sub", String(subIdx));
  if (replace) params.set("replace", replace);
  const res = await fetch(`/api/stream/start?${params}`);
  if (!res.ok) throw new Error("Stream start failed");
  return res.json();
}

export async function stopStream(sessionId: string): Promise<void> {
  await fetch(`/api/stream/${sessionId}`, { method: "DELETE" });
}

export async function getThumbnailCandidates(
  path: string
): Promise<{ candidates: (string | null)[] }> {
  const res = await fetch(
    `/api/thumbnail/candidates?path=${encodeURIComponent(path)}&_t=${Date.now()}`
  );
  if (!res.ok) throw new Error("Failed to get candidates");
  return res.json();
}

export async function selectThumbnailCandidate(
  path: string,
  index: number
): Promise<void> {
  const res = await fetch("/api/thumbnail/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, index }),
  });
  if (!res.ok) throw new Error("Failed to select candidate");
}

export async function uploadCustomThumbnail(
  path: string,
  image: File
): Promise<void> {
  const form = new FormData();
  form.append("path", path);
  form.append("image", image);
  const res = await fetch("/api/thumbnail/select", {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Failed to upload thumbnail");
}

export async function resetThumbnail(path: string): Promise<void> {
  const res = await fetch(
    `/api/thumbnail/select?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error("Failed to reset thumbnail");
}

export interface ThumbnailScanResult {
  total: number;
  cached: number;
  missing: number;
}

export interface ThumbnailGenEvent {
  current: number;
  total: number;
  name: string;
  status: string;
  generated: number;
  skipped: number;
  failed: number;
}

export async function scanThumbnails(): Promise<ThumbnailScanResult> {
  const res = await fetch("/api/thumbnails/scan");
  if (!res.ok) throw new Error("Scan failed");
  return res.json();
}

export function startThumbnailGeneration(
  override: boolean,
  onEvent: (event: ThumbnailGenEvent) => void,
  onError: (err: string) => void
): EventSource {
  const es = new EventSource(`/api/thumbnails/generate?override=${override ? "1" : "0"}`);
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      onError("Failed to parse event");
    }
  };
  es.onerror = () => {
    es.close();
    onError("Connection lost");
  };
  return es;
}

export async function stopThumbnailGeneration(): Promise<void> {
  await fetch("/api/thumbnails/stop", { method: "POST" });
}

export async function getThumbnailStatus(): Promise<ThumbnailGenEvent & { running: boolean }> {
  const res = await fetch("/api/thumbnails/status");
  if (!res.ok) throw new Error("Status check failed");
  return res.json();
}

export function subscribeThumbnailProgress(
  onEvent: (event: ThumbnailGenEvent) => void,
  onError: (err: string) => void
): EventSource {
  const es = new EventSource("/api/thumbnails/progress");
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      onError("Failed to parse event");
    }
  };
  es.onerror = () => {
    es.close();
    onError("Connection lost");
  };
  return es;
}

export interface AppConfig {
  generate_on_fly: boolean;
  profiles: { name: string; video_bitrate?: string }[];
  defaults: {
    quality: string;
    audio_lang: string;
    subtitle_lang: string;
    subtitles_enabled: boolean;
    subtitle_mode: string;
  };
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Config fetch failed");
  return res.json();
}

export async function deleteAllThumbnails(): Promise<{ deleted: number; failed: number }> {
  const res = await fetch("/api/thumbnails/delete-all", { method: "POST" });
  if (!res.ok) throw new Error("Delete failed");
  return res.json();
}
