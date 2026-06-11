import os
import json
import hashlib
import threading
from flask import Blueprint, request, jsonify, current_app, session
import db
from thumbnail import cache_path_for, _resolve_thumb_target, _migrate_legacy, CACHE_DIR as THUMB_CACHE_DIR

browse_bp = Blueprint("browse", __name__)

# In-memory dir→thumbnail-hash index, persisted to disk as a cache.
# Loaded once and written atomically: the old per-request load/modify/write
# cycle raced with itself, losing entries or truncating the file.
_DIR_INDEX_FILE = os.path.join(THUMB_CACHE_DIR, "dir_thumb_index.json")
_dir_index = None
_dir_index_lock = threading.Lock()


def _get_dir_index():
    global _dir_index
    with _dir_index_lock:
        if _dir_index is None:
            data = {}
            if os.path.exists(_DIR_INDEX_FILE):
                try:
                    with open(_DIR_INDEX_FILE) as f:
                        data = json.load(f)
                except Exception:
                    data = {}
            _dir_index = data
        return _dir_index


def _persist_dir_index():
    with _dir_index_lock:
        if _dir_index is None:
            return
        try:
            os.makedirs(os.path.dirname(_DIR_INDEX_FILE), exist_ok=True)
            tmp = _DIR_INDEX_FILE + ".tmp"
            with open(tmp, "w") as f:
                json.dump(_dir_index, f)
            os.rename(tmp, _DIR_INDEX_FILE)
        except OSError:
            pass

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
AUDIO_EXTS = {".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".wma", ".opus"}
EBOOK_EXTS = {".epub", ".pdf"}
COMIC_EXTS = {".cbr", ".cbz", ".zip"}
MARKDOWN_EXTS = {".md"}
COVER_ART_NAMES = {"cover.jpg", "folder.jpg", "front.jpg", "album.jpg", "art.jpg",
                   "cover.png", "folder.png", "front.png", "album.png", "art.png"}


def _find_cover_art_in(abs_dir, rel_dir):
    """Find cover art image in a directory, return its relative path or None."""
    try:
        for name in os.listdir(abs_dir):
            if name.lower() in COVER_ART_NAMES:
                return os.path.join("/", rel_dir, name) if rel_dir else "/" + name
    except OSError:
        pass
    return None


def _dir_has_audio(abs_dir):
    """Check if a directory directly contains any audio files."""
    try:
        for name in os.listdir(abs_dir):
            if os.path.splitext(name)[1].lower() in AUDIO_EXTS:
                return True
    except OSError:
        pass
    return False


def _find_cover_art(abs_dir, parent_rel, dir_name):
    """Find cover art in a subdirectory, return its relative path or None."""
    sub_rel = os.path.join(parent_rel, dir_name) if parent_rel else dir_name
    return _find_cover_art_in(abs_dir, sub_rel)



@browse_bp.route("/browse")
def browse():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))

    rel_path = request.args.get("path", "/").lstrip("/")
    page = max(1, request.args.get("page", 1, type=int) or 1)
    raw_limit = request.args.get("limit", 50, type=int)
    if raw_limit is None:
        raw_limit = 50
    limit = 0 if raw_limit == 0 else min(200, max(1, raw_limit))
    search = request.args.get("search", "").lower().strip()
    letter = request.args.get("letter", "").strip()
    sort = request.args.get("sort", "alpha").strip().lower()
    sort_dir = request.args.get("dir", "asc").strip().lower()
    lite = request.args.get("lite", "0") == "1"

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    real_root_check = os.path.realpath(root)
    if abs_path != real_root_check and not abs_path.startswith(real_root_check + os.sep):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isdir(abs_path):
        return jsonify({"error": "not found"}), 404

    # Determine if we're in a music folder context
    music_folders = config["media"].get("music_folders", [])
    is_music_context = False
    music_depth = 0
    check_rel = "/" + rel_path if rel_path else "/"
    for mf in music_folders:
        mf_clean = mf.rstrip("/")
        if check_rel == mf_clean or check_rel.startswith(mf_clean + "/"):
            is_music_context = True
            # Calculate depth below the music root
            # /music -> 0, /music/Artist -> 1, /music/Artist/Album -> 2
            suffix = check_rel[len(mf_clean):]
            music_depth = len([p for p in suffix.split("/") if p])
            break

    entries = []
    has_audio_files = False
    # scandir caches stat results on the DirEntry — the old listdir +
    # isdir/getsize/getmtime pattern cost 3-4 syscalls per entry.
    try:
        with os.scandir(abs_path) as it:
            dirents = sorted(it, key=lambda d: d.name.lower())
    except PermissionError:
        return jsonify({"error": "permission denied"}), 403
    except OSError:
        return jsonify({"error": "not found"}), 404

    for de in dirents:
        name = de.name
        if name.startswith("."):
            continue
        try:
            is_dir = de.is_dir()
        except OSError:
            continue
        full = de.path
        ext = os.path.splitext(name)[1].lower()

        if not is_dir and ext not in extensions:
            continue
        if search and search not in name.lower():
            continue

        entry_path = os.path.join("/", rel_path, name) if rel_path else "/" + name
        entry = {
            "name": name,
            "path": entry_path,
            "is_dir": is_dir,
            "_abs": full,
        }
        stat_result = None
        if not lite:
            try:
                stat_result = de.stat()
            except OSError:
                pass
        if not is_dir:
            entry["is_image"] = ext in IMAGE_EXTS
            entry["is_audio"] = ext in AUDIO_EXTS
            entry["is_ebook"] = ext in EBOOK_EXTS
            entry["is_comic"] = ext in COMIC_EXTS
            entry["is_markdown"] = ext in MARKDOWN_EXTS
            if ext in AUDIO_EXTS:
                has_audio_files = True
            if not lite:
                entry["size"] = stat_result.st_size if stat_result else 0
        if not lite:
            entry["mtime"] = stat_result.st_mtime if stat_result else 0
        entries.append(entry)

    # Determine if this is an album-level folder (contains audio files)
    is_music_folder = is_music_context and has_audio_files

    # Find cover art for the current directory if it's a music folder
    dir_cover_art = None
    if is_music_folder:
        dir_cover_art = _find_cover_art_in(abs_path, rel_path)

    # Sort: directories first, then files sorted by chosen mode and direction
    # In lite mode, force alphabetical sort (no mtime/size available)
    if lite and sort in ("newest", "largest", "recent"):
        sort = "alpha"
    reverse = sort_dir == "desc"
    if sort == "recent":
        user_id = session.get("user", "anonymous")
        recent_map = db.get_recent_files(user_id)
        # Split into accessed and not-accessed, then combine
        accessed = [e for e in entries if e.get("path") in recent_map or (not e["is_dir"] and e.get("path") in recent_map)]
        not_accessed = [e for e in entries if e.get("path") not in recent_map]
        accessed.sort(key=lambda e: recent_map.get(e.get("path", ""), ""), reverse=not reverse)
        not_accessed.sort(key=lambda e: e["name"].lower())
        entries = accessed + not_accessed if not reverse else not_accessed + accessed
    elif sort == "newest":
        entries.sort(key=lambda e: e.get("mtime", 0), reverse=reverse)
    elif sort == "largest":
        entries.sort(key=lambda e: e.get("size", 0), reverse=reverse)
    else:
        dirs = [e for e in entries if e["is_dir"]]
        files = [e for e in entries if not e["is_dir"]]
        dirs.sort(key=lambda e: e["name"].lower(), reverse=reverse)
        files.sort(key=lambda e: e["name"].lower(), reverse=reverse)
        entries = dirs + files

    # Collect available letters from ALL entries (after search, before letter filter)
    letters = set()
    for e in entries:
        first = e["name"][0].upper() if e["name"] else ""
        if first and not first.isalpha():
            letters.add("#")
        elif first:
            letters.add(first)

    # Apply letter filter BEFORE pagination so total reflects filtered count
    if letter:
        if letter == "#":
            entries = [e for e in entries if e["name"] and not e["name"][0].isalpha()]
        else:
            entries = [e for e in entries if e["name"] and e["name"][0].upper() == letter.upper()]

    total = len(entries)
    dir_count = sum(1 for e in entries if e["is_dir"])
    file_count = total - dir_count
    if limit == 0:
        page_entries = entries
    else:
        start = (page - 1) * limit
        page_entries = entries[start : start + limit]

    # Music context: cover art + album detection scan subdirectories
    # (1-2 listdir calls each), so only do it for the visible page —
    # doing it for every entry made artist indexes O(dirs) per request.
    if is_music_context and not lite:
        for e in page_entries:
            if not e["is_dir"]:
                continue
            cover = _find_cover_art(e["_abs"], rel_path, e["name"])
            if cover:
                e["cover_art"] = cover
            # Only mark as album at depth >= 1 (inside an artist folder)
            # At depth 0 (music root), subdirectories are artists, not albums
            if music_depth >= 1 and _dir_has_audio(e["_abs"]):
                e["is_album"] = True

    # Attach file_status to page entries (skip in lite mode)
    if not lite:
        user_id = session.get("user", "anonymous")
        file_paths = [e["path"] for e in page_entries if not e["is_dir"]]
        if file_paths:
            statuses = db.get_file_statuses(user_id, file_paths)
            for e in page_entries:
                if e["path"] in statuses:
                    e["file_status"] = statuses[e["path"]]
        # Bubble up: dirs show "opened" if any descendant file has a status.
        # Skip when listing root so top-level dirs don't always end up marked.
        if rel_path:
            dir_paths = [e["path"] for e in page_entries if e["is_dir"]]
            if dir_paths:
                bubbled = db.get_dirs_with_descendant_status(user_id, dir_paths)
                for e in page_entries:
                    if e["is_dir"] and e["path"] in bubbled:
                        e["file_status"] = "opened"

    # Resolve thumbnail hashes for page entries (skip music context and lite mode)
    thumbnails = {}
    if not is_music_context and not lite:
        # Load overrides once
        overrides = {}
        overrides_file = os.path.join(os.path.dirname(THUMB_CACHE_DIR), "thumbnail_overrides.json")
        if os.path.exists(overrides_file):
            try:
                with open(overrides_file) as f:
                    overrides = json.load(f)
            except Exception:
                pass
        # Dir→hash index for fast directory thumbnail lookups (in-memory,
        # persisted as a disk cache)
        dir_index = _get_dir_index()
        dir_index_dirty = False
        real_root = os.path.realpath(root)
        for e in page_entries:
            if e.get("is_audio") or e.get("is_markdown"):
                continue
            path = e["path"]
            abs_entry = e["_abs"]
            # Check override first
            override_hash = overrides.get(path)
            if override_hash:
                override_cache = cache_path_for(override_hash)
                if os.path.exists(override_cache):
                    thumbnails[path] = {"hash": override_hash, "cached": True}
                    continue
            if not e["is_dir"]:
                # Files: hash directly from absolute path (fast, no scan needed)
                path_hash = hashlib.sha256(abs_entry.encode()).hexdigest()
                cp = _migrate_legacy(path_hash)
                thumbnails[path] = {"hash": path_hash, "cached": os.path.exists(cp)}
            else:
                # Directories: check index first to avoid expensive recursive scan
                if abs_entry in dir_index:
                    path_hash = dir_index[abs_entry]
                    cp = cache_path_for(path_hash)
                    if os.path.exists(cp):
                        thumbnails[path] = {"hash": path_hash, "cached": True}
                        continue
                # Fall back to full resolve (recursive scan)
                resolved = _resolve_thumb_target(root, real_root, path, extensions)
                if not resolved:
                    continue
                _target, path_hash, _is_image, _is_book = resolved
                cp = _migrate_legacy(path_hash)
                cached = os.path.exists(cp)
                thumbnails[path] = {"hash": path_hash, "cached": cached}
                # Cache the mapping so future requests skip the scan
                if cached:
                    dir_index[abs_entry] = path_hash
                    dir_index_dirty = True
        # Persist updated dir index
        if dir_index_dirty:
            _persist_dir_index()

    # Strip internal fields before response
    for e in page_entries:
        e.pop("_abs", None)

    # Build breadcrumbs
    parts = [p for p in rel_path.split("/") if p]
    breadcrumbs = [{"name": "Home", "path": "/"}]
    for i, part in enumerate(parts):
        breadcrumbs.append({
            "name": part,
            "path": "/" + "/".join(parts[: i + 1]),
        })

    result = {
        "entries": page_entries,
        "total": total,
        "dir_count": dir_count,
        "file_count": file_count,
        "page": page,
        "limit": limit,
        "breadcrumbs": breadcrumbs,
        "letters": sorted(letters),
        "thumbnails": thumbnails,
    }
    if is_music_context:
        result["is_music_context"] = True
    if is_music_folder:
        result["is_music_folder"] = True
    if dir_cover_art:
        result["cover_art"] = dir_cover_art

    return jsonify(result)
