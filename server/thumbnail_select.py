import os
import json
import hashlib
import random
import shutil
import subprocess
import time
from flask import Blueprint, request, current_app, jsonify, send_file
from probe import ffprobe
from thumbnail import CACHE_DIR, IMAGE_EXTS, _find_first_media, cache_path_for

thumbnail_select_bp = Blueprint("thumbnail_select", __name__)

OVERRIDES_FILE = os.path.join(os.path.dirname(CACHE_DIR), "thumbnail_overrides.json")
CANDIDATE_POSITIONS = [0.10, 0.25, 0.40, 0.55, 0.70, 0.85]
MAX_DIR_SCAN = 5000  # stop scanning after this many files to keep it fast


def _load_overrides():
    if os.path.exists(OVERRIDES_FILE):
        with open(OVERRIDES_FILE) as f:
            return json.load(f)
    return {}


def _save_overrides(data):
    os.makedirs(os.path.dirname(OVERRIDES_FILE), exist_ok=True)
    with open(OVERRIDES_FILE, "w") as f:
        json.dump(data, f)


def _collect_media_files(dirpath, video_exts, image_exts=IMAGE_EXTS, depth=5):
    """Collect media files from a directory, separated into images and videos.
    Stops after MAX_DIR_SCAN files to stay fast on large directories."""
    images = []
    videos = []
    seen = 0

    def _walk(d, remaining_depth):
        nonlocal seen
        if remaining_depth <= 0 or seen >= MAX_DIR_SCAN:
            return
        try:
            items = os.listdir(d)
        except (PermissionError, OSError):
            return
        dirs = []
        for name in items:
            if name.startswith("."):
                continue
            full = os.path.join(d, name)
            if os.path.isfile(full):
                seen += 1
                ext = os.path.splitext(name)[1].lower()
                if ext in image_exts:
                    images.append(full)
                elif ext in video_exts:
                    videos.append(full)
            elif os.path.isdir(full):
                dirs.append(full)
            if seen >= MAX_DIR_SCAN:
                return
        for sub in dirs:
            _walk(sub, remaining_depth - 1)
            if seen >= MAX_DIR_SCAN:
                return

    _walk(dirpath, depth)
    return images, videos


def _resolve_path(path):
    """Resolve a browse path to an absolute filepath, validating it's under the media root."""
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return None, None
    return filepath, config


def _resolve_media(filepath, config):
    """For directories, find the first media file. Returns (media_path, hash, is_image) or (None, None, False)."""
    extensions = set(config["media"].get("extensions", []))
    from thumbnail import IMAGE_EXTS
    if os.path.isdir(filepath):
        media_file, is_image = _find_first_media(filepath, extensions)
        if not media_file:
            return None, None, False
        media_path = media_file
    else:
        ext = os.path.splitext(filepath)[1].lower()
        is_image = ext in IMAGE_EXTS
        media_path = filepath
    path_hash = hashlib.sha256(media_path.encode()).hexdigest()
    return media_path, path_hash, is_image


def _generate_video_frame(video_path, candidate_path, position_frac):
    """Extract a single frame from a video at the given fraction of duration."""
    data = ffprobe(video_path)
    duration = float(data.get("format", {}).get("duration", 0)) if data else 0
    if duration <= 0:
        return False
    seek = max(0, duration * position_frac)
    cmd = [
        "ffmpeg", "-ss", str(seek), "-i", video_path,
        "-vf", "thumbnail=300,scale=320:-1",
        "-frames:v", "1",
        "-y", candidate_path,
    ]
    subprocess.run(cmd, capture_output=True, timeout=30)
    return os.path.exists(candidate_path)


def _generate_image_thumb(image_path, candidate_path):
    """Resize an image to a thumbnail."""
    cmd = [
        "ffmpeg", "-i", image_path,
        "-vf", "scale=320:-1",
        "-frames:v", "1",
        "-y", candidate_path,
    ]
    subprocess.run(cmd, capture_output=True, timeout=30)
    return os.path.exists(candidate_path)


@thumbnail_select_bp.route("/thumbnail/candidates")
def candidates():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "path required"}), 400

    filepath, config = _resolve_path(path)
    if not filepath:
        return jsonify({"error": "forbidden"}), 403

    extensions = set(config["media"].get("extensions", []))
    os.makedirs(CACHE_DIR, exist_ok=True)

    # Use a hash of the browse path for candidate cache keys
    browse_hash = hashlib.sha256(path.encode()).hexdigest()
    ts = int(time.time() * 1000)

    if os.path.isdir(filepath):
        # Directory: pick up to 3 random images + 3 random videos
        images, videos = _collect_media_files(filepath, extensions)
        sample_images = random.sample(images, min(3, len(images)))
        sample_videos = random.sample(videos, min(3, len(videos)))
        sampled = [(f, True) for f in sample_images] + [(f, False) for f in sample_videos]

        if not sampled:
            return jsonify({"candidates": []})

        urls = []
        for i, (media_file, is_img) in enumerate(sampled):
            candidate_path = os.path.join(CACHE_DIR, f"{browse_hash}_candidate_{i}.jpg")
            if is_img:
                _generate_image_thumb(media_file, candidate_path)
            else:
                _generate_video_frame(media_file, candidate_path, random.choice(CANDIDATE_POSITIONS))
            if os.path.exists(candidate_path):
                urls.append(f"/api/thumbnail/candidates/{browse_hash}/{i}?v={ts}")
            else:
                urls.append(None)

        return jsonify({"candidates": urls})

    else:
        # Single file: one candidate
        is_image = os.path.splitext(filepath)[1].lower() in IMAGE_EXTS
        candidate_path = os.path.join(CACHE_DIR, f"{browse_hash}_candidate_0.jpg")
        if is_image:
            _generate_image_thumb(filepath, candidate_path)
        else:
            pos = random.choice(CANDIDATE_POSITIONS)
            _generate_video_frame(filepath, candidate_path, pos)

        if os.path.exists(candidate_path):
            return jsonify({"candidates": [f"/api/thumbnail/candidates/{browse_hash}/0?v={ts}"]})
        return jsonify({"candidates": [None]})


@thumbnail_select_bp.route("/thumbnail/candidates/<path_hash>/<int:index>")
def serve_candidate(path_hash, index):
    candidate_path = os.path.join(CACHE_DIR, f"{path_hash}_candidate_{index}.jpg")
    if not os.path.exists(candidate_path):
        return jsonify({"error": "not found"}), 404
    return send_file(candidate_path, mimetype="image/jpeg")


@thumbnail_select_bp.route("/thumbnail/select", methods=["POST"])
def select():
    content_type = request.content_type or ""

    if "multipart/form-data" in content_type:
        path = request.form.get("path", "")
        image = request.files.get("image")
        if not path or not image:
            return jsonify({"error": "path and image required"}), 400

        filepath, config = _resolve_path(path)
        if not filepath:
            return jsonify({"error": "forbidden"}), 403

        media_path, path_hash, _ = _resolve_media(filepath, config)
        if not media_path:
            return jsonify({"error": "no media found"}), 404

        cache_path = cache_path_for(path_hash)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)

        # Save upload to temp file, then resize with ffmpeg
        tmp_path = cache_path + ".tmp"
        image.save(tmp_path)
        cmd = [
            "ffmpeg", "-i", tmp_path,
            "-vf", "scale=320:-1",
            "-frames:v", "1",
            "-y", cache_path,
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if result.returncode != 0:
            return jsonify({"error": "image processing failed"}), 500

    else:
        data = request.get_json()
        if not data or "path" not in data:
            return jsonify({"error": "path required"}), 400

        path = data["path"]
        index = data.get("index")
        if index is None:
            return jsonify({"error": "index required for candidate selection"}), 400

        filepath, config = _resolve_path(path)
        if not filepath:
            return jsonify({"error": "forbidden"}), 403

        media_path, path_hash, _ = _resolve_media(filepath, config)
        if not media_path:
            return jsonify({"error": "no media found"}), 404

        # Candidates are keyed by browse path hash, main cache by media file hash
        browse_hash = hashlib.sha256(path.encode()).hexdigest()
        candidate_path = os.path.join(CACHE_DIR, f"{browse_hash}_candidate_{index}.jpg")
        if not os.path.exists(candidate_path):
            return jsonify({"error": "candidate not found"}), 404

        cache_path = cache_path_for(path_hash)
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        shutil.copy2(candidate_path, cache_path)

    overrides = _load_overrides()
    overrides[path] = path_hash
    _save_overrides(overrides)

    return jsonify({"ok": True})


@thumbnail_select_bp.route("/thumbnail/select", methods=["DELETE"])
def reset():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "path required"}), 400

    filepath, config = _resolve_path(path)
    if not filepath:
        return jsonify({"error": "forbidden"}), 403

    media_path, path_hash, _ = _resolve_media(filepath, config)
    if not media_path:
        return jsonify({"error": "no media found"}), 404

    # Remove cached thumbnail so it regenerates on next request
    cache_path = cache_path_for(path_hash)
    if os.path.exists(cache_path):
        os.remove(cache_path)

    # Remove override entry
    overrides = _load_overrides()
    overrides.pop(path, None)
    _save_overrides(overrides)

    return jsonify({"ok": True})
