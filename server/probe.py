import os
import re
import json
import threading
import subprocess
from collections import OrderedDict
from flask import Blueprint, request, jsonify, current_app

from offload import singleflight

probe_bp = Blueprint("probe", __name__)

# (path, mtime)-keyed LRU of probe results. A single /stream/start used to
# spawn ffprobe up to 4 times for the same unchanged file; thumbnails and
# /media/info re-probe it again.
_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_MAX = 256

# Sidecar subtitle files (Movie.srt, Movie.en.srt, Movie.eng.forced.ass, ...)
# are exposed as subtitle tracks with indices starting here, so they share
# the numeric `sub`/`track` parameters embedded streams already use without
# colliding with ffprobe stream indices.
EXTERNAL_SUB_BASE = 10000
EXTERNAL_SUB_EXTS = {".srt", ".ass", ".ssa", ".vtt", ".sub"}

# Map ISO 639-1 (and a few English names) to the 639-2/B codes ffprobe
# reports for embedded tracks, so sidecars match the user's preferred
# subtitle language setting.
_LANG_ALIASES = {
    "en": "eng", "english": "eng",
    "es": "spa", "spanish": "spa", "espanol": "spa", "español": "spa",
    "fr": "fre", "fra": "fre", "french": "fre",
    "de": "ger", "deu": "ger", "german": "ger",
    "it": "ita", "italian": "ita",
    "pt": "por", "portuguese": "por", "pt-br": "por",
    "ru": "rus", "russian": "rus",
    "ja": "jpn", "jp": "jpn", "japanese": "jpn",
    "zh": "chi", "zho": "chi", "chinese": "chi", "zh-cn": "chi", "zh-tw": "chi",
    "ko": "kor", "korean": "kor",
    "ar": "ara", "arabic": "ara",
    "nl": "dut", "nld": "dut", "dutch": "dut",
    "sv": "swe", "swedish": "swe",
    "no": "nor", "norwegian": "nor",
    "da": "dan", "danish": "dan",
    "fi": "fin", "finnish": "fin",
    "pl": "pol", "polish": "pol",
    "tr": "tur", "turkish": "tur",
    "hi": "hin", "hindi": "hin",
    "th": "tha", "thai": "tha",
    "vi": "vie", "vietnamese": "vie",
    "id": "ind", "indonesian": "ind",
    "he": "heb", "hebrew": "heb",
    "el": "gre", "ell": "gre", "greek": "gre",
    "cs": "cze", "ces": "cze", "czech": "cze",
    "hu": "hun", "hungarian": "hun",
    "ro": "rum", "ron": "rum", "romanian": "rum",
    "uk": "ukr", "ukrainian": "ukr",
}
_SUB_FLAGS = {"forced", "sdh", "hi", "cc", "full", "default"}


def _parse_sidecar_suffix(suffix: str):
    """Turn the part between the video stem and the extension (e.g.
    "en.forced") into (lang, title)."""
    lang = "und"
    flags = []
    for tok in [t for t in re.split(r"[._ ]+", suffix) if t]:
        low = tok.lower()
        if low in _SUB_FLAGS:
            flags.append(low.upper() if low in ("sdh", "cc", "hi") else low)
        elif lang == "und" and low in _LANG_ALIASES:
            lang = _LANG_ALIASES[low]
        elif lang == "und" and len(low) == 3 and low.isalpha():
            lang = low
        else:
            flags.append(tok)
    return lang, " ".join(flags)


def find_external_subtitles(filepath):
    """List sidecar subtitle files next to `filepath` whose name starts with
    the video's stem. Order is deterministic (sorted by filename) so the
    index assigned here can be resolved again later by
    resolve_external_subtitle()."""
    directory = os.path.dirname(filepath)
    stem = os.path.splitext(os.path.basename(filepath))[0]
    stem_low = stem.lower()
    try:
        names = os.listdir(directory)
    except OSError:
        return []
    found = []
    for name in sorted(names, key=str.lower):
        base, ext = os.path.splitext(name)
        if ext.lower() not in EXTERNAL_SUB_EXTS:
            continue
        base_low = base.lower()
        if base_low == stem_low:
            suffix = ""
        elif base_low.startswith(stem_low + "."):
            suffix = base[len(stem) + 1:]
        else:
            continue
        full = os.path.join(directory, name)
        if not os.path.isfile(full):
            continue
        lang, title = _parse_sidecar_suffix(suffix)
        found.append({
            "index": EXTERNAL_SUB_BASE + len(found),
            "path": full,
            "codec": ext.lower().lstrip("."),
            "lang": lang,
            "title": title,
        })
    return found


def resolve_external_subtitle(filepath, idx):
    """Return the sidecar path for an external subtitle index, or None."""
    if idx is None or idx < EXTERNAL_SUB_BASE:
        return None
    for sub in find_external_subtitles(filepath):
        if sub["index"] == idx:
            return sub["path"]
    return None


def ffprobe(filepath):
    try:
        mtime = os.path.getmtime(filepath)
    except OSError:
        mtime = 0
    key = (filepath, mtime)

    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]

    def do_probe():
        with _CACHE_LOCK:
            if key in _CACHE:
                return _CACHE[key]
        cmd = [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_format", "-show_streams",
            filepath
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return None
        try:
            data = json.loads(result.stdout)
        except ValueError:
            return None
        if data is not None:
            with _CACHE_LOCK:
                _CACHE[key] = data
                while len(_CACHE) > _CACHE_MAX:
                    _CACHE.popitem(last=False)
        return data

    return singleflight(("ffprobe", key), do_probe)


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
                "external": False,
            })

    for sub in find_external_subtitles(filepath):
        subtitle_tracks.append({
            "index": sub["index"],
            "codec": sub["codec"],
            "lang": sub["lang"],
            "title": sub["title"],
            "bitmap": False,
            "external": True,
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
    if not filepath.startswith(os.path.realpath(root) + os.sep):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    result = get_media_info(filepath, config)
    if result is None:
        return jsonify({"error": "probe failed"}), 500
    return jsonify(result)
