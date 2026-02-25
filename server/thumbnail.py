import os
import hashlib
import subprocess
from flask import Blueprint, request, current_app, send_file, jsonify
from probe import ffprobe

thumbnail_bp = Blueprint("thumbnail", __name__)

CACHE_DIR = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


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


@thumbnail_bp.route("/thumbnail")
def thumbnail():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))
    path = request.args.get("path", "")

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403

    # For directories, find the first video or image file recursively
    is_image = False
    if os.path.isdir(filepath):
        media_file, is_image = _find_first_media(filepath, extensions)
        if not media_file:
            return jsonify({"error": "no media found"}), 404
        filepath = media_file
    elif not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

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
