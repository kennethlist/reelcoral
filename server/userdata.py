import json
from flask import Blueprint, request, session, jsonify
import db

userdata_bp = Blueprint("userdata", __name__)


def _user_id():
    return session.get("user", "anonymous")


@userdata_bp.route("/preferences", methods=["GET"])
def get_preferences():
    data = json.loads(db.get_preferences(_user_id()))
    return jsonify(data)


@userdata_bp.route("/preferences", methods=["PUT"])
def save_preferences():
    body = request.get_json(silent=True) or {}
    db.save_preferences(_user_id(), json.dumps(body))
    return jsonify({"ok": True})


@userdata_bp.route("/data/<key>", methods=["GET"])
def get_data(key):
    if key not in ("read_positions", "reader_settings", "dir_sort"):
        return jsonify({"error": "invalid key"}), 400
    data = json.loads(db.get_user_data(_user_id(), key))
    return jsonify(data)


@userdata_bp.route("/data/<key>", methods=["PUT"])
def save_data(key):
    if key not in ("read_positions", "reader_settings", "dir_sort"):
        return jsonify({"error": "invalid key"}), 400
    body = request.get_json(silent=True) or {}
    db.save_user_data(_user_id(), key, json.dumps(body))
    return jsonify({"ok": True})


@userdata_bp.route("/file-status", methods=["POST"])
def set_file_status():
    body = request.get_json(silent=True) or {}
    path = body.get("path")
    status = body.get("status", "opened")
    if not path:
        return jsonify({"error": "path required"}), 400
    if status not in ("opened", "completed"):
        return jsonify({"error": "invalid status"}), 400
    db.set_file_status(_user_id(), path, status)
    return jsonify({"ok": True})


@userdata_bp.route("/file-status", methods=["DELETE"])
def clear_file_status():
    body = request.get_json(silent=True) or {}
    path = body.get("path")
    if not path:
        return jsonify({"error": "path required"}), 400
    db.clear_file_status(_user_id(), path)
    return jsonify({"ok": True})


@userdata_bp.route("/migrate", methods=["POST"])
def migrate():
    """One-time migration from localStorage to server DB."""
    user_id = _user_id()
    body = request.get_json(silent=True) or {}

    # Migrate preferences
    prefs = {}
    if "preferences" in body and isinstance(body["preferences"], dict):
        prefs = body["preferences"]
    if "music_volume" in body:
        prefs["music_volume"] = body["music_volume"]
    if "music_profile" in body:
        prefs["music_profile"] = body["music_profile"]
    if prefs:
        # Merge with existing server preferences
        existing = json.loads(db.get_preferences(user_id))
        existing.update(prefs)
        db.save_preferences(user_id, json.dumps(existing))

    # Migrate read positions
    if "read_positions" in body and isinstance(body["read_positions"], dict):
        existing = json.loads(db.get_user_data(user_id, "read_positions"))
        existing.update(body["read_positions"])
        db.save_user_data(user_id, "read_positions", json.dumps(existing))

    # Migrate reader settings
    if "reader_settings" in body and isinstance(body["reader_settings"], dict):
        existing = json.loads(db.get_user_data(user_id, "reader_settings"))
        existing.update(body["reader_settings"])
        db.save_user_data(user_id, "reader_settings", json.dumps(existing))

    return jsonify({"ok": True})
