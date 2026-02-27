import os
import logging
import yaml
from flask import Flask, send_from_directory

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

def load_config():
    config_path = os.environ.get("MEDIA_CONFIG", "/config/config.yml")
    if not os.path.exists(config_path):
        config_path = os.path.join(os.path.dirname(__file__), "..", "config.yml")
    with open(config_path) as f:
        return yaml.safe_load(f)

def create_app():
    config = load_config()

    app = Flask(__name__, static_folder=None)
    app.secret_key = config["server"]["secret"]
    app.config["MEDIA"] = config

    from auth import auth_bp, login_required_api
    from browse import browse_bp
    from stream import stream_bp
    from thumbnail import thumbnail_bp
    from subtitle import subtitle_bp
    from probe import probe_bp
    from image import image_bp
    from audio import audio_bp
    from thumbnail_select import thumbnail_select_bp
    from ebook import ebook_bp
    from comic import comic_bp
    from pdf import pdf_bp
    from download import download_bp
    from markdown_view import markdown_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(browse_bp, url_prefix="/api")
    app.register_blueprint(stream_bp, url_prefix="/api/stream")
    app.register_blueprint(thumbnail_bp, url_prefix="/api")
    app.register_blueprint(thumbnail_select_bp, url_prefix="/api")
    app.register_blueprint(subtitle_bp, url_prefix="/api")
    app.register_blueprint(probe_bp, url_prefix="/api/media")
    app.register_blueprint(image_bp, url_prefix="/api")
    app.register_blueprint(audio_bp, url_prefix="/api")
    app.register_blueprint(ebook_bp, url_prefix="/api/ebook")
    app.register_blueprint(comic_bp, url_prefix="/api/comic")
    app.register_blueprint(pdf_bp, url_prefix="/api/pdf")
    app.register_blueprint(download_bp, url_prefix="/api")
    app.register_blueprint(markdown_bp, url_prefix="/api/markdown")

    frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")

    @app.route("/api/config")
    def get_config():
        from flask import jsonify
        thumbnails_cfg = config.get("thumbnails", {})
        defaults_cfg = config.get("defaults", {})
        profiles = [
            {"name": p["name"], "video_bitrate": p.get("video_bitrate")}
            for p in config.get("transcoding", {}).get("profiles", [])
        ]
        music_cfg = config.get("music", {})
        music_profiles = [
            {"name": p["name"], "bitrate": p.get("bitrate")}
            for p in music_cfg.get("profiles", [])
        ]
        music_folders = config.get("media", {}).get("music_folders", [])

        return jsonify({
            "generate_on_fly": thumbnails_cfg.get("generate_on_fly", True),
            "profiles": profiles,
            "defaults": {
                "quality": defaults_cfg.get("quality", "720p"),
                "audio_lang": defaults_cfg.get("audio_lang", "eng"),
                "subtitle_lang": defaults_cfg.get("subtitle_lang", "eng"),
                "subtitles_enabled": defaults_cfg.get("subtitles_enabled", True),
                "subtitle_mode": defaults_cfg.get("subtitle_mode", "external"),
                "thumbnail_candidates": defaults_cfg.get("thumbnail_candidates", 3),
                "grid_size": defaults_cfg.get("grid_size", "small"),
            },
            "music_folders": music_folders,
            "music_profiles": music_profiles,
        })

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
    port = app.config["MEDIA"]["server"].get("port", 8080)
    app.run(host="0.0.0.0", port=port, debug=True)
