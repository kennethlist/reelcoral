import os
import logging
from flask import Blueprint, request, jsonify, current_app

markdown_bp = Blueprint("markdown", __name__)
log = logging.getLogger(__name__)


def _resolve_path(root, rel_path):
    abs_path = os.path.realpath(os.path.join(root, rel_path.lstrip("/")))
    if not abs_path.startswith(os.path.realpath(root) + os.sep):
        return None
    return abs_path


@markdown_bp.route("/info")
def markdown_info():
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    rel_path = request.args.get("path", "")
    abs_path = _resolve_path(root, rel_path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    title = os.path.splitext(os.path.basename(abs_path))[0]
    return jsonify({"title": title})


@markdown_bp.route("/content")
def markdown_content():
    import markdown

    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    rel_path = request.args.get("path", "")
    abs_path = _resolve_path(root, rel_path)
    if not abs_path or not os.path.isfile(abs_path):
        return jsonify({"error": "not found"}), 404

    with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    extensions = ["fenced_code", "tables", "toc", "sane_lists"]
    # codehilite lives at markdown.extensions.codehilite and needs Pygments;
    # the old `import codehilite` could never succeed, silently disabling
    # syntax highlighting.
    import importlib.util
    if importlib.util.find_spec("pygments") is not None:
        extensions.append("codehilite")

    html = markdown.markdown(text, extensions=extensions)
    return jsonify({"html": html})
