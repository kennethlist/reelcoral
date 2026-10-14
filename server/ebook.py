import os
import re
from urllib.parse import quote, unquote
import threading
import warnings
import logging
from collections import OrderedDict
from flask import Blueprint, request, jsonify, current_app, send_file, make_response
from io import BytesIO

from offload import run_blocking, singleflight

ebook_bp = Blueprint("ebook", __name__)
log = logging.getLogger(__name__)

# Parsed-book LRU keyed by (path, mtime). read_epub is a full zip + lxml
# parse and used to run on EVERY chapter request, blocking the event loop
# for the whole parse. Books are read-only after parse, so sharing the
# object between requests is safe.
_BOOK_CACHE = OrderedDict()
_BOOK_CACHE_LOCK = threading.Lock()
_BOOK_CACHE_MAX = 3


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return None
    return abs_path


def _read_epub(abs_path):
    import ebooklib  # noqa: F401
    from ebooklib import epub

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return epub.read_epub(abs_path)


def _parse_epub(abs_path):
    try:
        mtime = os.path.getmtime(abs_path)
    except OSError:
        mtime = 0
    key = (abs_path, mtime)

    with _BOOK_CACHE_LOCK:
        if key in _BOOK_CACHE:
            _BOOK_CACHE.move_to_end(key)
            return _BOOK_CACHE[key]

    def do_parse():
        with _BOOK_CACHE_LOCK:
            if key in _BOOK_CACHE:
                return _BOOK_CACHE[key]
        book = run_blocking(_read_epub, abs_path)
        with _BOOK_CACHE_LOCK:
            _BOOK_CACHE[key] = book
            while len(_BOOK_CACHE) > _BOOK_CACHE_MAX:
                _BOOK_CACHE.popitem(last=False)
        return book

    return singleflight(("epub", key), do_parse)


_MIME_MAP = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg",
             ".png": "image/png", ".gif": "image/gif", ".svg": "image/svg+xml",
             ".webp": "image/webp", ".bmp": "image/bmp", ".avif": "image/avif",
             ".jxl": "image/jxl"}


def _guess_mime(name):
    return _MIME_MAP.get(os.path.splitext(name)[1].lower(), "application/octet-stream")


def _resolve_href(item_name, src):
    """Resolve a reference inside a chapter to an EPUB-internal item href.

    Returns None for absolute/external/data URLs. Strips fragments and
    query strings and percent-decodes so names with spaces match the
    manifest.
    """
    src = src.strip()
    if not src or src.startswith(("data:", "http:", "https:", "//", "/", "#")):
        return None
    src = src.split("#")[0].split("?")[0]
    if not src:
        return None
    chapter_dir = os.path.dirname(item_name)
    href = os.path.normpath(os.path.join(chapter_dir, unquote(src))).replace(os.sep, "/")
    if href.startswith("../"):
        return None
    return href


def _image_dims(content, max_width):
    """(width, height) the resource endpoint will serve, reading only the header."""
    from PIL import Image as PILImage
    try:
        with PILImage.open(BytesIO(content)) as im:
            w, h = im.size
    except Exception:
        return None
    if max_width > 0 and w > max_width:
        h = round(h * max_width / w)
        w = max_width
    return w, h


def _resource_url(book_path, href):
    # Emitted inside HTML attributes, so "&" is entity-escaped.
    return (f"/api/ebook/resource?path={quote(book_path, safe='')}"
            f"&amp;href={quote(href, safe='')}")


@ebook_bp.route("/info")
def ebook_info():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    ext = os.path.splitext(abs_path)[1].lower()
    if ext != ".epub":
        return jsonify({"error": "not an epub"}), 400

    try:
        book = _parse_epub(abs_path)
    except Exception as e:
        log.error("Failed to parse EPUB %s: %s", abs_path, e)
        return jsonify({"error": f"Failed to parse EPUB: {str(e)}"}), 500

    import ebooklib

    # Get metadata
    title = ""
    author = ""
    try:
        title = book.get_metadata("DC", "title")[0][0]
    except (IndexError, KeyError, TypeError):
        title = os.path.splitext(os.path.basename(abs_path))[0]
    try:
        author = book.get_metadata("DC", "creator")[0][0]
    except (IndexError, KeyError, TypeError):
        pass

    # Get spine-ordered chapters (only document items)
    spine_ids = [s[0] for s in book.spine]
    chapters = []
    for item_id in spine_ids:
        item = book.get_item_with_id(item_id)
        if item and item.get_type() == ebooklib.ITEM_DOCUMENT:
            item_title = item.get_name()
            chapters.append({"id": item_id, "title": item_title})

    # Get TOC
    toc = []
    for entry in book.toc:
        try:
            if hasattr(entry, "title"):
                toc.append({"title": entry.title, "href": getattr(entry, "href", "")})
            elif isinstance(entry, tuple) and len(entry) == 2:
                section, items = entry
                toc.append({"title": getattr(section, "title", str(section)), "href": ""})
                for sub in items:
                    if hasattr(sub, "title"):
                        toc.append({"title": sub.title, "href": getattr(sub, "href", "")})
        except Exception:
            continue

    return jsonify({
        "title": title,
        "author": author,
        "chapters": chapters,
        "chapter_count": len(chapters),
        "toc": toc,
    })


def _resize_image_bytes(data, max_width, quality=85):
    """Resize image bytes if wider than max_width. Returns resized bytes and format."""
    from PIL import Image as PILImage
    img = PILImage.open(BytesIO(data))
    if img.width <= max_width:
        return data, None  # No resize needed
    ratio = max_width / img.width
    new_size = (max_width, round(img.height * ratio))
    img = img.resize(new_size, PILImage.LANCZOS)
    buf = BytesIO()
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue(), "image/jpeg"


@ebook_bp.route("/chapter")
def ebook_chapter():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    index = request.args.get("index", 0, type=int)
    max_width = request.args.get("maxWidth", 0, type=int)
    if index is None or max_width is None:
        return jsonify({"error": "invalid parameters"}), 400
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    try:
        book = _parse_epub(abs_path)
    except Exception as e:
        log.error("Failed to parse EPUB %s: %s", abs_path, e)
        return jsonify({"error": f"Failed to parse EPUB: {str(e)}"}), 500

    import ebooklib
    spine_ids = [s[0] for s in book.spine]
    doc_items = []
    for item_id in spine_ids:
        item = book.get_item_with_id(item_id)
        if item and item.get_type() == ebooklib.ITEM_DOCUMENT:
            doc_items.append(item)

    if index < 0 or index >= len(doc_items):
        return jsonify({"error": "chapter index out of range"}), 400

    item = doc_items[index]
    # Image re-encoding + the regex passes below chew CPU proportional to
    # chapter size — run off the event loop so HLS segments keep flowing.
    html = run_blocking(_render_chapter_html, book, item, path, max_width)
    return jsonify({"html": html, "index": index})


def _render_chapter_html(book, item, book_path, max_width):
    html = item.get_content().decode("utf-8", errors="replace")

    # Rewrite image references to point at /api/ebook/resource instead of
    # inlining them as base64 data URIs. Inlining every image of every
    # chapter into one JSON string blew past mobile Safari's per-tab memory
    # budget and WebKit responded by dropping image decodes (the blue "?"
    # icon). Serving them as separate resources lets the browser fetch,
    # cache and evict them normally.
    item_name = item.get_name()
    size_q = f"&amp;maxWidth={max_width}" if max_width > 0 else ""

    def to_url(src):
        href = _resolve_href(item_name, src)
        if href is None or not book.get_item_with_href(href):
            return None
        return _resource_url(book_path, href) + size_q

    def replace_src(match):
        url = to_url(match.group(2))
        if url is None:
            return match.group(0)
        return f'{match.group(1)}="{url}"'

    def replace_srcset(match):
        candidates = []
        for cand in match.group(1).split(","):
            cand = cand.strip()
            if not cand:
                continue
            parts = cand.split(None, 1)
            url = to_url(parts[0])
            if url is not None:
                parts[0] = url
            candidates.append(" ".join(parts))
        return 'srcset="' + ", ".join(candidates) + '"'

    # Normalize single-quoted attributes to double-quoted first
    html = re.sub(r"\b(src|srcset|xlink:href|href)='([^']*)'", r'\1="\2"', html)
    # <img src>, <image xlink:href>/<image href> (SVG), <video poster>
    html = re.sub(r'\b(src|xlink:href|poster)="([^"]+)"', replace_src, html)
    def replace_svg_href(match):
        url = to_url(match.group(2))
        if url is None:
            return match.group(0)
        return f'{match.group(1)}href="{url}"'
    html = re.sub(r'(<image\b[^>]*?\s)href="([^"]+)"', replace_svg_href, html, flags=re.IGNORECASE)
    html = re.sub(r'\bsrcset="([^"]*)"', replace_srcset, html)

    # Images now arrive over the network after the chapter HTML, so give
    # <img> tags their final dimensions up front. The reader lays the book
    # out in CSS columns and derives page count / saved progress from that
    # layout; with width/height set (and CSS height:auto) the layout is
    # identical before and after the bytes land, so pages don't shift.
    def add_dims(match):
        tag = match.group(0)
        if re.search(r'\b(?:width|height)\s*=', tag, re.IGNORECASE):
            return tag
        m = re.search(r'\bsrc="/api/ebook/resource\?[^"]*?&amp;href=([^&"]+)', tag)
        if not m:
            return tag
        href = unquote(m.group(1))
        img_item = book.get_item_with_href(href)
        if not img_item:
            return tag
        ext = os.path.splitext(href)[1].lower()
        if ext == ".svg":
            return tag
        dims = _image_dims(img_item.get_content(), max_width if ext != ".gif" else 0)
        if not dims:
            return tag
        return f'<img width="{dims[0]}" height="{dims[1]}"' + tag[4:]
    html = re.sub(r'<img\b[^>]*>', add_dims, html, flags=re.IGNORECASE)

    # Sanitize: remove script tags and their contents
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<script\b[^>]*/>', '', html, flags=re.IGNORECASE)
    # Remove event handler attributes (on*)
    html = re.sub(r'\s+on\w+\s*=\s*"[^"]*"', '', html, flags=re.IGNORECASE)
    html = re.sub(r"\s+on\w+\s*=\s*'[^']*'", '', html, flags=re.IGNORECASE)
    # Remove javascript: hrefs
    html = re.sub(r'href\s*=\s*"javascript:[^"]*"', 'href="#"', html, flags=re.IGNORECASE)
    html = re.sub(r"href\s*=\s*'javascript:[^']*'", "href='#'", html, flags=re.IGNORECASE)
    # Unwrap <a> tags — keep inner content, remove the link wrapper
    html = re.sub(r'<a\b[^>]*>(.*?)</a>', r'\1', html, flags=re.DOTALL | re.IGNORECASE)

    # Scope <style> tags to .epub-content so EPUB CSS doesn't leak to the overlay/controls.
    # Remove @font-face and @import (reference unavailable embedded resources).
    def _scope_style(m):
        css = m.group(1)
        css = re.sub(r'@font-face\s*\{[^}]*\}', '', css, flags=re.DOTALL | re.IGNORECASE)
        css = re.sub(r'@import\s+[^;]+;', '', css, flags=re.IGNORECASE)
        css = css.strip()
        if not css:
            return ''
        return '<style>.epub-content { ' + css + ' }</style>'
    html = re.sub(r'<style[^>]*>(.*?)</style>', _scope_style, html, flags=re.DOTALL | re.IGNORECASE)

    # Remove <link> tags (reference EPUB-internal stylesheets that aren't served)
    html = re.sub(r'<link\b[^>]*/?\s*>', '', html, flags=re.IGNORECASE)
    # Strip structural HTML tags (meaningless inside a div)
    html = re.sub(r'</?(?:html|head|body|meta)\b[^>]*>', '', html, flags=re.IGNORECASE)

    return html


@ebook_bp.route("/resource")
def ebook_resource():
    """Serve an EPUB-internal resource (image, etc.) referenced by a chapter."""
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    href = request.args.get("href", "")
    max_width = request.args.get("maxWidth", 0, type=int) or 0
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404
    if not href or href.startswith("/") or ".." in href.split("/"):
        return jsonify({"error": "invalid href"}), 400

    try:
        book = _parse_epub(abs_path)
    except Exception as e:
        log.error("Failed to parse EPUB %s: %s", abs_path, e)
        return jsonify({"error": f"Failed to parse EPUB: {str(e)}"}), 500

    import ebooklib
    res_item = book.get_item_with_href(href)
    if not res_item:
        return jsonify({"error": "resource not found"}), 404
    # Only images are referenced by the rewritten chapter HTML; refuse to
    # serve scripts/stylesheets/documents through this path.
    if res_item.get_type() not in (ebooklib.ITEM_IMAGE, ebooklib.ITEM_COVER):
        return jsonify({"error": "unsupported resource type"}), 400

    content = res_item.get_content()
    mime = _guess_mime(href)
    if mime == "application/octet-stream":
        mime = res_item.media_type or mime
    if max_width > 0 and mime not in ("image/svg+xml", "image/gif"):
        try:
            resized, new_mime = run_blocking(_resize_image_bytes, content, max_width)
            if new_mime:
                content, mime = resized, new_mime
        except Exception:
            pass

    resp = make_response(send_file(BytesIO(content), mimetype=mime))
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@ebook_bp.route("/cover")
def ebook_cover():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    try:
        book = _parse_epub(abs_path)
    except Exception as e:
        log.error("Failed to parse EPUB %s: %s", abs_path, e)
        return jsonify({"error": f"Failed to parse EPUB: {str(e)}"}), 500

    import ebooklib
    # Try to find cover image
    cover = None
    for item in book.get_items_of_type(ebooklib.ITEM_COVER):
        cover = item
        break
    if not cover:
        for item in book.get_items_of_type(ebooklib.ITEM_IMAGE):
            name = item.get_name().lower()
            if "cover" in name:
                cover = item
                break
    if not cover:
        # Just get first image
        images = list(book.get_items_of_type(ebooklib.ITEM_IMAGE))
        if images:
            cover = images[0]

    if not cover:
        return jsonify({"error": "no cover found"}), 404

    content = cover.get_content()
    mime = _guess_mime(cover.get_name())
    if mime == "application/octet-stream":
        mime = cover.media_type or "image/png"

    return send_file(BytesIO(content), mimetype=mime)
