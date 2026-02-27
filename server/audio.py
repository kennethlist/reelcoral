import os
import hashlib
import subprocess
import logging
from flask import Blueprint, request, jsonify, current_app, send_file, Response

audio_bp = Blueprint("audio", __name__)
log = logging.getLogger(__name__)

MIME_MAP = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wma": "audio/x-ms-wma",
    ".opus": "audio/opus",
}


def _cache_dir():
    return os.path.join(os.path.dirname(__file__), "..", "cache", "audio")


def _cache_path(abs_path, bitrate):
    h = hashlib.md5(abs_path.encode()).hexdigest()
    return os.path.join(_cache_dir(), f"{h}_{bitrate}.mp3")


@audio_bp.route("/audio")
def serve_audio():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]

    rel_path = request.args.get("path", "").lstrip("/")
    if not rel_path:
        return jsonify({"error": "path required"}), 400

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    if not abs_path.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    profile = request.args.get("profile", "Original")

    if profile.lower() == "original":
        ext = os.path.splitext(abs_path)[1].lower()
        mime = MIME_MAP.get(ext, "application/octet-stream")
        return send_file(abs_path, mimetype=mime)

    # Find the bitrate for the requested profile
    music_cfg = config.get("music", {})
    profiles = music_cfg.get("profiles", [])
    bitrate = None
    for p in profiles:
        if p["name"] == profile:
            bitrate = p.get("bitrate")
            break

    if bitrate is None:
        return jsonify({"error": "unknown profile"}), 400

    # Check cache
    cached = _cache_path(abs_path, bitrate)
    if os.path.isfile(cached):
        return send_file(cached, mimetype="audio/mpeg")

    # Transcode with ffmpeg
    os.makedirs(_cache_dir(), exist_ok=True)
    tmp = cached + ".tmp"
    cmd = [
        "ffmpeg", "-y", "-i", abs_path,
        "-vn",
        "-codec:a", "libmp3lame",
        "-b:a", bitrate,
        "-f", "mp3",
        tmp,
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        os.rename(tmp, cached)
        return send_file(cached, mimetype="audio/mpeg")
    except subprocess.CalledProcessError as e:
        log.error("ffmpeg transcode failed: %s", e.stderr.decode(errors="replace"))
        if os.path.exists(tmp):
            os.remove(tmp)
        return jsonify({"error": "transcode failed"}), 500
    except subprocess.TimeoutExpired:
        if os.path.exists(tmp):
            os.remove(tmp)
        return jsonify({"error": "transcode timeout"}), 500
