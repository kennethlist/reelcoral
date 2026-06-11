import os
import hashlib
import subprocess
import logging
from flask import Blueprint, request, jsonify, current_app, send_file, Response

from offload import singleflight

audio_bp = Blueprint("audio", __name__)
log = logging.getLogger(__name__)

MIME_MAP = {
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",  # Ogg-encapsulated; correct for .opus files too
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wma": "audio/x-ms-wma",
    ".opus": "audio/ogg",
}


def _cache_dir():
    # Sibling of the thumbnail cache, inside the mounted cache volume.
    # (The old repo-relative path resolved inside the container layer, so
    # every restart threw all transcodes away.)
    thumb_cache = os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")
    return os.path.join(os.path.dirname(thumb_cache), "audio")


def _cache_path(abs_path, bitrate):
    try:
        mtime = os.path.getmtime(abs_path)
    except OSError:
        mtime = 0
    h = hashlib.md5(f"{abs_path}|{mtime}".encode()).hexdigest()
    return os.path.join(_cache_dir(), f"{h}_{bitrate}.mp3")


@audio_bp.route("/audio")
def serve_audio():
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

    # Transcode with ffmpeg. singleflight prevents two concurrent requests
    # for the same track from racing on the same tmp file (interleaved
    # writes corrupted the output; the loser's rename raised and 500'd).
    def transcode():
        if os.path.isfile(cached):
            return True
        os.makedirs(_cache_dir(), exist_ok=True)
        tmp = f"{cached}.{os.getpid()}.tmp"
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
            return True
        except subprocess.CalledProcessError as e:
            log.error("ffmpeg transcode failed: %s", e.stderr.decode(errors="replace"))
            return False
        except subprocess.TimeoutExpired:
            log.error("ffmpeg transcode timed out for %s", abs_path)
            return False
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)

    if singleflight(("audio", cached), transcode):
        return send_file(cached, mimetype="audio/mpeg")
    return jsonify({"error": "transcode failed"}), 500
