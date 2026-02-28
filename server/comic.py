import os
import re
import hashlib
import zipfile
from flask import Blueprint, request, jsonify, send_file
from flask import current_app
from io import BytesIO

comic_bp = Blueprint("comic", __name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
COMIC_PAGE_CACHE_SUBDIR = "comic_pages"


def _comic_cache_path(abs_path, page):
    """Build a nested cache path for an extracted comic page, including file mtime for invalidation."""
    mtime = os.path.getmtime(abs_path)
    key = f"{abs_path}|{page}|{mtime}"
    h = hashlib.sha256(key.encode()).hexdigest()
    cache_dir = os.path.join(CACHE_DIR, COMIC_PAGE_CACHE_SUBDIR, h[:2], h[2:4])
    return os.path.join(cache_dir, f"{h}")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root)):
        return None
    return abs_path


def _natural_sort_key(s):
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', s)]


def _get_comic_pages(abs_path):
    """Return sorted list of image filenames inside the archive."""
    ext = os.path.splitext(abs_path)[1].lower()
    names = []

    if ext == ".cbz":
        with zipfile.ZipFile(abs_path, "r") as zf:
            for name in zf.namelist():
                if os.path.splitext(name)[1].lower() in IMAGE_EXTS and not os.path.basename(name).startswith("."):
                    names.append(name)
    elif ext == ".cbr":
        import rarfile
        with rarfile.RarFile(abs_path, "r") as rf:
            for name in rf.namelist():
                if os.path.splitext(name)[1].lower() in IMAGE_EXTS and not os.path.basename(name).startswith("."):
                    names.append(name)

    names.sort(key=_natural_sort_key)
    return names


def _read_comic_page(abs_path, page_name):
    """Read a single page image from the archive."""
    ext = os.path.splitext(abs_path)[1].lower()

    if ext == ".cbz":
        with zipfile.ZipFile(abs_path, "r") as zf:
            return zf.read(page_name)
    elif ext == ".cbr":
        import rarfile
        with rarfile.RarFile(abs_path, "r") as rf:
            return rf.read(page_name)
    return None


@comic_bp.route("/info")
def comic_info():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    pages = _get_comic_pages(abs_path)
    return jsonify({"page_count": len(pages)})


@comic_bp.route("/page")
def comic_page():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    page = int(request.args.get("page", 0))
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    pages = _get_comic_pages(abs_path)
    if page < 0 or page >= len(pages):
        return jsonify({"error": "page out of range"}), 400

    page_name = pages[page]
    ext = os.path.splitext(page_name)[1].lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}
    mime = mime_map.get(ext, "image/jpeg")

    # Check disk cache first
    cached = _comic_cache_path(abs_path, page) + ext
    if os.path.exists(cached):
        return send_file(cached, mimetype=mime)

    data = _read_comic_page(abs_path, page_name)
    if data is None:
        return jsonify({"error": "failed to read page"}), 500

    # Write to disk cache
    os.makedirs(os.path.dirname(cached), exist_ok=True)
    with open(cached, "wb") as f:
        f.write(data)

    return send_file(BytesIO(data), mimetype=mime)
