import os
import re
import uuid
import time
import shutil
import signal
import atexit
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

_SEGMENT_RE = re.compile(r"segment_\d+\.ts")


def _sweep_tmpdir():
    """Remove leftover session dirs/logs from a previous worker process.

    Sessions only exist in this process's memory, so anything on disk at
    startup is orphaned and would otherwise accumulate in the tmpfs until
    segment writes fail.
    """
    try:
        for name in os.listdir(TMPDIR):
            full = os.path.join(TMPDIR, name)
            try:
                if os.path.isdir(full):
                    shutil.rmtree(full, ignore_errors=True)
                else:
                    os.unlink(full)
            except OSError:
                pass
    except OSError:
        pass


_sweep_tmpdir()


def _kill_all_sessions():
    """Kill all ffmpeg children on worker shutdown so transcodes (which run
    at -readrate 1 for the remaining duration of the file) don't outlive us."""
    with sessions_lock:
        to_kill = list(sessions.values())
        sessions.clear()
    for sess in to_kill:
        try:
            sess.kill()
        except Exception:
            pass


atexit.register(_kill_all_sessions)

# Codecs that browsers can natively decode in HLS
SAFE_CODECS = {"h264"}
# Audio codecs hls.js/browsers can decode from MPEGTS everywhere. Anything
# else (DTS, AC-3, TrueHD, FLAC, PCM, ...) must be transcoded even in copy
# mode, or the stream plays silent video (AC-3 decode is platform-dependent,
# so it is excluded too).
SAFE_AUDIO_CODECS = {"aac", "mp3"}


class StreamSession:
    def __init__(self, session_id, filepath, profile_cfg, audio_idx, start_time, config, sub_idx=None, keyframe_time=None):
        self.id = session_id
        self.filepath = filepath
        self.profile = profile_cfg
        self.audio_idx = audio_idx
        self.sub_idx = sub_idx
        self.start_time = start_time
        self.keyframe_time = keyframe_time
        self.config = config
        self.process = None
        self.dir = os.path.join(TMPDIR, session_id)
        self.last_access = time.time()
        self.started = False
        self.is_copy_mode = False
        self.error_log = os.path.join(TMPDIR, f"{session_id}.log")

    def start(self):
        os.makedirs(self.dir, exist_ok=True)

        tc = self.config.get("transcoding", {})
        hw = tc.get("hardware", "software")
        seg_dur = tc.get("segment_duration", 1)
        profile = self.profile

        playlist_path = os.path.join(self.dir, "playlist.m3u8")
        segment_pattern = os.path.join(self.dir, "segment_%d.ts")

        # For "original" profile, probe source codecs to decide if transcoding is needed
        needs_transcode = False
        source_width = None
        source_height = None
        source_bitrate = None
        source_audio_codec = None
        if profile.get("name") == "original":
            from probe import ffprobe
            probe_data = ffprobe(self.filepath)
            if probe_data:
                seen_video = False
                for s in probe_data.get("streams", []):
                    if s.get("codec_type") == "video" and not seen_video:
                        seen_video = True
                        codec_name = s.get("codec_name", "").lower()
                        if codec_name not in SAFE_CODECS:
                            needs_transcode = True
                        source_width = s.get("width")
                        source_height = s.get("height")
                        # Try stream bitrate first, then format bitrate
                        source_bitrate = s.get("bit_rate")
                    elif s.get("index") == self.audio_idx:
                        source_audio_codec = s.get("codec_name", "").lower()
                if needs_transcode and not source_bitrate:
                    fmt_br = probe_data.get("format", {}).get("bit_rate")
                    source_bitrate = fmt_br

        cmd = ["ffmpeg", "-y"]

        # Seek before input for speed. Always pass the REQUESTED time:
        # ffmpeg's -ss lands on the container's seek index (cues), one
        # B-frame-delta early — `self.keyframe_time` predicts that landing
        # (see _find_seek_landing) and is reported to the client as
        # actual_start for external subtitle calibration. Passing the
        # predicted landing as -ss instead would make ffmpeg seek one cue
        # EARLIER than predicted, desyncing subtitles by a GOP.
        ss_time = self.start_time
        if ss_time > 0:
            cmd += ["-ss", str(ss_time)]

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

        self.is_copy_mode = profile.get("name") == "original" and not needs_transcode
        if self.is_copy_mode:
            cmd += ["-c:v", "copy"]
            if source_audio_codec in SAFE_AUDIO_CODECS:
                cmd += ["-c:a", "copy"]
            else:
                # DTS/AC-3/FLAC/etc. don't decode in browsers — copying them
                # produced silent video. Decode just the audio (cheap) while
                # still copying the video stream.
                cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
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

        # -readrate 1 keeps ffmpeg near realtime, so a 60s rolling window is plenty.
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
        # Own process group so kill() reaps ffmpeg and any children even if
        # the parent relationship is broken (e.g. worker restart mid-kill).
        self.process = subprocess.Popen(
            cmd, stdout=subprocess.DEVNULL, stderr=errfp, start_new_session=True
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
            # No process and started means Popen never ran or failed; no
            # process and not started means the slot is reserved and ffmpeg
            # hasn't launched yet — don't let the cleanup loop reap it.
            return self.started
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
                os.killpg(self.process.pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                try:
                    self.process.terminate()
                except (OSError, ProcessLookupError):
                    pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except (OSError, ProcessLookupError):
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


# ffmpeg's CLI subtracts this from the -ss target before seeking when the
# container seeks by DTS and the video can have B-frames (ffmpeg source:
# 3*AV_TIME_BASE/23, "max 3 frames of delay at 23 fps"). To predict where
# -ss actually lands we must seek from the same adjusted timestamp.
_FFMPEG_SS_DTS_DELTA = 3.0 / 23.0


def _find_seek_landing(filepath, target_time):
    """Predict the file time of the first video frame ffmpeg emits for
    `-ss target_time -c copy`.

    Frame-level keyframe lists are the WRONG answer: ffmpeg seeks through
    the container's seek index (e.g. Matroska Cues), which may cover only a
    subset of keyframes, and it additionally subtracts a B-frame heuristic
    from the target before seeking. So we replicate the exact seek: ask
    ffprobe to read from (target - delta) with no stream selection (a
    global avformat seek, same as ffmpeg's) and take the first video
    packet's timestamp. Validated empirically against real ffmpeg output
    for both MKV (sparse cues) and MP4.
    """
    if target_time <= 0:
        return 0.0
    try:
        from probe import ffprobe as _ffprobe
        video_idx = 0
        data = _ffprobe(filepath)
        if data:
            for s in data.get("streams", []):
                if s.get("codec_type") == "video":
                    video_idx = s.get("index", 0)
                    break

        adjusted = max(0.0, target_time - _FFMPEG_SS_DTS_DELTA)
        cmd = [
            "ffprobe", "-v", "quiet",
            "-show_entries", "packet=stream_index,pts_time,dts_time",
            "-of", "csv=p=0",
            "-read_intervals", f"{adjusted}%+#40",
            filepath,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return target_time
        for line in result.stdout.strip().split("\n"):
            parts = line.split(",")
            if len(parts) < 2 or parts[0] != str(video_idx):
                continue
            for v in parts[1:3]:  # pts_time, fall back to dts_time
                try:
                    return float(v)
                except ValueError:
                    continue
        return target_time
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
    if not filepath.startswith(os.path.realpath(root) + os.sep):
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

    profile = _get_profile(config, profile_name)
    session_id = str(uuid.uuid4())
    sess = StreamSession(session_id, filepath, profile, audio_idx, start_time, config, sub_idx, keyframe_time=None)

    # Reserve the session slot atomically with the max_sessions check —
    # the probes below yield, so checking first and inserting later lets
    # N concurrent /start requests all pass the cap. The client only
    # learns the session_id after /start returns, so nobody can request
    # the playlist while the reserved session is still starting.
    max_sessions = config.get("transcoding", {}).get("max_sessions", 4)
    with sessions_lock:
        if len(sessions) >= max_sessions:
            return jsonify({"error": "too many active sessions"}), 429
        sessions[session_id] = sess

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

    # For copy-mode streams, predict in parallel where ffmpeg's -ss will
    # actually land (the cue/keyframe the demuxer seeks to), so the client
    # can calibrate external subtitles to the true content start.
    keyframe_time = [start_time]
    kf_thread = None
    if profile.get("name") == "original" and start_time > 0:
        def do_kf_probe():
            keyframe_time[0] = _find_seek_landing(filepath, start_time)
        kf_thread = threading.Thread(target=do_kf_probe)
        kf_thread.start()

    if kf_thread:
        kf_thread.join()
        kf_thread = None

    kf = keyframe_time[0] if keyframe_time[0] != start_time else None
    sess.keyframe_time = kf

    t1 = time.time()
    try:
        sess.start()
    except Exception as e:
        with sessions_lock:
            sessions.pop(session_id, None)
        sess.kill()
        probe_thread.join()
        return jsonify({"error": str(e)}), 500
    t2 = time.time()

    probe_thread.join()
    t3 = time.time()
    log.info("TIMING /start: ffmpeg_launch=%.2fs probe_wait=%.2fs total=%.2fs",
             t2 - t1, t3 - t2, t3 - t0)

    result = {
        "session_id": session_id,
        "playlist": f"/api/stream/{session_id}/playlist.m3u8",
    }
    if media_info:
        result["media_info"] = media_info
    elif probe_error[0]:
        log.warning("media info probe failed for %s: %s", filepath, probe_error[0])
        result["probe_error"] = str(probe_error[0])
    # For copy-mode streams, tell the frontend the actual keyframe start time.
    # Only relevant when actually copying (not when original triggers transcode).
    if sess.is_copy_mode and keyframe_time[0] != start_time:
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
    # Reject non-segment names immediately instead of tying the request
    # up in the 30s appearance-poll below.
    if not _SEGMENT_RE.fullmatch(segment):
        return jsonify({"error": "not found"}), 404
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
@stream_bp.route("/<session_id>/stop", methods=["POST"])
def stop(session_id):
    # The POST alias exists for navigator.sendBeacon on tab close, which
    # can't issue DELETE. Without it, closing the tab leaves ffmpeg
    # transcoding until the idle timeout.
    with sessions_lock:
        sess = sessions.pop(session_id, None)
    if not sess:
        return jsonify({"error": "session not found"}), 404
    sess.kill()
    return jsonify({"ok": True})
