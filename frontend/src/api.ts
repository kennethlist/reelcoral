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
  is_audio?: boolean;
  is_ebook?: boolean;
  is_comic?: boolean;
  is_markdown?: boolean;
  is_album?: boolean;
  cover_art?: string;
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
  is_music_context?: boolean;
  is_music_folder?: boolean;
  cover_art?: string;
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
  path: string,
  count?: number
): Promise<{ candidates: (string | null)[] }> {
  const params = new URLSearchParams({ path, _t: String(Date.now()) });
  if (count) params.set("count", String(count));
  const res = await fetch(`/api/thumbnail/candidates?${params}`);
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

export interface AppConfig {
  generate_on_fly: boolean;
  profiles: { name: string; video_bitrate?: string }[];
  defaults: {
    quality: string;
    audio_lang: string;
    subtitle_lang: string;
    subtitles_enabled: boolean;
    subtitle_mode: string;
    thumbnail_candidates: number;
    grid_size: string;
  };
  music_folders: string[];
  music_profiles: { name: string; bitrate?: string }[];
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Config fetch failed");
  return res.json();
}

export function audioUrl(path: string, profile = "Original"): string {
  return `/api/audio?path=${encodeURIComponent(path)}&profile=${encodeURIComponent(profile)}`;
}

// Ebook API
export interface EbookInfo {
  title: string;
  author: string;
  chapters: { id: string; title: string }[];
  chapter_count: number;
  toc: { title: string; href: string }[];
}

export async function getEbookInfo(path: string): Promise<EbookInfo> {
  const res = await fetch(`/api/ebook/info?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Ebook info failed");
  return res.json();
}

export async function getEbookChapter(path: string, index: number): Promise<{ html: string; index: number }> {
  const res = await fetch(`/api/ebook/chapter?path=${encodeURIComponent(path)}&index=${index}`);
  if (!res.ok) throw new Error("Ebook chapter failed");
  return res.json();
}

export function ebookCoverUrl(path: string): string {
  return `/api/ebook/cover?path=${encodeURIComponent(path)}`;
}

// Comic API
export interface ComicInfo {
  page_count: number;
}

export async function getComicInfo(path: string): Promise<ComicInfo> {
  const res = await fetch(`/api/comic/info?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Comic info failed");
  return res.json();
}

export function comicPageUrl(path: string, page: number): string {
  return `/api/comic/page?path=${encodeURIComponent(path)}&page=${page}`;
}

// PDF API
export interface PdfInfo {
  page_count: number;
  title: string;
  author: string;
}

export async function getPdfInfo(path: string): Promise<PdfInfo> {
  const res = await fetch(`/api/pdf/info?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("PDF info failed");
  return res.json();
}

export function pdfPageUrl(path: string, page: number, fit = "width", width = 1200, height = 1600): string {
  return `/api/pdf/page?path=${encodeURIComponent(path)}&page=${page}&fit=${fit}&width=${width}&height=${height}`;
}

// Markdown API
export async function getMarkdownContent(path: string): Promise<{ html: string }> {
  const res = await fetch(`/api/markdown/content?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error("Markdown content failed");
  return res.json();
}

// Download API
export function downloadUrl(path: string): string {
  return `/api/download?path=${encodeURIComponent(path)}`;
}

