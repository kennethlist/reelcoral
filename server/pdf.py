import os
import hashlib
from flask import Blueprint, request, jsonify, send_file
from flask import current_app
from io import BytesIO

pdf_bp = Blueprint("pdf", __name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
PDF_PAGE_CACHE_SUBDIR = "pdf_pages"


def _pdf_cache_path(abs_path, page, fit, width, height):
    """Build a nested cache path for a rendered PDF page, including file mtime for invalidation."""
    mtime = os.path.getmtime(abs_path)
    key = f"{abs_path}|{page}|{fit}|{width}|{height}|{mtime}"
    h = hashlib.sha256(key.encode()).hexdigest()
    cache_dir = os.path.join(CACHE_DIR, PDF_PAGE_CACHE_SUBDIR, h[:2], h[2:4])
    return os.path.join(cache_dir, f"{h}.png")


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root)):
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

    import pymupdf
    doc = pymupdf.open(abs_path)
    page_count = doc.page_count
    metadata = doc.metadata or {}
    doc.close()

    return jsonify({
        "page_count": page_count,
        "title": metadata.get("title", ""),
        "author": metadata.get("author", ""),
    })


@pdf_bp.route("/page")
def pdf_page():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    page = int(request.args.get("page", 0))
    fit = request.args.get("fit", "width")
    width = int(request.args.get("width", 1200))
    height = int(request.args.get("height", 1600))
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    # Check disk cache first
    cached = _pdf_cache_path(abs_path, page, fit, width, height)
    if os.path.exists(cached):
        return send_file(cached, mimetype="image/png")

    import pymupdf
    doc = pymupdf.open(abs_path)
    if page < 0 or page >= doc.page_count:
        doc.close()
        return jsonify({"error": "page out of range"}), 400

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
    img_data = pix.tobytes("png")
    doc.close()

    # Write to disk cache
    os.makedirs(os.path.dirname(cached), exist_ok=True)
    with open(cached, "wb") as f:
        f.write(img_data)

    return send_file(BytesIO(img_data), mimetype="image/png")
