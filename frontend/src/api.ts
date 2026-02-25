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
  size?: number;
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
}

export async function browse(
  path: string,
  page = 1,
  limit = 50,
  search = ""
): Promise<BrowseResult> {
  const params = new URLSearchParams({ path, page: String(page), limit: String(limit) });
  if (search) params.set("search", search);
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

export interface MediaInfo {
  duration: number;
  video_tracks: VideoTrack[];
  audio_tracks: AudioTrack[];
  subtitle_tracks: SubtitleTrack[];
  profiles: string[];
}

export async function getMediaInfo(path: string): Promise<MediaInfo> {
  const res = await fetch(`/api/media/info?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Info failed");
  return res.json();
}

export interface StreamSession {
  session_id: string;
  playlist: string;
}

export async function startStream(
  path: string,
  profile: string,
  audioIdx: number,
  start = 0
): Promise<StreamSession> {
  const params = new URLSearchParams({
    path,
    profile,
    audio: String(audioIdx),
    start: String(start),
  });
  const res = await fetch(`/api/stream/start?${params}`);
  if (!res.ok) throw new Error("Stream start failed");
  return res.json();
}

export async function stopStream(sessionId: string): Promise<void> {
  await fetch(`/api/stream/${sessionId}`, { method: "DELETE" });
}
