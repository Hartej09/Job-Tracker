import sqlite3

import pytest

import db


def test_migrations_on_empty_db(db_path):
    conn = db.connect(db_path)
    assert db.schema_version(conn) == db.SCHEMA_VERSION
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"jobs", "status_history", "suggestions", "sync_state"} <= tables
    indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    assert "idx_jobs_company_req" in indexes
    conn.close()


def test_connection_pragmas(conn):
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000


def test_migrations_are_idempotent(db_path):
    db.connect(db_path).close()
    conn = db.connect(db_path)  # second start must not re-run anything
    assert db.schema_version(conn) == db.SCHEMA_VERSION
    conn.close()


def test_refuses_newer_schema(db_path):
    raw = sqlite3.connect(db_path)
    raw.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION + 1}")
    raw.close()
    with pytest.raises(RuntimeError, match="newer"):
        db.connect(db_path)


def test_check_constraints_enforced(conn, make_job):
    job_id = make_job()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE jobs SET status = 'Hired' WHERE id = ?", (job_id,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE jobs SET date_applied = '03/04/2026' WHERE id = ?", (job_id,))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO status_history (job_id, old_status, new_status, changed_at, source)"
            " VALUES (?, NULL, 'Applied', 'x', 'robot')",
            (job_id,),
        )


def test_suggestion_shape_constraints(conn, make_job):
    job_id = make_job()
    insert = (
        "INSERT INTO suggestions (job_id, kind, dedupe_key, gmail_message_id, suggested_status,"
        " subject, state, created_at) VALUES (?, ?, ?, ?, 'Ghosted', ?, 'pending', 'now')"
    )
    conn.execute(insert, (job_id, "inactivity", f"ghost:{job_id}:2026-01-01", None, None))
    conn.execute(insert, (job_id, "email", "gmail:abc", "abc", "Re: your application"))
    with pytest.raises(sqlite3.IntegrityError):  # inactivity with email fields
        conn.execute(insert, (job_id, "inactivity", f"ghost:{job_id}:x", None, "subject"))
    with pytest.raises(sqlite3.IntegrityError):  # dedupe_key doesn't match message id
        conn.execute(insert, (job_id, "email", "gmail:zzz", "abc2", None))
    with pytest.raises(sqlite3.IntegrityError):  # duplicate dedupe key
        conn.execute(insert, (job_id, "email", "gmail:abc", "abc", None))
