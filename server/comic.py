import os
import re
import zipfile
from flask import Blueprint, request, jsonify, send_file
from flask import current_app
from io import BytesIO

comic_bp = Blueprint("comic", __name__)

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
    data = _read_comic_page(abs_path, page_name)
    if data is None:
        return jsonify({"error": "failed to read page"}), 500

    ext = os.path.splitext(page_name)[1].lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp"}
    mime = mime_map.get(ext, "image/jpeg")

    return send_file(BytesIO(data), mimetype=mime)
