import os
import base64
import re
import warnings
import logging
from flask import Blueprint, request, jsonify, current_app, send_file
from io import BytesIO

ebook_bp = Blueprint("ebook", __name__)
log = logging.getLogger(__name__)


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root)):
        return None
    return abs_path


def _parse_epub(abs_path):
    import ebooklib
    from ebooklib import epub

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        book = epub.read_epub(abs_path)
    return book


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


@ebook_bp.route("/chapter")
def ebook_chapter():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    index = int(request.args.get("index", 0))
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
    html = item.get_content().decode("utf-8", errors="replace")

    # Inline images: replace src references with base64 data URIs
    def replace_image_src(match):
        src = match.group(1)
        # Resolve relative path from the chapter's location
        chapter_dir = os.path.dirname(item.get_name())
        if src.startswith("../"):
            img_path = os.path.normpath(os.path.join(chapter_dir, src))
        elif not src.startswith("/") and not src.startswith("data:") and not src.startswith("http"):
            img_path = os.path.normpath(os.path.join(chapter_dir, src))
        else:
            return match.group(0)

        # Strip fragment
        img_path = img_path.split("#")[0].split("?")[0]

        img_item = book.get_item_with_href(img_path)
        if img_item:
            content = img_item.get_content()
            # Guess mime type
            ext = os.path.splitext(img_path)[1].lower()
            mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                        ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp"}
            mime = mime_map.get(ext, "image/png")
            b64 = base64.b64encode(content).decode("ascii")
            return f'src="data:{mime};base64,{b64}"'
        return match.group(0)

    # Normalize single-quoted src to double-quoted first
    html = re.sub(r"src='([^']+)'", r'src="\1"', html)
    html = re.sub(r'src="([^"]+)"', replace_image_src, html)

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

    return jsonify({"html": html, "index": index})


@ebook_bp.route("/cover")
def ebook_cover():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    book = _parse_epub(abs_path)

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
    ext = os.path.splitext(cover.get_name())[1].lower()
    mime_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp"}
    mime = mime_map.get(ext, "image/png")

    return send_file(BytesIO(content), mimetype=mime)
