"""JPEG XL support via ffmpeg (libjxl).

Pillow has no JPEG XL codec and browser support for the format is still
uneven, so every JXL that reaches a browser is decoded server-side with
ffmpeg and re-encoded as JPEG. Thumbnails and the gallery's compressed
endpoint already shell out to ffmpeg; this helper covers the in-memory
comic page path that otherwise uses Pillow.
"""
import logging
import subprocess

log = logging.getLogger(__name__)

JXL_EXTS = {".jxl"}


def is_jxl(name):
    return name.lower().endswith(".jxl")


def ffmpeg_jpeg_quality(quality):
    """Map a 0-100 quality to ffmpeg's mjpeg -q:v scale (1 best .. 31 worst)."""
    return max(1, min(31, (100 - quality) * 31 // 100 + 1))


def jxl_to_jpeg(data, max_width=0, quality=85, timeout=30):
    """Decode JXL bytes with ffmpeg and return JPEG bytes, downscaled to
    max_width when that is > 0. Returns None on failure.

    subprocess is cooperative under gevent, so this is safe to call from a
    request greenlet without run_blocking().
    """
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error",
           "-f", "jpegxl_pipe", "-i", "pipe:0",
           "-frames:v", "1"]
    if max_width > 0:
        cmd += ["-vf", f"scale='min({max_width},iw)':-1"]
    cmd += ["-c:v", "mjpeg", "-q:v", str(ffmpeg_jpeg_quality(quality)),
            "-f", "image2pipe", "pipe:1"]
    try:
        result = subprocess.run(cmd, input=data, capture_output=True, timeout=timeout)
    except Exception as e:
        log.warning("JXL decode failed: %s", e)
        return None
    if result.returncode != 0 or not result.stdout:
        log.warning("JXL decode failed (rc=%s): %s", result.returncode,
                    result.stderr.decode(errors="replace").strip()[:300])
        return None
    return result.stdout
