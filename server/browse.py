import os
from flask import Blueprint, request, jsonify, current_app

browse_bp = Blueprint("browse", __name__)


@browse_bp.route("/browse")
def browse():
    config = current_app.config["KMC"]
    root = config["media"]["root"]
    extensions = set(config["media"].get("extensions", []))

    rel_path = request.args.get("path", "/").lstrip("/")
    page = max(1, int(request.args.get("page", 1)))
    limit = min(200, max(1, int(request.args.get("limit", 50))))
    search = request.args.get("search", "").lower().strip()

    abs_path = os.path.realpath(os.path.join(root, rel_path))
    if not abs_path.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isdir(abs_path):
        return jsonify({"error": "not found"}), 404

    entries = []
    try:
        items = sorted(os.listdir(abs_path), key=str.lower)
    except PermissionError:
        return jsonify({"error": "permission denied"}), 403

    for name in items:
        if name.startswith("."):
            continue
        full = os.path.join(abs_path, name)
        is_dir = os.path.isdir(full)
        ext = os.path.splitext(name)[1].lower()

        if not is_dir and ext not in extensions:
            continue
        if search and search not in name.lower():
            continue

        entry_path = os.path.join("/", rel_path, name) if rel_path else "/" + name
        entry = {
            "name": name,
            "path": entry_path,
            "is_dir": is_dir,
        }
        if not is_dir:
            try:
                entry["size"] = os.path.getsize(full)
            except OSError:
                entry["size"] = 0
        entries.append(entry)

    # Sort: directories first, then files
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))

    total = len(entries)
    start = (page - 1) * limit
    page_entries = entries[start : start + limit]

    # Build breadcrumbs
    parts = [p for p in rel_path.split("/") if p]
    breadcrumbs = [{"name": "Home", "path": "/"}]
    for i, part in enumerate(parts):
        breadcrumbs.append({
            "name": part,
            "path": "/" + "/".join(parts[: i + 1]),
        })

    return jsonify({
        "entries": page_entries,
        "total": total,
        "page": page,
        "limit": limit,
        "breadcrumbs": breadcrumbs,
    })
