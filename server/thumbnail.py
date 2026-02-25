import os
import hashlib
import subprocess
from flask import Blueprint, request, current_app, send_file, jsonify
from probe import ffprobe

thumbnail_bp = Blueprint("thumbnail", __name__)

CACHE_DIR = os.environ.get("KMC_CACHE_DIR", "/cache/thumbnails")


def _find_first_video(dirpath, extensions, depth=5):
    """Recursively find the first video file in a directory."""
    if depth <= 0:
        return None
    try:
        items = sorted(os.listdir(dirpath), key=str.lower)
    except (PermissionError, OSError):
        return None
    # Check files first
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        if os.path.isfile(full) and os.path.splitext(name)[1].lower() in extensions:
            return full
    # Then recurse into directories
    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(dirpath, name)
        if os.path.isdir(full):
            result = _find_first_video(full, extensions, depth - 1)
            if result:
                return result
    return None


@thumbnail_bp.route("/thumbnail")
def thumbnail():
    config = current_app.config["KMC"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))
    path = request.args.get("path", "")

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403

    # For directories, find the first video file recursively
    if os.path.isdir(filepath):
        video_file = _find_first_video(filepath, extensions)
        if not video_file:
            return jsonify({"error": "no video found"}), 404
        filepath = video_file
    elif not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    # Check cache
    path_hash = hashlib.sha256(filepath.encode()).hexdigest()
    cache_path = os.path.join(CACHE_DIR, f"{path_hash}.jpg")

    if os.path.exists(cache_path):
        return send_file(cache_path, mimetype="image/jpeg")

    # Get duration for seek position
    data = ffprobe(filepath)
    duration = float(data.get("format", {}).get("duration", 0)) if data else 0
    seek = max(0, duration * 0.1)

    os.makedirs(CACHE_DIR, exist_ok=True)

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
