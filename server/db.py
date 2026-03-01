import os
import sqlite3
from flask import g

DB_PATH = os.path.join(os.environ.get("MEDIA_DATA_DIR", "/data"), "reelcoral.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS file_status (
    user_id        TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'opened',
    opened_at      TEXT NOT NULL,
    completed_at   TEXT,
    last_accessed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_fs_last_accessed ON file_status(user_id, last_accessed_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id   TEXT PRIMARY KEY,
    data_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_data (
    user_id   TEXT NOT NULL,
    data_key  TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, data_key)
);
"""


def init_db():
    """Create the database and tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    conn.close()


def get_db() -> sqlite3.Connection:
    """Get a per-request database connection stored on Flask g."""
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA synchronous=NORMAL")
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(e=None):
    """Close the per-request database connection."""
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_app(app):
    """Register teardown and initialize the database."""
    init_db()
    app.teardown_appcontext(close_db)


# --- File Status ---

def set_file_status(user_id: str, file_path: str, status: str):
    """Mark a file as opened or completed."""
    db = get_db()
    now = _now()
    if status == "completed":
        db.execute(
            """INSERT INTO file_status (user_id, file_path, status, opened_at, completed_at, last_accessed_at)
               VALUES (?, ?, 'completed', ?, ?, ?)
               ON CONFLICT(user_id, file_path) DO UPDATE SET
                 status='completed', completed_at=?, last_accessed_at=?""",
            (user_id, file_path, now, now, now, now, now),
        )
    else:
        db.execute(
            """INSERT INTO file_status (user_id, file_path, status, opened_at, last_accessed_at)
               VALUES (?, ?, 'opened', ?, ?)
               ON CONFLICT(user_id, file_path) DO UPDATE SET
                 last_accessed_at=?""",
            (user_id, file_path, now, now, now),
        )
    db.commit()


def clear_file_status(user_id: str, file_path: str):
    db = get_db()
    db.execute("DELETE FROM file_status WHERE user_id=? AND file_path=?", (user_id, file_path))
    db.commit()


def get_file_statuses(user_id: str, file_paths: list) -> dict:
    """Batch-query file statuses. Returns {path: status} for paths that have a status."""
    if not file_paths:
        return {}
    db = get_db()
    placeholders = ",".join("?" for _ in file_paths)
    rows = db.execute(
        f"SELECT file_path, status FROM file_status WHERE user_id=? AND file_path IN ({placeholders})",
        [user_id] + file_paths,
    ).fetchall()
    return {row["file_path"]: row["status"] for row in rows}


def get_recent_files(user_id: str) -> dict:
    """Get all last_accessed_at timestamps for a user. Returns {path: timestamp}."""
    db = get_db()
    rows = db.execute(
        "SELECT file_path, last_accessed_at FROM file_status WHERE user_id=? ORDER BY last_accessed_at DESC",
        (user_id,),
    ).fetchall()
    return {row["file_path"]: row["last_accessed_at"] for row in rows}


# --- User Preferences ---

def get_preferences(user_id: str) -> str:
    db = get_db()
    row = db.execute("SELECT data_json FROM user_preferences WHERE user_id=?", (user_id,)).fetchone()
    return row["data_json"] if row else "{}"


def save_preferences(user_id: str, data_json: str):
    db = get_db()
    db.execute(
        "INSERT INTO user_preferences (user_id, data_json) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data_json=?",
        (user_id, data_json, data_json),
    )
    db.commit()


# --- User Data (read_positions, reader_settings, etc.) ---

def get_user_data(user_id: str, key: str) -> str:
    db = get_db()
    row = db.execute("SELECT data_json FROM user_data WHERE user_id=? AND data_key=?", (user_id, key)).fetchone()
    return row["data_json"] if row else "{}"


def save_user_data(user_id: str, key: str, data_json: str):
    db = get_db()
    db.execute(
        "INSERT INTO user_data (user_id, data_key, data_json) VALUES (?, ?, ?) ON CONFLICT(user_id, data_key) DO UPDATE SET data_json=?",
        (user_id, key, data_json, data_json),
    )
    db.commit()


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
