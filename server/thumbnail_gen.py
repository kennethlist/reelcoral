import os
import hashlib
import subprocess
import json
import queue
import logging
import concurrent.futures
from flask import Blueprint, request, current_app, Response, jsonify
from probe import ffprobe
from thumbnail import CACHE_DIR, IMAGE_EXTS, _find_first_media, cache_path_for

log = logging.getLogger(__name__)

thumbnail_gen_bp = Blueprint("thumbnail_gen", __name__)

_stop_flag = False
_gen_state = {
    "running": False,
    "current": 0,
    "total": 0,
    "name": "",
    "status": "idle",
    "generated": 0,
    "skipped": 0,
    "failed": 0,
}


def _collect_items(root, extensions):
    """Walk the media tree and collect all items that need thumbnails."""
    items = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden directories
        dirnames[:] = sorted([d for d in dirnames if not d.startswith(".")], key=str.lower)
        filenames = sorted([f for f in filenames if not f.startswith(".")], key=str.lower)

        # Add subdirectories (they get thumbnails via _find_first_media)
        for d in dirnames:
            full = os.path.join(dirpath, d)
            rel = os.path.relpath(full, root)
            items.append({"path": full, "rel": rel, "is_dir": True})

        # Add media files
        all_media_exts = extensions | IMAGE_EXTS
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            if ext in all_media_exts:
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root)
                items.append({"path": full, "rel": rel, "is_dir": False, "is_image": ext in IMAGE_EXTS})

    return items


def _cache_path_for(filepath):
    path_hash = hashlib.sha256(filepath.encode()).hexdigest()
    return cache_path_for(path_hash)


def _generate_thumbnail(filepath, cache_path, is_image, extensions):
    """Generate a thumbnail for a single item. Returns True on success."""
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)

    if is_image:
        cmd = [
            "ffmpeg", "-i", filepath,
            "-vf", "scale=320:-1",
            "-frames:v", "1",
            "-y", cache_path
        ]
    else:
        data = ffprobe(filepath)
        duration = float(data.get("format", {}).get("duration", 0)) if data else 0
        seek = max(0, duration * 0.1)
        cmd = [
            "ffmpeg", "-ss", str(seek), "-i", filepath,
            "-vf", "thumbnail=300,scale=320:-1",
            "-frames:v", "1",
            "-y", cache_path
        ]

    try:
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        return result.returncode == 0 and os.path.exists(cache_path)
    except (subprocess.TimeoutExpired, OSError):
        return False


@thumbnail_gen_bp.route("/scan")
def scan():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))

    items = _collect_items(root, extensions)
    total = len(items)
    cached = sum(1 for item in items if os.path.exists(_cache_path_for(item["path"])))
    missing = total - cached

    return jsonify({"total": total, "cached": cached, "missing": missing})


@thumbnail_gen_bp.route("/status")
def status():
    return jsonify(_gen_state)


@thumbnail_gen_bp.route("/progress")
def progress():
    """SSE stream that reports current generation progress (for reconnecting clients)."""
    import time

    def event_stream():
        while _gen_state["running"]:
            data = json.dumps(_gen_state)
            yield f"data: {data}\n\n"
            time.sleep(0.5)
        # Send final state
        data = json.dumps(_gen_state)
        yield f"data: {data}\n\n"

    return Response(event_stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@thumbnail_gen_bp.route("/generate")
def generate():
    global _stop_flag
    _stop_flag = False

    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))
    override = request.args.get("override", "0") == "1"
    threads = config.get("thumbnails", {}).get("threads", 12)

    items = _collect_items(root, extensions)
    total = len(items)
    log.info("Thumbnail generation: %d items, %d threads", total, threads)

    _gen_state.update({
        "running": True, "current": 0, "total": total,
        "name": "", "status": "generating",
        "generated": 0, "skipped": 0, "failed": 0,
    })

    def event_stream():
        global _stop_flag
        generated = 0
        skipped = 0
        failed = 0
        completed = 0

        def process_item(item):
            """Worker function for each thumbnail item."""
            if _stop_flag:
                return None  # Signal to skip

            filepath = item["path"]
            name = item["rel"]
            cache_path = _cache_path_for(filepath)

            # For directories, resolve to the actual media file
            if item["is_dir"]:
                media_file, is_image = _find_first_media(filepath, extensions)
                if not media_file:
                    return {"name": name, "status": "skipped"}
                actual_filepath = media_file
                actual_is_image = is_image
            else:
                actual_filepath = filepath
                actual_is_image = item.get("is_image", False)

            if not override and os.path.exists(cache_path):
                return {"name": name, "status": "skipped"}

            if _stop_flag:
                return None

            success = _generate_thumbnail(actual_filepath, cache_path, actual_is_image, extensions)
            if success:
                return {"name": name, "status": "generated"}
            else:
                return {"name": name, "status": "failed"}

        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=threads) as executor:
                futures = {}
                for item in items:
                    if _stop_flag:
                        break
                    f = executor.submit(process_item, item)
                    futures[f] = item

                for f in concurrent.futures.as_completed(futures):
                    result = f.result()
                    if result is None:
                        # Stopped
                        continue

                    if result["status"] == "skipped":
                        skipped += 1
                    elif result["status"] == "generated":
                        generated += 1
                    elif result["status"] == "failed":
                        failed += 1

                    completed += 1

                    _gen_state.update({
                        "running": not _stop_flag, "current": completed, "total": total,
                        "name": result["name"], "status": "stopped" if _stop_flag else "generating",
                        "generated": generated, "skipped": skipped, "failed": failed,
                    })

                    if _stop_flag:
                        data = json.dumps({
                            "current": completed, "total": total,
                            "name": "", "status": "stopped",
                            "generated": generated, "skipped": skipped, "failed": failed
                        })
                        yield f"data: {data}\n\n"
                        executor.shutdown(wait=False, cancel_futures=True)
                        return

                    data = json.dumps({
                        "current": completed, "total": total,
                        "name": result["name"], "status": result["status"],
                        "generated": generated, "skipped": skipped, "failed": failed
                    })
                    yield f"data: {data}\n\n"

            # Final done event
            data = json.dumps({
                "current": total, "total": total,
                "name": "", "status": "done",
                "generated": generated, "skipped": skipped, "failed": failed
            })
            yield f"data: {data}\n\n"
            _gen_state.update({
                "running": False, "current": total, "total": total,
                "name": "", "status": "done",
                "generated": generated, "skipped": skipped, "failed": failed,
            })
        finally:
            if _gen_state["running"]:
                _gen_state.update({"running": False, "status": "stopped"})

    return Response(event_stream(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@thumbnail_gen_bp.route("/stop", methods=["POST"])
def stop():
    global _stop_flag
    _stop_flag = True
    return jsonify({"ok": True})


@thumbnail_gen_bp.route("/delete-all", methods=["POST"])
def delete_all():
    deleted = 0
    failed = 0
    if os.path.isdir(CACHE_DIR):
        for dirpath, _dirnames, filenames in os.walk(CACHE_DIR):
            for name in filenames:
                if name.endswith(".jpg") and "_candidate_" not in name:
                    try:
                        os.remove(os.path.join(dirpath, name))
                        deleted += 1
                    except OSError:
                        failed += 1
    return jsonify({"deleted": deleted, "failed": failed})
