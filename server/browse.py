import os
from flask import Blueprint, request, jsonify, current_app

browse_bp = Blueprint("browse", __name__)

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
AUDIO_EXTS = {".mp3", ".flac", ".ogg", ".wav", ".m4a", ".aac", ".wma", ".opus"}
EBOOK_EXTS = {".epub", ".pdf"}
COMIC_EXTS = {".cbr", ".cbz"}
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
    page = max(1, int(request.args.get("page", 1)))
    limit = min(200, max(1, int(request.args.get("limit", 50))))
    search = request.args.get("search", "").lower().strip()
    letter = request.args.get("letter", "").strip()
    sort = request.args.get("sort", "alpha").strip().lower()
    sort_dir = request.args.get("dir", "asc").strip().lower()

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    if not abs_path.startswith(os.path.realpath(root)):
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
    try:
        items = sorted(os.listdir(abs_path), key=str.lower)
    except PermissionError:
        return jsonify({"error": "permission denied"}), 403

    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(abs_path, name)
        is_dir = os.path.isdir(full)
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
        }
        if not is_dir:
            entry["is_image"] = ext in IMAGE_EXTS
            entry["is_audio"] = ext in AUDIO_EXTS
            entry["is_ebook"] = ext in EBOOK_EXTS
            entry["is_comic"] = ext in COMIC_EXTS
            entry["is_markdown"] = ext in MARKDOWN_EXTS
            if ext in AUDIO_EXTS:
                has_audio_files = True
            try:
                entry["size"] = os.path.getsize(full)
            except OSError:
                entry["size"] = 0
        else:
            # For subdirectories in music context, scan for cover art and detect albums
            if is_music_context:
                cover = _find_cover_art(full, rel_path, name)
                if cover:
                    entry["cover_art"] = cover
                # Only mark as album at depth >= 1 (inside an artist folder)
                # At depth 0 (music root), subdirectories are artists, not albums
                if music_depth >= 1 and _dir_has_audio(full):
                    entry["is_album"] = True
        try:
            entry["mtime"] = os.path.getmtime(full)
        except OSError:
            entry["mtime"] = 0
        entries.append(entry)

    # Determine if this is an album-level folder (contains audio files)
    is_music_folder = is_music_context and has_audio_files

    # Find cover art for the current directory if it's a music folder
    dir_cover_art = None
    if is_music_folder:
        dir_cover_art = _find_cover_art_in(abs_path, rel_path)

    # Sort: directories first, then files sorted by chosen mode and direction
    reverse = sort_dir == "desc"
    if sort == "newest":
        dirs = [e for e in entries if e["is_dir"]]
        files = [e for e in entries if not e["is_dir"]]
        files.sort(key=lambda e: e.get("mtime", 0), reverse=reverse)
        entries = dirs + files
    elif sort == "largest":
        dirs = [e for e in entries if e["is_dir"]]
        files = [e for e in entries if not e["is_dir"]]
        files.sort(key=lambda e: e.get("size", 0), reverse=reverse)
        entries = dirs + files
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
    start = (page - 1) * limit
    page_entries = entries[start : start + limit]

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
        "page": page,
        "limit": limit,
        "breadcrumbs": breadcrumbs,
        "letters": sorted(letters),
    }
    if is_music_context:
        result["is_music_context"] = True
    if is_music_folder:
        result["is_music_folder"] = True
    if dir_cover_art:
        result["cover_art"] = dir_cover_art

    return jsonify(result)
