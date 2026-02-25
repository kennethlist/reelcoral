import json
import subprocess
from flask import Blueprint, request, jsonify, current_app

probe_bp = Blueprint("probe", __name__)


def ffprobe(filepath):
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        filepath
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    return json.loads(result.stdout)


def get_media_info(filepath, config):
    data = ffprobe(filepath)
    if not data:
        return None

    fmt = data.get("format", {})
    duration = float(fmt.get("duration", 0))

    video_tracks = []
    audio_tracks = []
    subtitle_tracks = []

    for stream in data.get("streams", []):
        codec_type = stream.get("codec_type")
        idx = stream.get("index")
        tags = stream.get("tags", {})
        lang = tags.get("language", "und")
        title = tags.get("title", "")

        if codec_type == "video":
            video_tracks.append({
                "index": idx,
                "codec": stream.get("codec_name"),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "lang": lang,
                "title": title,
            })
        elif codec_type == "audio":
            audio_tracks.append({
                "index": idx,
                "codec": stream.get("codec_name"),
                "channels": stream.get("channels"),
                "lang": lang,
                "title": title,
            })
        elif codec_type == "subtitle":
            codec_name = stream.get("codec_name", "")
            bitmap_codecs = {"hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle"}
            subtitle_tracks.append({
                "index": idx,
                "codec": codec_name,
                "lang": lang,
                "title": title,
                "bitmap": codec_name in bitmap_codecs,
            })

    profiles = []
    for p in config.get("transcoding", {}).get("profiles", []):
        entry = {"name": p["name"]}
        if "video_bitrate" in p:
            entry["video_bitrate"] = p["video_bitrate"]
        profiles.append(entry)

    return {
        "duration": duration,
        "video_tracks": video_tracks,
        "audio_tracks": audio_tracks,
        "subtitle_tracks": subtitle_tracks,
        "profiles": profiles,
    }


@probe_bp.route("/info")
def info():
    path = request.args.get("path", "")
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    import os
    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    result = get_media_info(filepath, config)
    if result is None:
        return jsonify({"error": "probe failed"}), 500
    return jsonify(result)
