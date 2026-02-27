import os
import zipfile
from flask import Blueprint, request, jsonify, send_file, current_app, Response
from io import BytesIO

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


@download_bp.route("/download/bulk", methods=["POST"])
def download_bulk():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    data = request.get_json()
    if not data or not isinstance(data.get("paths"), list):
        return jsonify({"error": "paths array required"}), 400

    paths = data["paths"]
    if not paths:
        return jsonify({"error": "no paths provided"}), 400

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel_path in paths:
            abs_path = _resolve_path(root, rel_path)
            if abs_path and os.path.isfile(abs_path):
                zf.write(abs_path, os.path.basename(abs_path))

    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name="download.zip")
