import os
import uuid
import time
import shutil
import signal
import subprocess
import threading
import logging
from flask import Blueprint, request, jsonify, current_app, send_file, Response

log = logging.getLogger(__name__)

stream_bp = Blueprint("stream", __name__)

# Global session store
sessions = {}
sessions_lock = threading.Lock()

TMPDIR = os.environ.get("MEDIA_STREAM_TMPDIR", "/tmp/media_streams")

# Codecs that browsers can natively decode in HLS
SAFE_CODECS = {"h264"}


class StreamSession:
    def __init__(self, session_id, filepath, profile_cfg, audio_idx, start_time, config, sub_idx=None):
        self.id = session_id
        self.filepath = filepath
        self.profile = profile_cfg
        self.audio_idx = audio_idx
        self.sub_idx = sub_idx
        self.start_time = start_time
        self.config = config
        self.process = None
        self.dir = os.path.join(TMPDIR, session_id)
        self.last_access = time.time()
        self.started = False
        self.error_log = os.path.join(TMPDIR, f"{session_id}.log")

    def start(self):
        os.makedirs(self.dir, exist_ok=True)

        tc = self.config.get("transcoding", {})
        hw = tc.get("hardware", "software")
        seg_dur = tc.get("segment_duration", 1)
        profile = self.profile

        playlist_path = os.path.join(self.dir, "playlist.m3u8")
        segment_pattern = os.path.join(self.dir, "segment_%d.ts")

        # For "original" profile, probe source codec to decide if transcoding is needed
        needs_transcode = False
        source_width = None
        source_height = None
        source_bitrate = None
        if profile.get("name") == "original":
            from probe import ffprobe
            probe_data = ffprobe(self.filepath)
            if probe_data:
                for s in probe_data.get("streams", []):
                    if s.get("codec_type") == "video":
                        codec_name = s.get("codec_name", "").lower()
                        if codec_name not in SAFE_CODECS:
                            needs_transcode = True
                        source_width = s.get("width")
                        source_height = s.get("height")
                        # Try stream bitrate first, then format bitrate
                        source_bitrate = s.get("bit_rate")
                        break
                if needs_transcode and not source_bitrate:
                    fmt_br = probe_data.get("format", {}).get("bit_rate")
                    source_bitrate = fmt_br

        cmd = ["ffmpeg", "-y"]

        # Seek before input for speed
        if self.start_time > 0:
            cmd += ["-ss", str(self.start_time)]

        # Hardware accel init — skip only for original copy-through (no transcode needed)
        if profile.get("name") != "original" or needs_transcode:
            if hw == "vaapi":
                device = tc.get("vaapi_device", "/dev/dri/renderD128")
                cmd += ["-vaapi_device", device]
            elif hw == "qsv":
                cmd += ["-init_hw_device", "qsv=qsv:MFX_IMPL_hw", "-filter_hw_device", "qsv"]

        # Rate-limit input to ~1x speed to prevent ffmpeg from racing ahead
        # of the player (which causes segment deletion before playback).
        # Initial burst allows fast startup.
        cmd += ["-readrate", "1", "-readrate_initial_burst", "10"]

        cmd += ["-i", self.filepath]

        # Map video + audio
        cmd += ["-map", "0:v:0", "-map", f"0:{self.audio_idx}"]

        # Build subtitle filter if burning in
        sub_filter = ""
        if self.sub_idx is not None and (profile.get("name") != "original" or needs_transcode):
            # sub_idx is the absolute stream index — convert to subtitle stream index
            from probe import ffprobe as _ffprobe
            probe_data = _ffprobe(self.filepath)
            si = 0
            if probe_data:
                for s in probe_data.get("streams", []):
                    if s.get("index") == self.sub_idx:
                        break
                    if s.get("codec_type") == "subtitle":
                        si += 1
            # Escape special characters in filepath for ffmpeg filter
            escaped = self.filepath.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
            if self.start_time > 0:
                sub_filter = (
                    f"setpts=PTS+{self.start_time}/TB,"
                    f"subtitles='{escaped}':si={si},"
                    f"setpts=PTS-{self.start_time}/TB,"
                )
            else:
                sub_filter = f"subtitles='{escaped}':si={si},"

        if profile.get("name") == "original" and not needs_transcode:
            cmd += ["-c:v", "copy", "-c:a", "copy"]
        elif profile.get("name") == "original" and needs_transcode:
            # Transcode non-H.264 source to H.264 at source resolution
            vbr = source_bitrate if source_bitrate else "20M"
            # Convert string bitrate to a reasonable value
            if isinstance(vbr, str) and vbr.isdigit():
                vbr = str(int(int(vbr) / 1000)) + "k"

            if hw == "vaapi":
                if sub_filter:
                    scale_w = source_width if source_width else 1920
                    cmd += [
                        "-vf", f"scale={scale_w}:-2,{sub_filter}format=nv12,hwupload",
                        "-c:v", "h264_vaapi", "-b:v", vbr,
                    ]
                else:
                    scale_w = source_width if source_width else 1920
                    cmd += [
                        "-vf", f"format=nv12,hwupload,scale_vaapi=w={scale_w}:h=-2",
                        "-c:v", "h264_vaapi", "-b:v", vbr,
                    ]
            elif hw == "qsv":
                scale_w = source_width if source_width else 1920
                cmd += [
                    "-vf", f"scale={scale_w}:-2,{sub_filter}".rstrip(","),
                    "-c:v", "h264_qsv", "-b:v", vbr,
                ]
            else:
                scale_w = source_width if source_width else 1920
                cmd += [
                    "-vf", f"scale={scale_w}:-2,{sub_filter}".rstrip(","),
                    "-c:v", "libx264", "-preset", "fast", "-b:v", vbr,
                    "-force_key_frames", f"expr:gte(t,n_forced*{seg_dur})",
                ]
            cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
        else:
            w = profile.get("width", 1920)
            h = profile.get("height", 1080)
            vbr = profile.get("video_bitrate", "6M")
            abr = profile.get("audio_bitrate", "192k")

            if hw == "vaapi":
                # VAAPI handles GOP internally — don't force keyframes
                if sub_filter:
                    cmd += [
                        "-vf", f"scale={w}:-2,{sub_filter}format=nv12,hwupload",
                        "-c:v", "h264_vaapi", "-b:v", vbr,
                    ]
                else:
                    cmd += [
                        "-vf", f"format=nv12,hwupload,scale_vaapi=w={w}:h=-2",
                        "-c:v", "h264_vaapi", "-b:v", vbr,
                    ]
            elif hw == "qsv":
                cmd += [
                    "-vf", f"scale={w}:-2,{sub_filter}".rstrip(","),
                    "-c:v", "h264_qsv", "-b:v", vbr,
                ]
            else:
                cmd += [
                    "-vf", f"scale={w}:-2,{sub_filter}".rstrip(","),
                    "-c:v", "libx264", "-preset", "ultrafast", "-b:v", vbr,
                    "-force_key_frames", f"expr:gte(t,n_forced*{seg_dur})",
                ]

            cmd += ["-c:a", "aac", "-b:a", abr, "-ac", "2"]

        # Original copy uses -readrate 1, so a 60s rolling window is plenty.
        if profile.get("name") == "original" and not needs_transcode:
            list_size = 60
        else:
            list_size = 60

        cmd += [
            "-f", "hls",
            "-hls_time", str(seg_dur),
            "-hls_list_size", str(list_size),
            "-hls_flags", "delete_segments+independent_segments",
            "-hls_segment_filename", segment_pattern,
            playlist_path
        ]

        log.info("Starting ffmpeg for session %s: %s", self.id, " ".join(cmd))
        errfp = open(self.error_log, "w")
        self.process = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=errfp
        )
        self._errfp = errfp
        self.started = True

    def touch(self):
        self.last_access = time.time()

    def is_alive(self):
        """Return True if ffmpeg is still running or exited cleanly (0)."""
        if not self.process:
            return False
        rc = self.process.poll()
        return rc is None or rc == 0

    def has_segments(self):
        """Return True if ffmpeg produced at least one segment."""
        playlist_path = os.path.join(self.dir, "playlist.m3u8")
        try:
            with open(playlist_path, "r") as f:
                return "#EXTINF:" in f.read()
        except OSError:
            return False

    def ffmpeg_failed(self):
        """Return True if ffmpeg exited with an error and produced nothing usable."""
        if not self.process:
            return True
        rc = self.process.poll()
        if rc is not None and rc != 0:
            # If segments were produced, the content is still playable
            if self.has_segments():
                return False
            try:
                with open(self.error_log) as f:
                    tail = f.read()[-2000:]
                log.error("ffmpeg session %s exited %d: %s", self.id, rc, tail)
            except OSError:
                pass
            return True
        return False

    def kill(self):
        if hasattr(self, "_errfp"):
            try:
                self._errfp.close()
            except OSError:
                pass
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
            except (OSError, ProcessLookupError):
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if os.path.isdir(self.dir):
            shutil.rmtree(self.dir, ignore_errors=True)
        try:
            os.unlink(self.error_log)
        except OSError:
            pass


def _cleanup_loop():
    """Kill sessions idle for more than 5 minutes, or with dead ffmpeg (no segments produced)."""
    while True:
        time.sleep(30)
        now = time.time()
        to_kill = []
        with sessions_lock:
            for sid, sess in list(sessions.items()):
                idle = now - sess.last_access > 300
                dead = sess.ffmpeg_failed()
                if idle or dead:
                    if dead:
                        log.warning("Removing dead session %s", sid)
                    to_kill.append(sessions.pop(sid))
        for sess in to_kill:
            sess.kill()

_cleanup_thread = threading.Thread(target=_cleanup_loop, daemon=True)
_cleanup_thread.start()


def _find_keyframe_time(filepath, target_time):
    """Find the PTS of the last keyframe at or before target_time."""
    if target_time <= 0:
        return 0.0
    try:
        probe_start = max(0, target_time - 30)
        cmd = [
            "ffprobe", "-v", "quiet",
            "-select_streams", "v:0",
            "-show_entries", "packet=pts_time,flags",
            "-of", "csv=p=0",
            "-read_intervals", f"{probe_start}%{target_time + 0.5}",
            filepath,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return target_time
        best = 0.0
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue
            parts = line.split(",")
            if len(parts) >= 2 and "K" in parts[1]:
                try:
                    pts = float(parts[0])
                except ValueError:
                    continue
                if pts <= target_time + 0.1:
                    best = max(best, pts)
        return best if best > 0 else target_time
    except Exception:
        return target_time


def _get_profile(config, profile_name):
    profiles = config.get("transcoding", {}).get("profiles", [])
    for p in profiles:
        if p["name"] == profile_name:
            return p
    return profiles[0] if profiles else {"name": "original"}


@stream_bp.route("/start")
def start():
    t0 = time.time()
    from probe import get_media_info

    config = current_app.config["MEDIA"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    profile_name = request.args.get("profile", "720p")
    audio_idx = int(request.args.get("audio", 0))
    start_time = float(request.args.get("start", 0))
    sub_idx_str = request.args.get("sub", "")
    sub_idx = int(sub_idx_str) if sub_idx_str else None
    replace_sid = request.args.get("replace", "")
    log.info("STREAM START: profile=%s audio=%d sub=%s start=%.1f replace=%s", profile_name, audio_idx, sub_idx, start_time, replace_sid or "none")

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    # Atomically kill the replaced session before checking max_sessions
    replaced_sess = None
    if replace_sid:
        with sessions_lock:
            replaced_sess = sessions.pop(replace_sid, None)
        if replaced_sess:
            replaced_sess.kill()

    # Check max sessions
    max_sessions = config.get("transcoding", {}).get("max_sessions", 4)
    with sessions_lock:
        if len(sessions) >= max_sessions:
            return jsonify({"error": "too many active sessions"}), 429

    # Run ffprobe and start ffmpeg in parallel threads
    media_info = {}
    probe_error = [None]

    def do_probe():
        try:
            media_info.update(get_media_info(filepath, config) or {})
        except Exception as e:
            probe_error[0] = e

    probe_thread = threading.Thread(target=do_probe)
    probe_thread.start()

    profile = _get_profile(config, profile_name)

    # For copy-mode streams, probe the actual keyframe start time in parallel
    keyframe_time = [start_time]
    kf_thread = None
    if profile.get("name") == "original" and start_time > 0:
        def do_kf_probe():
            keyframe_time[0] = _find_keyframe_time(filepath, start_time)
        kf_thread = threading.Thread(target=do_kf_probe)
        kf_thread.start()

    session_id = str(uuid.uuid4())
    sess = StreamSession(session_id, filepath, profile, audio_idx, start_time, config, sub_idx)

    t1 = time.time()
    try:
        sess.start()
    except Exception as e:
        sess.kill()
        probe_thread.join()
        if kf_thread:
            kf_thread.join()
        return jsonify({"error": str(e)}), 500
    t2 = time.time()

    with sessions_lock:
        sessions[session_id] = sess

    probe_thread.join()
    if kf_thread:
        kf_thread.join()
    t3 = time.time()
    log.info("TIMING /start: ffmpeg_launch=%.2fs probe_wait=%.2fs total=%.2fs",
             t2 - t1, t3 - t2, t3 - t0)

    result = {
        "session_id": session_id,
        "playlist": f"/api/stream/{session_id}/playlist.m3u8",
    }
    if media_info:
        result["media_info"] = media_info
    # For copy-mode streams, tell the frontend the actual keyframe start time
    if keyframe_time[0] != start_time:
        result["actual_start"] = keyframe_time[0]
    return jsonify(result)


@stream_bp.route("/<session_id>/playlist.m3u8")
def playlist(session_id):
    t0 = time.time()
    with sessions_lock:
        sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.touch()

    playlist_path = os.path.join(sess.dir, "playlist.m3u8")
    seg_dur = sess.config.get("transcoding", {}).get("segment_duration", 2)

    if sess.ffmpeg_failed():
        return jsonify({"error": "transcoding failed"}), 500

    # Serve real playlist if ready, otherwise a stub for hls.js to poll
    try:
        with open(playlist_path, "r") as f:
            content = f.read()
        if "#EXTINF:" in content:
            log.info("TIMING playlist %s: ready in %.2fs", session_id[:8], time.time() - t0)
            return Response(content, mimetype="application/vnd.apple.mpegurl")
    except OSError:
        pass

    log.info("TIMING playlist %s: stub at %.2fs", session_id[:8], time.time() - t0)
    stub = (
        "#EXTM3U\n"
        "#EXT-X-VERSION:3\n"
        f"#EXT-X-TARGETDURATION:{seg_dur}\n"
        "#EXT-X-MEDIA-SEQUENCE:0\n"
    )
    return Response(stub, mimetype="application/vnd.apple.mpegurl")


@stream_bp.route("/<session_id>/<segment>")
def segment(session_id, segment):
    with sessions_lock:
        sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.touch()

    seg_path = os.path.join(sess.dir, segment)

    # Wait for segment file to appear (up to 30s), bail early if ffmpeg died
    for _ in range(300):
        if os.path.exists(seg_path) and os.path.getsize(seg_path) > 0:
            break
        if sess.ffmpeg_failed():
            return jsonify({"error": "transcoding failed"}), 500
        time.sleep(0.1)
    else:
        return jsonify({"error": "segment not ready"}), 504

    # Wait until file size stabilizes (ffmpeg finished writing)
    prev_size = -1
    for _ in range(50):
        try:
            cur_size = os.path.getsize(seg_path)
        except OSError:
            break
        if cur_size == prev_size:
            break
        prev_size = cur_size
        time.sleep(0.05)

    return send_file(seg_path, mimetype="video/MP2T")


@stream_bp.route("/<session_id>", methods=["DELETE"])
def stop(session_id):
    with sessions_lock:
        sess = sessions.pop(session_id, None)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.kill()
    return jsonify({"ok": True})
