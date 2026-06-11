import os
import hashlib
import subprocess
import logging
from flask import Blueprint, request, jsonify, current_app, send_file

from offload import singleflight

image_bp = Blueprint("image", __name__)
log = logging.getLogger(__name__)

# Sibling of the thumbnail cache dir. (The old str.replace derivation broke
# for any MEDIA_CACHE_DIR not ending in "/thumbnails".)
COMPRESSED_CACHE_DIR = os.path.join(
    os.path.dirname(os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")), "compressed"
)


def _compressed_cache_path(cache_key):
    h = hashlib.sha256(cache_key.encode()).hexdigest()
    return os.path.join(COMPRESSED_CACHE_DIR, h[:2], h[2:4], f"{h}.jpg")


@image_bp.route("/image")
def serve_image():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]

    rel_path = request.args.get("path", "").lstrip("/")
    if not rel_path:
        return jsonify({"error": "path required"}), 400

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    return send_file(abs_path)


@image_bp.route("/image/compressed")
def serve_compressed_image():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]

    rel_path = request.args.get("path", "").lstrip("/")
    if not rel_path:
        return jsonify({"error": "path required"}), 400

    max_width = request.args.get("maxWidth", 1920, type=int)
    quality = request.args.get("quality", 85, type=int)

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    # GIF files bypass compression (could be animated)
    ext = os.path.splitext(abs_path)[1].lower()
    if ext == ".gif":
        return send_file(abs_path, max_age=86400)

    # Build cache key from path + mtime + params
    try:
        mtime = os.path.getmtime(abs_path)
    except OSError:
        return send_file(abs_path)

    cache_key = f"{abs_path}|{mtime}|{max_width}|{quality}"
    cache_path = _compressed_cache_path(cache_key)

    if os.path.exists(cache_path):
        return send_file(cache_path, mimetype="image/jpeg", max_age=86400)

    def compress():
        if os.path.exists(cache_path):
            return True
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        # Atomic write: a failed ffmpeg used to leave a partial file that
        # the exists-check above then served (with max-age=86400) forever.
        tmp_out = cache_path + ".part.jpg"
        cmd = [
            "ffmpeg", "-i", abs_path,
            "-vf", f"scale='min({max_width},iw)':-1",
            "-q:v", str(max(1, min(31, (100 - quality) * 31 // 100 + 1))),
            "-frames:v", "1",
            "-y", tmp_out,
        ]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode == 0 and os.path.exists(tmp_out):
                os.rename(tmp_out, cache_path)
                return True
        except Exception as e:
            log.warning("Compressed image generation failed for %s: %s", abs_path, e)
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
        return False

    if singleflight(("image", cache_path), compress):
        return send_file(cache_path, mimetype="image/jpeg", max_age=86400)

    # Fallback to original
    return send_file(abs_path)
