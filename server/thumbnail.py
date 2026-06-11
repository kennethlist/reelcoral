import os
import json
import hashlib
import subprocess
import threading
import warnings
import logging
from flask import Blueprint, request, current_app, send_file, jsonify
from probe import ffprobe
from offload import run_blocking, singleflight

thumbnail_bp = Blueprint("thumbnail", __name__)
log = logging.getLogger(__name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
BOOK_EXTS = {".epub", ".pdf", ".cbr", ".cbz", ".zip"}

# Global cap on concurrent thumbnail generation (each spawns ffmpeg, and the
# video path decodes 300 frames). Sized from config thumbnails.threads.
_gen_semaphore = None
_gen_semaphore_lock = threading.Lock()


def _semaphore(config):
    global _gen_semaphore
    with _gen_semaphore_lock:
        if _gen_semaphore is None:
            threads = config.get("thumbnails", {}).get("threads", 4)
            try:
                threads = max(1, min(64, int(threads)))
            except (TypeError, ValueError):
                threads = 4
            _gen_semaphore = threading.BoundedSemaphore(threads)
        return _gen_semaphore


def _load_overrides_safe():
    """Load thumbnail_overrides.json, tolerating a missing/corrupt file."""
    overrides_file = os.path.join(os.path.dirname(CACHE_DIR), "thumbnail_overrides.json")
    if os.path.exists(overrides_file):
        try:
            with open(overrides_file) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


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
        elif ext in (".cbr", ".cbz", ".zip"):
            return _generate_comic_thumbnail(book_path, cache_path)
    except Exception as e:
        log.warning("Book thumbnail generation failed for %s: %s", book_path, e)
    return False


def _resize_to_thumb(input_path, output_path):
    """Resize an image file to thumbnail width using ffmpeg (atomic write)."""
    tmp_out = output_path + ".part.jpg"
    cmd = [
        "ffmpeg", "-i", input_path,
        "-vf", "scale=320:-1",
        "-frames:v", "1",
        "-y", tmp_out,
    ]
    result = subprocess.run(cmd, capture_output=True, timeout=30)
    if result.returncode == 0 and os.path.exists(tmp_out):
        os.rename(tmp_out, output_path)
        return True
    if os.path.exists(tmp_out):
        os.remove(tmp_out)
    return False


def _extract_epub_cover(epub_path):
    """Pure-CPU EPUB cover extraction (safe to run on the threadpool)."""
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
        return None
    return cover.get_content()


def _generate_epub_thumbnail(epub_path, cache_path):
    data = run_blocking(_extract_epub_cover, epub_path)
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


def _render_pdf_first_page(pdf_path, tmp_path):
    """Pure-CPU PDF first-page render (safe to run on the threadpool)."""
    import pymupdf
    doc = pymupdf.open(pdf_path)
    try:
        if doc.page_count == 0:
            return False
        pg = doc[0]
        zoom = 320 / pg.rect.width
        zoom = max(0.5, min(zoom, 5.0))
        mat = pymupdf.Matrix(zoom, zoom)
        pix = pg.get_pixmap(matrix=mat)
        pix.save(tmp_path)
        return True
    finally:
        doc.close()


def _generate_pdf_thumbnail(pdf_path, cache_path):
    tmp_path = cache_path + ".tmp.png"
    try:
        if not run_blocking(_render_pdf_first_page, pdf_path, tmp_path):
            return False
        return _resize_to_thumb(tmp_path, cache_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def _extract_zip_comic_first_page(comic_path):
    """Pure-CPU zip comic first-page extraction (safe on the threadpool)."""
    import re
    import zipfile
    comic_image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

    def natural_sort_key(s):
        return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', s)]

    names = []
    with zipfile.ZipFile(comic_path, "r") as zf:
        for name in zf.namelist():
            if os.path.splitext(name)[1].lower() in comic_image_exts and not os.path.basename(name).startswith("."):
                names.append(name)
        names.sort(key=natural_sort_key)
        if not names:
            return None
        return zf.read(names[0])


def _extract_cbr_comic_first_page(comic_path):
    """CBR first-page extraction. rarfile shells out to unrar (cooperative
    under gevent), so this must stay in the request greenlet."""
    import re
    import rarfile
    comic_image_exts = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

    def natural_sort_key(s):
        return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', s)]

    names = []
    with rarfile.RarFile(comic_path, "r") as rf:
        for name in rf.namelist():
            if os.path.splitext(name)[1].lower() in comic_image_exts and not os.path.basename(name).startswith("."):
                names.append(name)
        names.sort(key=natural_sort_key)
        if not names:
            return None
        return rf.read(names[0])


def _generate_comic_thumbnail(comic_path, cache_path):
    ext = os.path.splitext(comic_path)[1].lower()
    if ext in (".cbz", ".zip"):
        data = run_blocking(_extract_zip_comic_first_page, comic_path)
    elif ext == ".cbr":
        data = _extract_cbr_comic_first_page(comic_path)
    else:
        data = None

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


def _resolve_thumb_target(root, real_root, path, extensions):
    """Resolve a browse path to its thumbnail target.

    Returns (target_filepath, path_hash, is_image, is_book) or None if invalid.
    """
    if not isinstance(path, str):
        return None

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(real_root + os.sep):
        return None

    is_image = False
    is_book = False
    target = filepath

    if os.path.isdir(filepath):
        media_file, is_image = _find_first_media(filepath, extensions)
        if not media_file:
            media_file = next(_find_books(filepath), None)
            if not media_file:
                return None
            is_book = True
        else:
            ext = os.path.splitext(media_file)[1].lower()
            is_book = ext in BOOK_EXTS
        target = media_file
    elif os.path.isfile(filepath):
        ext = os.path.splitext(filepath)[1].lower()
        is_image = ext in IMAGE_EXTS
        is_book = ext in BOOK_EXTS
    else:
        return None

    path_hash = hashlib.sha256(target.encode()).hexdigest()
    return target, path_hash, is_image, is_book


def _migrate_legacy(path_hash):
    """Migrate legacy flat cache file to nested location. Returns the nested cache path."""
    cp = cache_path_for(path_hash)
    legacy_path = os.path.join(CACHE_DIR, f"{path_hash}.jpg")
    if not os.path.exists(cp) and os.path.exists(legacy_path):
        try:
            os.makedirs(os.path.dirname(cp), exist_ok=True)
            os.rename(legacy_path, cp)
        except OSError:
            # Concurrent request won the rename — cp exists now.
            pass
    return cp


def _generate_thumbnail(filepath, cache_path, is_image, is_book, extensions):
    """Generate a thumbnail for a media file. Returns True on success."""
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    if is_book:
        # The book generators offload their CPU-bound extraction internally
        # and keep their ffmpeg resize (cooperative) in this greenlet.
        return _generate_book_thumbnail(filepath, cache_path)

    tmp_out = cache_path + ".part.jpg"
    if is_image:
        cmd = [
            "ffmpeg", "-i", filepath,
            "-vf", "scale=320:-1",
            "-frames:v", "1",
            "-y", tmp_out
        ]
    else:
        data = ffprobe(filepath)
        duration = float(data.get("format", {}).get("duration", 0)) if data else 0
        seek = max(0, duration * 0.1)
        cmd = [
            "ffmpeg", "-ss", str(seek), "-i", filepath,
            "-vf", "thumbnail=300,scale=320:-1",
            "-frames:v", "1",
            "-y", tmp_out
        ]

    result = subprocess.run(cmd, capture_output=True, timeout=30)
    if result.returncode == 0 and os.path.exists(tmp_out):
        os.rename(tmp_out, cache_path)
        return True
    if os.path.exists(tmp_out):
        os.remove(tmp_out)
    return False


def _generate_thumbnail_guarded(config, filepath, cache_path, is_image, is_book, extensions):
    """Thundering-herd-safe generation: concurrent requests for the same
    thumbnail share one generation, and total concurrent generations are
    capped by config thumbnails.threads."""
    def generate():
        if os.path.exists(cache_path):
            return True
        with _semaphore(config):
            if os.path.exists(cache_path):
                return True
            return _generate_thumbnail(filepath, cache_path, is_image, is_book, extensions)

    return singleflight(("thumb", cache_path), generate)


@thumbnail_bp.route("/thumbnails/batch", methods=["POST"])
def thumbnails_batch():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    real_root = os.path.realpath(root)
    extensions = set(config["media"].get("extensions", []))

    body = request.get_json(silent=True) or {}
    paths = body.get("paths", [])
    if not isinstance(paths, list) or len(paths) > 200:
        return jsonify({"error": "invalid paths"}), 400

    # Load overrides once
    overrides = _load_overrides_safe()

    thumbnails = {}
    for path in paths:
        # Check override first
        override_hash = overrides.get(path)
        if override_hash:
            override_cache = cache_path_for(override_hash)
            if os.path.exists(override_cache):
                thumbnails[path] = {"hash": override_hash, "cached": True}
                continue

        resolved = _resolve_thumb_target(root, real_root, path, extensions)
        if not resolved:
            thumbnails[path] = None
            continue

        _target, path_hash, _is_image, _is_book = resolved
        cp = _migrate_legacy(path_hash)
        cached = os.path.exists(cp)
        thumbnails[path] = {"hash": path_hash, "cached": cached}

    return jsonify({"thumbnails": thumbnails})


@thumbnail_bp.route("/thumbnails/generate", methods=["POST"])
def thumbnails_generate():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    real_root = os.path.realpath(root)
    extensions = set(config["media"].get("extensions", []))

    generate_on_fly = config.get("thumbnails", {}).get("generate_on_fly", True)
    if not generate_on_fly:
        return jsonify({"generated": []})

    body = request.get_json(silent=True) or {}
    paths = body.get("paths", [])
    if not isinstance(paths, list) or len(paths) > 50:
        return jsonify({"error": "invalid paths"}), 400

    generated = []
    for path in paths:
        resolved = _resolve_thumb_target(root, real_root, path, extensions)
        if not resolved:
            continue

        target, path_hash, is_image, is_book = resolved
        cp = _migrate_legacy(path_hash)
        if os.path.exists(cp):
            continue

        try:
            if _generate_thumbnail_guarded(config, target, cp, is_image, is_book, extensions):
                generated.append(path)
        except Exception as e:
            log.warning("Thumbnail generation failed for %s: %s", path, e)

    return jsonify({"generated": generated})


@thumbnail_bp.route("/thumbnail")
def thumbnail():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    real_root = os.path.realpath(root)
    extensions = set(config["media"].get("extensions", []))
    path = request.args.get("path", "")

    # Check for a thumbnail override (keyed by browse path, not media file)
    overrides = _load_overrides_safe()
    override_hash = overrides.get(path)
    if override_hash:
        override_cache = cache_path_for(override_hash)
        if os.path.exists(override_cache):
            return send_file(override_cache, mimetype="image/jpeg", max_age=86400)

    resolved = _resolve_thumb_target(root, real_root, path, extensions)
    if not resolved:
        return jsonify({"error": "not found"}), 404

    filepath, path_hash, is_image, is_book = resolved
    cache_path = _migrate_legacy(path_hash)

    if os.path.exists(cache_path):
        return send_file(cache_path, mimetype="image/jpeg", max_age=86400)

    # If on-the-fly generation is disabled, return 404 for uncached thumbnails
    generate_on_fly = config.get("thumbnails", {}).get("generate_on_fly", True)
    if not generate_on_fly:
        return jsonify({"error": "no thumbnail cached"}), 404

    try:
        if _generate_thumbnail_guarded(config, filepath, cache_path, is_image, is_book, extensions):
            return send_file(cache_path, mimetype="image/jpeg", max_age=86400)
    except Exception as e:
        log.warning("Thumbnail generation failed for %s: %s", path, e)

    return jsonify({"error": "thumbnail generation failed"}), 500
