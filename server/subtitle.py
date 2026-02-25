import os
import subprocess
from flask import Blueprint, request, jsonify, Response, current_app

subtitle_bp = Blueprint("subtitle", __name__)


@subtitle_bp.route("/subtitle")
def subtitle():
    config = current_app.config["KMC"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    track = request.args.get("track", "")

    if not track:
        return jsonify({"error": "track parameter required"}), 400

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    cmd = [
        "ffmpeg", "-i", filepath,
        "-map", f"0:{track}",
        "-f", "webvtt",
        "-"
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            return jsonify({"error": "subtitle extraction failed"}), 500
        return Response(result.stdout, mimetype="text/vtt")
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout"}), 504
