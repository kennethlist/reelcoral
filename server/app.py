import os
import yaml
from flask import Flask, send_from_directory

def load_config():
    config_path = os.environ.get("KMC_CONFIG", "/config/config.yml")
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "..", "config.yml")
    with open(config_path) as f:
        return yaml.safe_load(f)

def create_app():
    config = load_config()

    app = Flask(__name__, static_folder=None)
    app.secret_key = config["server"]["secret"]
    app.config["KMC"] = config

    from auth import auth_bp, login_required_api
    from browse import browse_bp
    from stream import stream_bp
    from thumbnail import thumbnail_bp
    from subtitle import subtitle_bp
    from probe import probe_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(browse_bp, url_prefix="/api")
    app.register_blueprint(stream_bp, url_prefix="/api/stream")
    app.register_blueprint(thumbnail_bp, url_prefix="/api")
    app.register_blueprint(subtitle_bp, url_prefix="/api")
    app.register_blueprint(probe_bp, url_prefix="/api/media")

    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

    @app.before_request
    def require_auth():
        from flask import request
        if request.path.startswith("/api/auth"):
            return
        if request.path.startswith("/api/"):
            return login_required_api()

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def serve_frontend(path):
        if path and os.path.exists(os.path.join(frontend_dir, path)):
            return send_from_directory(frontend_dir, path)
        return send_from_directory(frontend_dir, "index.html")

    return app

if __name__ == "__main__":
    app = create_app()
    port = app.config["KMC"]["server"].get("port", 8080)
    app.run(host="0.0.0.0", port=port, debug=True)
