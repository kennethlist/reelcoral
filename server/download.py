import os
from flask import Blueprint, request, jsonify, send_file, current_app

download_bp = Blueprint("download", __name__)


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root)):
        return None
    return abs_path


@download_bp.route("/download")
def download_file():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    abs_path = _resolve_path(root, path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    return send_file(abs_path, as_attachment=True, download_name=os.path.basename(abs_path))
