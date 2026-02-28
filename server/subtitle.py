import os
import re
import subprocess
from flask import Blueprint, request, jsonify, Response, current_app

subtitle_bp = Blueprint("subtitle", __name__)

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
        # Drop cues that end before 0
        if end < 0:
            return match.group(0)  # will be filtered by caller or ignored
        return f"{_format_ts(start)} --> {_format_ts(end)}"
    return _TS_RE.sub(replace_ts, vtt)


@subtitle_bp.route("/subtitle")
def subtitle():
    """Return subtitles as JSON cues for precise client-side rendering."""
    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    track = request.args.get("track", "")
    offset = float(request.args.get("offset", 0))

    if not track:
        return jsonify({"error": "track parameter required"}), 400

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    fmt = request.args.get("fmt", "vtt")

    cmd = [
        "ffmpeg", "-i", filepath,
        "-map", f"0:{track}",
        "-f", "webvtt",
        "-"
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=120)
        if result.returncode != 0:
            return jsonify({"error": "subtitle extraction failed"}), 500
        vtt = result.stdout.decode("utf-8", errors="replace")

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

        if offset > 0:
            vtt = _shift_vtt(vtt, offset)
        return Response(vtt, mimetype="text/vtt")
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout"}), 504
