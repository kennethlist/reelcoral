import os
import uuid
import time
import shutil
import signal
import subprocess
import threading
from flask import Blueprint, request, jsonify, current_app, send_file, Response

stream_bp = Blueprint("stream", __name__)

# Global session store
sessions = {}
sessions_lock = threading.Lock()

TMPDIR = os.environ.get("KMC_STREAM_TMPDIR", "/tmp/kmc_streams")


class StreamSession:
    def __init__(self, session_id, filepath, profile_cfg, audio_idx, start_time, config):
        self.id = session_id
        self.filepath = filepath
        self.profile = profile_cfg
        self.audio_idx = audio_idx
        self.start_time = start_time
        self.config = config
        self.process = None
        self.dir = os.path.join(TMPDIR, session_id)
        self.last_access = time.time()
        self.started = False

    def start(self):
        os.makedirs(self.dir, exist_ok=True)

        tc = self.config.get("transcoding", {})
        hw = tc.get("hardware", "software")
        seg_dur = tc.get("segment_duration", 4)
        profile = self.profile

        playlist_path = os.path.join(self.dir, "playlist.m3u8")
        segment_pattern = os.path.join(self.dir, "segment_%d.ts")

        cmd = ["ffmpeg", "-y"]

        # Seek before input for speed
        if self.start_time > 0:
            cmd += ["-ss", str(self.start_time)]

        # Hardware accel init
        if profile.get("name") != "original" and hw == "vaapi":
            device = tc.get("vaapi_device", "/dev/dri/renderD128")
            cmd += ["-vaapi_device", device]
        elif profile.get("name") != "original" and hw == "qsv":
            cmd += ["-init_hw_device", "qsv=qsv:MFX_IMPL_hw", "-filter_hw_device", "qsv"]

        cmd += ["-i", self.filepath]

        # Map video + audio
        cmd += ["-map", "0:v:0", "-map", f"0:{self.audio_idx}"]

        if profile.get("name") == "original":
            cmd += ["-c:v", "copy", "-c:a", "copy"]
        else:
            w = profile.get("width", 1920)
            h = profile.get("height", 1080)
            vbr = profile.get("video_bitrate", "6M")
            abr = profile.get("audio_bitrate", "192k")

            if hw == "vaapi":
                cmd += [
                    "-vf", f"format=nv12,hwupload,scale_vaapi=w={w}:h=-2",
                    "-c:v", "h264_vaapi", "-b:v", vbr,
                ]
            elif hw == "qsv":
                cmd += [
                    "-vf", f"scale={w}:-2",
                    "-c:v", "h264_qsv", "-b:v", vbr,
                ]
            else:
                cmd += [
                    "-vf", f"scale={w}:-2",
                    "-c:v", "libx264", "-preset", "veryfast", "-b:v", vbr,
                ]

            cmd += ["-c:a", "aac", "-b:a", abr, "-ac", "2"]

        cmd += [
            "-f", "hls",
            "-hls_time", str(seg_dur),
            "-hls_list_size", "0",
            "-hls_flags", "delete_segments+independent_segments",
            "-hls_segment_filename", segment_pattern,
            playlist_path
        ]

        self.process = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        self.started = True

    def touch(self):
        self.last_access = time.time()

    def kill(self):
        if self.process and self.process.poll() is None:
            try:
                os.killpg(os.getpgid(self.process.pid), signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if os.path.isdir(self.dir):
            shutil.rmtree(self.dir, ignore_errors=True)


def _cleanup_loop():
    """Kill sessions idle for more than 5 minutes."""
    while True:
        time.sleep(30)
        now = time.time()
        to_kill = []
        with sessions_lock:
            for sid, sess in list(sessions.items()):
                if now - sess.last_access > 300:
                    to_kill.append(sid)
            for sid in to_kill:
                sessions.pop(sid, None)
        for sid in to_kill:
            # sess reference from loop above is stale, but we already popped
            pass
        # Actually kill them
        with sessions_lock:
            pass  # already removed
        # We need to keep refs to kill
        # Let's fix this:
        pass

# Better cleanup
def _cleanup_loop_v2():
    while True:
        time.sleep(30)
        now = time.time()
        to_kill = []
        with sessions_lock:
            for sid, sess in list(sessions.items()):
                if now - sess.last_access > 300:
                    to_kill.append(sessions.pop(sid))
        for sess in to_kill:
            sess.kill()

_cleanup_thread = threading.Thread(target=_cleanup_loop_v2, daemon=True)
_cleanup_thread.start()


def _get_profile(config, profile_name):
    profiles = config.get("transcoding", {}).get("profiles", [])
    for p in profiles:
        if p["name"] == profile_name:
            return p
    return profiles[0] if profiles else {"name": "original"}


@stream_bp.route("/start")
def start():
    config = current_app.config["KMC"]
    root = config["media"]["root"]
    path = request.args.get("path", "")
    profile_name = request.args.get("profile", "720p")
    audio_idx = int(request.args.get("audio", 0))
    start_time = float(request.args.get("start", 0))

    filepath = os.path.realpath(os.path.join(root, path.lstrip("/")))
    if not filepath.startswith(os.path.realpath(root)):
        return jsonify({"error": "forbidden"}), 403
    if not os.path.isfile(filepath):
        return jsonify({"error": "not found"}), 404

    # Check max sessions
    max_sessions = config.get("transcoding", {}).get("max_sessions", 4)
    with sessions_lock:
        if len(sessions) >= max_sessions:
            return jsonify({"error": "too many active sessions"}), 429

    profile = _get_profile(config, profile_name)
    session_id = str(uuid.uuid4())
    sess = StreamSession(session_id, filepath, profile, audio_idx, start_time, config)

    try:
        sess.start()
    except Exception as e:
        sess.kill()
        return jsonify({"error": str(e)}), 500

    with sessions_lock:
        sessions[session_id] = sess

    return jsonify({
        "session_id": session_id,
        "playlist": f"/api/stream/{session_id}/playlist.m3u8",
    })


@stream_bp.route("/<session_id>/playlist.m3u8")
def playlist(session_id):
    with sessions_lock:
        sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.touch()

    playlist_path = os.path.join(sess.dir, "playlist.m3u8")

    # Wait for playlist to appear (up to 15s)
    for _ in range(150):
        if os.path.exists(playlist_path) and os.path.getsize(playlist_path) > 0:
            break
        time.sleep(0.1)
    else:
        return jsonify({"error": "playlist not ready"}), 504

    return send_file(playlist_path, mimetype="application/vnd.apple.mpegurl")


@stream_bp.route("/<session_id>/<segment>")
def segment(session_id, segment):
    with sessions_lock:
        sess = sessions.get(session_id)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.touch()

    seg_path = os.path.join(sess.dir, segment)

    # Wait for segment to appear (up to 30s)
    for _ in range(300):
        if os.path.exists(seg_path) and os.path.getsize(seg_path) > 0:
            # Wait a tiny bit more to ensure FFmpeg finished writing
            time.sleep(0.1)
            break
        time.sleep(0.1)
    else:
        return jsonify({"error": "segment not ready"}), 504

    return send_file(seg_path, mimetype="video/MP2T")


@stream_bp.route("/<session_id>", methods=["DELETE"])
def stop(session_id):
    with sessions_lock:
        sess = sessions.pop(session_id, None)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.kill()
    return jsonify({"ok": True})
