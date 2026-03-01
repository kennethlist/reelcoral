from flask import Blueprint, request, session, jsonify, current_app

auth_bp = Blueprint("auth", __name__)


def login_required_api():
    if "user" not in session:
        return jsonify({"error": "unauthorized"}), 401
    return None


@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")

    users = current_app.config["MEDIA"].get("auth", {}).get("users", [])
    for user in users:
        if user["username"] == username and user["password"] == password:
            session["user"] = username
            session.permanent = True
            return jsonify({"ok": True, "username": username})

    return jsonify({"error": "invalid credentials"}), 401


@auth_bp.route("/logout", methods=["POST"])
def logout():
    session.pop("user", None)
    return jsonify({"ok": True})


@auth_bp.route("/check")
def check():
    if "user" in session:
        return jsonify({"ok": True, "username": session["user"]})
    return jsonify({"error": "unauthorized"}), 401
