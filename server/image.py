import os
from flask import Blueprint, request, jsonify, current_app, send_file

image_bp = Blueprint("image", __name__)


@image_bp.route("/image")
def serve_image():
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

    return send_file(abs_path)
