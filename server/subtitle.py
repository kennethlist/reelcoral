import os
import re
import hashlib
import subprocess
from flask import Blueprint, request, jsonify, Response, current_app

from offload import singleflight

subtitle_bp = Blueprint("subtitle", __name__)

# Extracted-track cache: extraction demuxes the whole container (slow), but the
# result only depends on (file, track, mtime). Offsets are applied per request
# on top of the cached, unmodified VTT, so caching cannot affect sync.
CACHE_DIR = os.path.join(
    os.path.dirname(os.environ.get("MEDIA_CACHE_DIR", "/cache/thumbnails")), "subs"
)

# Matches WebVTT timestamps: "HH:MM:SS.mmm" or "MM:SS.mmm"
_TS_RE = re.compile(
    r"((?:\d{2}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}\.\d{3})"
)

# Regex to strip HTML tags (keep inner text)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
# Lines that are entirely bracketed annotations or music symbols
_JUNK_LINE_RE = re.compile(
    r"^\s*(?:"
    r"\[.*\]"       # [music], [laughing], etc.
    r"|\(.*\)"      # (music), (laughing), etc.
    r"|\{.*\}"      # {music}, etc.
    r"|[♪♫♬♩\s]+"   # music symbols only
    r")\s*$"
)
# Inline bracketed annotations to strip from mixed lines
_INLINE_ANNOTATION_RE = re.compile(r"\[.*?\]|\(.*?\)|\{.*?\}")


def _clean_sub_text(text: str) -> str:
    """Remove non-dialog junk from subtitle text."""
    # Strip HTML tags, keep inner text
    text = _HTML_TAG_RE.sub("", text)
    # Process line by line
    cleaned = []
    for line in text.split("\n"):
        # Skip lines that are entirely junk
        if _JUNK_LINE_RE.match(line):
            continue
        # Strip inline annotations from mixed lines
        line = _INLINE_ANNOTATION_RE.sub("", line).strip()
        if line:
            cleaned.append(line)
    return "\n".join(cleaned)


def _parse_ts(ts: str) -> float:
    """Parse 'HH:MM:SS.mmm' or 'MM:SS.mmm' to seconds."""
    parts = ts.split(":")
    if len(parts) == 3:
        h, m, rest = parts
        s, ms = rest.split(".")
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000
    else:
        m, rest = parts
        s, ms = rest.split(".")
        return int(m) * 60 + int(s) + int(ms) / 1000


def _format_ts(seconds: float) -> str:
    """Format seconds to 'HH:MM:SS.mmm'."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def _shift_vtt(vtt: str, offset: float) -> str:
    """Shift all WebVTT timestamps by -offset seconds."""
    def replace_ts(match):
        start = _parse_ts(match.group(1)) - offset
        end = _parse_ts(match.group(2)) - offset
        # Cues that end before 0 must never display: collapse to a
        # zero-length cue at 0. (Returning the original unshifted
        # timestamps here would resurface old cues at wrong times.)
        if end < 0:
            start = end = 0
        return f"{_format_ts(start)} --> {_format_ts(end)}"
    return _TS_RE.sub(replace_ts, vtt)


def _extract_vtt(filepath: str, track: str) -> bytes:
    """Extract a subtitle track as WebVTT, cached on disk keyed by file mtime.

    The cache stores the raw ffmpeg output, byte-identical to a fresh
    extraction; offset shifting and JSON conversion happen per request.
    """
    try:
        mtime = os.path.getmtime(filepath)
    except OSError:
        mtime = 0
    key = hashlib.sha256(f"{filepath}|{track}|{mtime}".encode()).hexdigest()
    cache_path = os.path.join(CACHE_DIR, key[:2], f"{key}.vtt")

    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return f.read()

    def do_extract():
        if os.path.exists(cache_path):
            with open(cache_path, "rb") as f:
                return f.read()
        cmd = [
            "ffmpeg", "-i", filepath,
            "-map", f"0:{track}",
            "-f", "webvtt",
            "-"
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError("subtitle extraction failed")
        data = result.stdout
        try:
            os.makedirs(os.path.dirname(cache_path), exist_ok=True)
            tmp = cache_path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.rename(tmp, cache_path)
        except OSError:
            pass
        return data

    return singleflight(("subtitle", cache_path), do_extract)


@subtitle_bp.route("/subtitle")
def subtitle():
    """Return subtitles as JSON cues for precise client-side rendering."""
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    track = request.args.get("track", "")
    try:
        offset = float(request.args.get("offset", 0))
    except ValueError:
        return jsonify({"error": "invalid offset"}), 400

    if not track or not re.fullmatch(r"\d+", track):
        return jsonify({"error": "track parameter required"}), 400

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root) + os.sep):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    fmt = request.args.get("fmt", "vtt")

    try:
        vtt = _extract_vtt(filepath, track).decode("utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout"}), 504
    except RuntimeError:
        return jsonify({"error": "subtitle extraction failed"}), 500

    if fmt == "json":
        # Parse VTT into JSON cues with offset applied
        cues = []
        blocks = re.split(r"\n\n+", vtt)
        for block in blocks:
            m = _TS_RE.search(block)
            if not m:
                continue
            start = _parse_ts(m.group(1)) - offset
            end = _parse_ts(m.group(2)) - offset
            if end <= 0:
                continue
            if start < 0:
                start = 0
            # Text is everything after the timestamp line
            lines = block.split("\n")
            text_lines = []
            found_ts = False
            for line in lines:
                if found_ts:
                    text_lines.append(line)
                elif _TS_RE.search(line):
                    found_ts = True
            text = _clean_sub_text("\n".join(text_lines).strip())
            if text:
                cues.append({"start": round(start, 3), "end": round(end, 3), "text": text})
        return jsonify(cues)

    if offset != 0:
        vtt = _shift_vtt(vtt, offset)
    return Response(vtt, mimetype="text/vtt")
