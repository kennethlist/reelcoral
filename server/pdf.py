import os
import hashlib
import logging
from flask import Blueprint, request, jsonify, send_file, make_response
from flask import current_app
from io import BytesIO

from offload import run_blocking, singleflight

pdf_bp = Blueprint("pdf", __name__)
log = logging.getLogger(__name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
PDF_PAGE_CACHE_SUBDIR = "pdf_pages"


def _pdf_cache_path(abs_path, page, fit, width, height):
    """Build a nested cache path for a rendered PDF page, including file mtime for invalidation."""
    mtime = os.path.getmtime(abs_path)
    key = f"{abs_path}|{page}|{fit}|{width}|{height}|{mtime}"
    h = hashlib.sha256(key.encode()).hexdigest()
    cache_dir = os.path.join(CACHE_DIR, PDF_PAGE_CACHE_SUBDIR, h[:2], h[2:4])
    return os.path.join(cache_dir, f"{h}.jpg")


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return None
    return abs_path


@pdf_bp.route("/info")
def pdf_info():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    def do_info():
        import pymupdf
        doc = pymupdf.open(abs_path)
        try:
            return doc.page_count, doc.metadata or {}
        finally:
            doc.close()

    try:
        page_count, metadata = run_blocking(do_info)
    except Exception as e:
        log.error("Failed to open PDF %s: %s", abs_path, e)
        return jsonify({"error": "failed to open PDF"}), 500

    return jsonify({
        "page_count": page_count,
        "title": metadata.get("title", ""),
        "author": metadata.get("author", ""),
    })


def _render_pdf_page(abs_path, page, fit, width, height):
    """Render one PDF page to JPEG bytes. Pure CPU — runs on the threadpool.

    Returns None when the page index is out of range.
    """
    import pymupdf
    doc = pymupdf.open(abs_path)
    try:
        if page < 0 or page >= doc.page_count:
            return None

        pg = doc[page]
        rect = pg.rect
        pg_width = rect.width
        pg_height = rect.height

        # Calculate zoom based on fit mode
        if fit == "width":
            zoom = width / pg_width
        elif fit == "height":
            zoom = height / pg_height
        elif fit == "page":
            zoom = min(width / pg_width, height / pg_height)
        else:
            zoom = width / pg_width

        # Clamp zoom to reasonable range
        zoom = max(0.5, min(zoom, 5.0))

        mat = pymupdf.Matrix(zoom, zoom)
        pix = pg.get_pixmap(matrix=mat)
        return pix.tobytes("jpeg", jpg_quality=85)
    finally:
        doc.close()


@pdf_bp.route("/page")
def pdf_page():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    page = request.args.get("page", 0, type=int)
    fit = request.args.get("fit", "width")
    width = request.args.get("width", 1200, type=int)
    height = request.args.get("height", 1600, type=int)
    if page is None or width is None or height is None or width <= 0 or height <= 0:
        return jsonify({"error": "invalid parameters"}), 400
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    # Check disk cache first
    cached = _pdf_cache_path(abs_path, page, fit, width, height)
    if os.path.exists(cached):
        resp = make_response(send_file(cached, mimetype="image/jpeg"))
        resp.headers["Cache-Control"] = "public, max-age=86400"
        return resp

    def do_render():
        # Re-check inside the flight: a duplicate request may have rendered
        # and cached this page while we waited.
        if os.path.exists(cached):
            with open(cached, "rb") as f:
                return f.read()
        img_data = run_blocking(_render_pdf_page, abs_path, page, fit, width, height)
        if img_data is None:
            return None
        # Write atomically so a crash mid-write can't leave a corrupt page
        # that exists-checks then serve forever.
        try:
            os.makedirs(os.path.dirname(cached), exist_ok=True)
            tmp = cached + ".tmp"
            with open(tmp, "wb") as f:
                f.write(img_data)
            os.rename(tmp, cached)
        except OSError:
            pass
        return img_data

    try:
        img_data = singleflight(("pdf_page", cached), do_render)
    except Exception as e:
        log.error("Failed to render PDF page %s p%s: %s", abs_path, page, e)
        return jsonify({"error": "failed to render page"}), 500

    if img_data is None:
        return jsonify({"error": "page out of range"}), 400

    resp = make_response(send_file(BytesIO(img_data), mimetype="image/jpeg"))
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp
