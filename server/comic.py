import os
import re
import hashlib
import zipfile
from collections import OrderedDict
from flask import Blueprint, request, jsonify, send_file
from flask import current_app
from io import BytesIO

from offload import run_blocking, singleflight
from jxl import is_jxl, jxl_to_jpeg

comic_bp = Blueprint("comic", __name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
COMIC_PAGE_CACHE_SUBDIR = "comic_pages"


def _comic_cache_path(abs_path, page, max_width=0, trim=False):
    """Build a nested cache path for an extracted comic page, including file mtime for invalidation."""
    mtime = os.path.getmtime(abs_path)
    key = f"{abs_path}|{page}|{mtime}|{max_width}"
    if trim:
        key += "|trim-all"
    h = hashlib.sha256(key.encode()).hexdigest()
    cache_dir = os.path.join(CACHE_DIR, COMIC_PAGE_CACHE_SUBDIR, h[:2], h[2:4])
    return os.path.join(cache_dir, f"{h}")

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".jxl"}

# In-process LRU cache of archive page lists, keyed by abs_path -> (mtime, names).
# Avoids re-opening and re-scanning the archive on every page request.
_PAGE_LIST_CACHE = OrderedDict()
_PAGE_LIST_CACHE_MAX = 64


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return None
    return abs_path


def _natural_sort_key(s):
    return [int(c) if c.isdigit() else c.lower() for c in re.split(r'(\d+)', s)]


def _get_comic_pages(abs_path):
    """Return sorted list of image filenames inside the archive (cached by mtime)."""
    mtime = os.path.getmtime(abs_path)
    cached = _PAGE_LIST_CACHE.get(abs_path)
    if cached and cached[0] == mtime:
        _PAGE_LIST_CACHE.move_to_end(abs_path)
        return cached[1]

    def scan():
        ext = os.path.splitext(abs_path)[1].lower()
        names = []
        if ext in (".cbz", ".zip"):
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

    names = run_blocking(scan)
    _PAGE_LIST_CACHE[abs_path] = (mtime, names)
    while len(_PAGE_LIST_CACHE) > _PAGE_LIST_CACHE_MAX:
        _PAGE_LIST_CACHE.popitem(last=False)
    return names


def _read_comic_page(abs_path, page_name):
    """Read a single page image from the archive."""
    ext = os.path.splitext(abs_path)[1].lower()

    if ext in (".cbz", ".zip"):
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


# Margin trimming: a pixel is "white" at or above TRIM_WHITE_LEVEL (0-255 luma),
# and a row/column counts as blank while fewer than TRIM_LINE_INK_FRACTION of its
# pixels are darker than that. The tolerance keeps JPEG noise and scanner specks
# in the margin from stopping the trim.
TRIM_WHITE_LEVEL = 235
TRIM_LINE_INK_FRACTION = 0.005


def _content_span(line_ink):
    """Given per-row (or per-column) ink levels (0-255), return the (start, end)
    span left after dropping blank lines from both ends, or None if all blank."""
    limit = 255 * TRIM_LINE_INK_FRACTION
    start = 0
    while start < len(line_ink) and line_ink[start] < limit:
        start += 1
    if start == len(line_ink):
        return None
    end = len(line_ink)
    while line_ink[end - 1] < limit:
        end -= 1
    return start, end


def _white_margin_box(img):
    """Return the (left, top, right, bottom) crop box of the content in img,
    i.e. the image with its white margins excluded. Returns None when there is
    nothing to trim (no margin, or an entirely blank page)."""
    from PIL import Image as PILImage
    probe = img
    if probe.mode in ("RGBA", "LA", "La", "RGBa") or (probe.mode == "P" and "transparency" in probe.info):
        # Treat transparency as white.
        rgba = probe.convert("RGBA")
        probe = PILImage.alpha_composite(PILImage.new("RGBA", rgba.size, "white"), rgba)
    if probe.mode != "L":
        probe = probe.convert("RGB").convert("L")
    ink = probe.point(lambda p: 255 if p < TRIM_WHITE_LEVEL else 0)
    # Box-averaging each row down to one pixel gives its ink fraction (0-255).
    rows = _content_span(ink.resize((1, ink.height), PILImage.BOX).tobytes())
    if rows is None:
        return None  # blank page — leave it alone
    top, bottom = rows
    # Measure columns within the kept rows only, so tall blank margins don't
    # dilute a column's ink fraction.
    ink = ink.crop((0, top, ink.width, bottom))
    cols = _content_span(ink.resize((ink.width, 1), PILImage.BOX).tobytes())
    if cols is None:
        return None
    left, right = cols
    if (left, top, right, bottom) == (0, 0, img.width, img.height):
        return None
    return left, top, right, bottom


def _resize_image_data(data, max_width, quality=85, trim=False):
    """Re-encode image data as JPEG, downscaled if wider than max_width (when
    that is > 0) and with white margins cropped off all four sides when trim is set."""
    from PIL import Image as PILImage
    img = PILImage.open(BytesIO(data))
    if trim:
        box = _white_margin_box(img)
        if box:
            img = img.crop(box)
    if 0 < max_width < img.width:
        ratio = max_width / img.width
        new_size = (max_width, round(img.height * ratio))
        img = img.resize(new_size, PILImage.LANCZOS)
    # JPEG only supports L, RGB, CMYK, YCbCr. Convert anything else (RGBA, LA, P, I, F, 1, ...)
    # to RGB so the save call doesn't raise "cannot write mode X as JPEG". A few premultiplied
    # modes (La, RGBa) can't go straight to RGB — route them through LA / RGBA first.
    if img.mode not in ("L", "RGB", "CMYK", "YCbCr"):
        try:
            img = img.convert("RGB")
        except (ValueError, OSError):
            intermediate = "LA" if img.mode == "La" else "RGBA"
            img = img.convert(intermediate).convert("RGB")
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _write_cache_atomic(cache_path, data):
    """Write a cache file via tmp+rename so a concurrent exists-check can
    never see (and then serve forever) a half-written file."""
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = cache_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.rename(tmp, cache_path)
    except OSError:
        pass


@comic_bp.route("/page")
def comic_page():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    page = request.args.get("page", 0, type=int)
    max_width = request.args.get("maxWidth", 0, type=int)
    trim = request.args.get("trim", "") == "1"
    if page is None or max_width is None:
        return jsonify({"error": "invalid parameters"}), 400
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
    page_is_jxl = is_jxl(page_name)

    # When resizing, always output JPEG. JPEG XL pages are transcoded even at
    # full size: browsers can't be relied on to decode JXL and Pillow can't
    # either, so ffmpeg (libjxl) handles the decode (near-lossless at full size).
    # Trimming white margins also re-encodes, since the crop changes the pixels.
    if max_width > 0 or page_is_jxl or trim:
        cached = _comic_cache_path(abs_path, page, max_width, trim) + ".jpg"
        if os.path.exists(cached):
            return send_file(cached, mimetype="image/jpeg")

        def extract_resized():
            if os.path.exists(cached):
                with open(cached, "rb") as f:
                    return f.read()
            # Archive decompression and the PIL decode+LANCZOS resize are
            # CPU-bound — keep them off the event loop.
            raw = run_blocking(_read_comic_page, abs_path, page_name)
            if raw is None:
                return None
            quality = 85 if max_width > 0 else 95
            if page_is_jxl and not trim:
                # ffmpeg subprocess: cooperative under gevent, no offload needed.
                resized = jxl_to_jpeg(raw, max_width, quality=quality)
            else:
                if page_is_jxl:
                    # Decode at full size first; Pillow then trims and resizes.
                    raw = jxl_to_jpeg(raw, 0, quality=95)
                    if raw is None:
                        return None
                resized = run_blocking(_resize_image_data, raw, max_width, quality, trim)
            if resized is None:
                return None
            _write_cache_atomic(cached, resized)
            return resized

        data = singleflight(("comic_page", cached), extract_resized)
        if data is None:
            return jsonify({"error": "failed to read page"}), 500
        return send_file(BytesIO(data), mimetype="image/jpeg")

    # No resize — serve original
    cached = _comic_cache_path(abs_path, page) + ext
    if os.path.exists(cached):
        return send_file(cached, mimetype=mime)

    def extract_original():
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                return f.read()
        raw = run_blocking(_read_comic_page, abs_path, page_name)
        if raw is None:
            return None
        _write_cache_atomic(cached, raw)
        return raw

    data = singleflight(("comic_page", cached), extract_original)
    if data is None:
        return jsonify({"error": "failed to read page"}), 500

    return send_file(BytesIO(data), mimetype=mime)
