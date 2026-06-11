"""Helpers to keep CPU-bound work from stalling the single gevent worker.

The server runs as one gunicorn gevent worker (required: HLS sessions live
in process memory, which keeps subtitle sync session affinity). Subprocess
calls are already cooperative under gevent monkey-patching, but in-process
C-extension work (PyMuPDF, PIL, zipfile, ebooklib) blocks the event loop
and stalls HLS segment delivery. run_blocking() pushes that work onto
gevent's native threadpool, where the C libraries release the GIL.
"""
import threading


def _make_run_blocking():
    try:
        from gevent import monkey
        if monkey.is_module_patched("socket"):
            from gevent import get_hub

            def run(fn, *args, **kwargs):
                return get_hub().threadpool.apply(fn, args, kwargs)
            return run
    except ImportError:
        pass

    def run(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    return run


run_blocking = _make_run_blocking()

_calls = {}
_calls_lock = threading.Lock()


def singleflight(key, fn):
    """Run fn at most once for concurrent callers sharing key.

    The first caller executes fn; concurrent duplicates wait and receive the
    same result (or exception). Prevents thundering herds on identical work
    (thumbnail generation, PDF page renders, audio transcodes, ...).
    """
    with _calls_lock:
        entry = _calls.get(key)
        if entry is None:
            entry = {"event": threading.Event(), "result": None, "exc": None}
            _calls[key] = entry
            owner = True
        else:
            owner = False

    if owner:
        try:
            entry["result"] = fn()
        except BaseException as e:
            entry["exc"] = e
            raise
        finally:
            with _calls_lock:
                _calls.pop(key, None)
            entry["event"].set()
        return entry["result"]

    entry["event"].wait()
    if entry["exc"] is not None:
        raise entry["exc"]
    return entry["result"]
