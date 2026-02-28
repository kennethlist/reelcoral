import os
import json
import hashlib
import subprocess
import warnings
import logging
from flask import Blueprint, request, current_app, send_file, jsonify
from probe import ffprobe

thumbnail_bp = Blueprint("thumbnail", __name__)
log = logging.getLogger(__name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
BOOK_EXTS = {".epub", ".pdf", ".cbr", ".cbz"}


def cache_path_for(path_hash):
    """Build a nested cache path from a hash: ab/cd/hash.jpg to avoid too many files per directory."""
    return os.path.join(CACHE_DIR, path_hash[:2], path_hash[2:4], f"{path_hash}.jpg")


def _find_first_media(dirpath, video_extensions, image_extensions=IMAGE_EXTS, depth=5):
    """Recursively find the first video or image file in a directory."""
    if depth <= 0:
        return None, False
    try:
        items = sorted(os.listdir(dirpath), key=str.lower)
    except (PermissionError, OSError):
        return None, False
    all_media_exts = video_extensions | image_extensions
    # Check files first
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        ext = os.path.splitext(name)[1].lower()
        if os.path.isfile(full) and ext in all_media_exts:
            return full, ext in image_extensions
    # Then recurse into directories
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        if os.path.isdir(full):
            result, is_img = _find_first_media(full, video_extensions, image_extensions, depth - 1)
            if result:
                return result, is_img
    return None, False


def _find_books(dirpath, depth=5):
    """Recursively yield book files in a directory."""
    if depth <= 0:
        return
    try:
        items = sorted(os.listdir(dirpath), key=str.lower)
    except (PermissionError, OSError):
        return
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        ext = os.path.splitext(name)[1].lower()
        if os.path.isfile(full) and ext in BOOK_EXTS:
            yield full
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        if os.path.isdir(full):
            yield from _find_books(full, depth - 1)


def _generate_book_thumbnail(book_path, cache_path):
    """Generate a thumbnail from a book file's cover/first page. Returns True on success."""
    ext = os.path.splitext(book_path)[1].lower()
    try:
        if ext == ".epub":
            return _generate_epub_thumbnail(book_path, cache_path)
        elif ext == ".pdf":
            return _generate_pdf_thumbnail(book_path, cache_path)
        elif ext in (".cbr", ".cbz"):
            return _generate_comic_thumbnail(book_path, cache_path)
    except Exception as e:
        log.warning("Book thumbnail generation failed for %s: %s", book_path, e)
    return False


def _resize_to_thumb(input_path, output_path):
    """Resize an image file to thumbnail width using ffmpeg."""
    cmd = [
        "ffmpeg", "-i", input_path,
        "-vf", "scale=320:-1",
        "-frames:v", "1",
        "-y", output_path,
    ]
    subprocess.run(cmd, capture_output=True, timeout=30)
    return os.path.exists(output_path)


def _generate_epub_thumbnail(epub_path, cache_path):
    import ebooklib
    from ebooklib import epub

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        book = epub.read_epub(epub_path)

    cover = None
    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover = item
        break
    if not cover:
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            if "cover" in item.get_name().lower():
                cover = item
                break
    if not cover:
        images = list(book.get_items_of_type(ebooklib.ITEM_IMAGE))
        if images:
            cover = images[0]
    if not cover:
        return False

    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "wb") as f:
        f.write(cover.get_content())
    try:
        return _resize_to_thumb(tmp_path, cache_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _generate_pdf_thumbnail(pdf_path, cache_path):
    import pymupdf
    doc = pymupdf.open(pdf_path)
    if doc.page_count == 0:
        doc.close()
        return False
    pg = doc[0]
    zoom = 320 / pg.rect.width
    zoom = max(0.5, min(zoom, 5.0))
    mat = pymupdf.Matrix(zoom, zoom)
    pix = pg.get_pixmap(matrix=mat)
    tmp_path = cache_path + ".tmp.png"
    pix.save(tmp_path)
    doc.close()
    try:
        return _resize_to_thumb(tmp_path, cache_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _generate_comic_thumbnail(comic_path, cache_path):
    import re
    import zipfile
    comic_image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

    def natural_sort_key(s):
        return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', s)]

    ext = os.path.splitext(comic_path)[1].lower()
    names = []
    data = None

    if ext == ".cbz":
        with zipfile.ZipFile(comic_path, "r") as zf:
            for name in zf.namelist():
                if os.path.splitext(name)[1].lower() in comic_image_exts and not os.path.basename(name).startswith("."):
                    names.append(name)
            names.sort(key=natural_sort_key)
            if not names:
                return False
            data = zf.read(names[0])
    elif ext == ".cbr":
        import rarfile
        with rarfile.RarFile(comic_path, "r") as rf:
            for name in rf.namelist():
                if os.path.splitext(name)[1].lower() in comic_image_exts and not os.path.basename(name).startswith("."):
                    names.append(name)
            names.sort(key=natural_sort_key)
            if not names:
                return False
            data = rf.read(names[0])

    if not data:
        return False

    tmp_path = cache_path + ".tmp"
    with open(tmp_path, "wb") as f:
        f.write(data)
    try:
        return _resize_to_thumb(tmp_path, cache_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@thumbnail_bp.route("/thumbnail")
def thumbnail():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))
    path = request.args.get("path", "")

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403

    # Check for a thumbnail override (keyed by browse path, not media file)
    overrides_file = os.path.join(os.path.dirname(CACHE_DIR), "thumbnail_overrides.json")
    if os.path.exists(overrides_file):
        with open(overrides_file) as f:
            overrides = json.load(f)
        override_hash = overrides.get(path)
        if override_hash:
            override_cache = cache_path_for(override_hash)
            if os.path.exists(override_cache):
                return send_file(override_cache, mimetype="image/jpeg")

    # For directories, find the first video or image file recursively
    is_image = False
    is_book = False
    is_dir = os.path.isdir(filepath)
    dir_for_books = filepath if is_dir else None
    if is_dir:
        media_file, is_image = _find_first_media(filepath, extensions)
        if not media_file:
            # Fall back to first book file
            media_file = next(_find_books(filepath), None)
            if not media_file:
                return jsonify({"error": "no media found"}), 404
            is_book = True
        else:
            # _find_first_media may return a book file since books are in extensions
            ext = os.path.splitext(media_file)[1].lower()
            is_book = ext in BOOK_EXTS
        filepath = media_file
    elif not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404
    else:
        ext = os.path.splitext(filepath)[1].lower()
        is_book = ext in BOOK_EXTS

    # Check cache (nested path, with fallback to legacy flat path)
    path_hash = hashlib.sha256(filepath.encode()).hexdigest()
    cache_path = cache_path_for(path_hash)
    legacy_path = os.path.join(CACHE_DIR, f"{path_hash}.jpg")

    # Migrate legacy flat file to nested location
    if not os.path.exists(cache_path) and os.path.exists(legacy_path):
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        os.rename(legacy_path, cache_path)

    if os.path.exists(cache_path):
        return send_file(cache_path, mimetype="image/jpeg")

    # If on-the-fly generation is disabled, return 404 for uncached thumbnails
    generate_on_fly = config.get("thumbnails", {}).get("generate_on_fly", True)
    if not generate_on_fly:
        return jsonify({"error": "no thumbnail cached"}), 404

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    if is_book:
        ok = _generate_book_thumbnail(filepath, cache_path)
        if not ok and dir_for_books:
            # First book failed; try remaining books in the directory
            for alt_book in _find_books(dir_for_books):
                if alt_book == filepath:
                    continue
                alt_hash = hashlib.sha256(alt_book.encode()).hexdigest()
                alt_cache = cache_path_for(alt_hash)
                os.makedirs(os.path.dirname(alt_cache), exist_ok=True)
                if _generate_book_thumbnail(alt_book, cache_path):
                    ok = True
                    break
        if not ok:
            return jsonify({"error": "thumbnail generation failed"}), 500
        return send_file(cache_path, mimetype="image/jpeg")

    if is_image:
        # Resize image to thumbnail using FFmpeg
        cmd = [
            "ffmpeg", "-i", filepath,
            "-vf", "scale=320:-1",
            "-frames:v", "1",
            "-y", cache_path
        ]
    else:
        # Get duration for seek position
        data = ffprobe(filepath)
        duration = float(data.get("format", {}).get("duration", 0)) if data else 0
        seek = max(0, duration * 0.1)
        cmd = [
            "ffmpeg", "-ss", str(seek), "-i", filepath,
            "-vf", "thumbnail=300,scale=320:-1",
            "-frames:v", "1",
            "-y", cache_path
        ]

    result = subprocess.run(cmd, capture_output=True, timeout=30)
    if result.returncode != 0 or not os.path.exists(cache_path):
        return jsonify({"error": "thumbnail generation failed"}), 500

    return send_file(cache_path, mimetype="image/jpeg")
