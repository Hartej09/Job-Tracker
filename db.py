"""Data access layer for the Job Tracker.

All SQL lives in this module so the backend could be swapped (e.g. for
Postgres) without touching the UI or sync code.
"""

from __future__ import annotations

import os
import sqlite3
import string
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Iterator

STATUSES = ("Applied", "Interviewing", "Offer", "Rejected", "Ghosted", "Withdrawn")
FINAL_STATUSES = ("Rejected", "Withdrawn")
FOLLOW_UP_EXCLUDED = ("Rejected", "Withdrawn", "Offer")
HISTORY_SOURCES = ("manual", "email", "import", "inactivity")

REQUIRED_FIELDS = ("requisition_id", "company", "role")
DATE_FIELDS = ("date_applied", "follow_up")
JOB_FIELDS = (
    "requisition_id",
    "company",
    "role",
    "date_applied",
    "status",
    "location",
    "salary_range",
    "job_url",
    "contact",
    "email_domain",
    "follow_up",
    "notes",
)

DEFAULT_DB_PATH = "jobs.db"


class ValidationError(ValueError):
    """Job data failed validation. `problems` lists human-readable reasons."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


class ConflictError(Exception):
    """The row changed in the database since it was loaded."""


# ---------------------------------------------------------------------------
# Schema & migrations
# ---------------------------------------------------------------------------

_STATUS_LIST = ", ".join(f"'{s}'" for s in STATUSES)
_SOURCE_LIST = ", ".join(f"'{s}'" for s in HISTORY_SOURCES)

# Each migration is a list of statements; migration N brings user_version to N.
MIGRATIONS: list[list[str]] = [
    [
        f"""
        CREATE TABLE jobs (
          id             INTEGER PRIMARY KEY,
          requisition_id TEXT NOT NULL CHECK (length(trim(requisition_id)) > 0),
          company        TEXT NOT NULL CHECK (length(trim(company)) > 0),
          role           TEXT NOT NULL CHECK (length(trim(role)) > 0),
          date_applied   TEXT CHECK (date_applied IS NULL OR date(date_applied) IS date_applied),
          status         TEXT NOT NULL DEFAULT 'Applied' CHECK (status IN ({_STATUS_LIST})),
          location       TEXT,
          salary_range   TEXT,
          job_url        TEXT,
          contact        TEXT,
          email_domain   TEXT,
          follow_up      TEXT CHECK (follow_up IS NULL OR date(follow_up) IS follow_up),
          notes          TEXT,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL
        )
        """,
        """
        CREATE INDEX idx_jobs_company_req
          ON jobs (company COLLATE NOCASE, requisition_id COLLATE NOCASE)
        """,
        f"""
        CREATE TABLE status_history (
          id         INTEGER PRIMARY KEY,
          job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          old_status TEXT CHECK (old_status IS NULL OR old_status IN ({_STATUS_LIST})),
          new_status TEXT NOT NULL CHECK (new_status IN ({_STATUS_LIST})),
          changed_at TEXT NOT NULL,
          source     TEXT NOT NULL CHECK (source IN ({_SOURCE_LIST}))
        )
        """,
        "CREATE INDEX idx_status_history_job ON status_history (job_id, changed_at)",
        f"""
        CREATE TABLE suggestions (
          id               INTEGER PRIMARY KEY,
          job_id           INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          kind             TEXT NOT NULL CHECK (kind IN ('email', 'inactivity')),
          dedupe_key       TEXT NOT NULL UNIQUE,
          gmail_message_id TEXT,
          suggested_status TEXT NOT NULL CHECK (suggested_status IN ({_STATUS_LIST})),
          matched_by       TEXT,
          subject          TEXT,
          sender           TEXT,
          email_date       TEXT,
          snippet          TEXT,
          state            TEXT NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'accepted', 'dismissed')),
          created_at       TEXT NOT NULL,
          resolved_at      TEXT,
          CHECK (
            (kind = 'email' AND gmail_message_id IS NOT NULL
               AND dedupe_key = 'gmail:' || gmail_message_id)
            OR
            (kind = 'inactivity' AND dedupe_key LIKE 'ghost:%'
               AND gmail_message_id IS NULL AND subject IS NULL AND sender IS NULL
               AND email_date IS NULL AND snippet IS NULL)
          )
        )
        """,
        "CREATE INDEX idx_suggestions_state ON suggestions (state, job_id)",
        "CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)",
    ],
]

SCHEMA_VERSION = len(MIGRATIONS)


def default_db_path() -> str:
    return os.getenv("JOBTRACKER_DB_PATH") or DEFAULT_DB_PATH


def connect(path: str | os.PathLike | None = None) -> sqlite3.Connection:
    """Open a connection with the required pragmas and run pending migrations.

    The connection is in autocommit mode; writes are grouped explicitly with
    `transaction()`.
    """
    conn = sqlite3.connect(path or default_db_path(), timeout=5, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    migrate(conn)
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


def migrate(conn: sqlite3.Connection) -> None:
    """Apply any migrations newer than PRAGMA user_version, one transaction each."""
    if schema_version(conn) > SCHEMA_VERSION:
        raise RuntimeError(
            f"Database schema v{schema_version(conn)} is newer than this app "
            f"(v{SCHEMA_VERSION}). Update the app."
        )
    for target in range(1, SCHEMA_VERSION + 1):
        if schema_version(conn) >= target:
            continue  # avoid taking the write lock when there's nothing to do
        with transaction(conn):
            # Re-check inside the write lock: another process may have migrated.
            if schema_version(conn) >= target:
                continue
            for statement in MIGRATIONS[target - 1]:
                conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {target}")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE ... COMMIT, rolling back on error. Re-entrant: nested
    calls join the outer transaction."""
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_TS_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def utc_now() -> str:
    """UTC timestamp, ISO-8601 with microseconds."""
    return datetime.now(timezone.utc).strftime(_TS_FORMAT)


def _next_updated_at(previous: str) -> str:
    """A timestamp strictly after `previous`. updated_at doubles as the
    optimistic-locking version, and the clock may not have ticked (Windows
    clock resolution is coarse), so never reuse a value."""
    now = utc_now()
    if now > previous:
        return now
    bumped = datetime.strptime(previous, _TS_FORMAT) + timedelta(microseconds=1)
    return bumped.strftime(_TS_FORMAT)


_ASCII_LOWER = str.maketrans(string.ascii_uppercase, string.ascii_lowercase)


def dup_key(company: str, requisition_id: str) -> tuple[str, str]:
    """Duplicate-detection key. Mirrors SQLite's NOCASE collation (ASCII-only
    case folding) so Python-side and SQL-side checks always agree."""
    return (
        company.strip().translate(_ASCII_LOWER),
        requisition_id.strip().translate(_ASCII_LOWER),
    )


def _is_blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and value != value:  # NaN
        return True
    if value != value:  # pandas NaT and friends
        return True
    return isinstance(value, str) and not value.strip()


def _to_iso_date(field: str, value: Any, problems: list[str]) -> str | None:
    if _is_blank(value):
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    try:
        if len(text) != 10:
            raise ValueError
        return date.fromisoformat(text).isoformat()
    except ValueError:
        problems.append(f"{field} must be a date in YYYY-MM-DD format (got {text!r})")
        return None


def normalize_fields(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Trim/convert the job fields present in `data`. Returns (clean, problems).

    Unknown keys are ignored. Blank strings become None. Required fields that
    are present must be non-blank; dates must be valid; status must be known.
    """
    clean: dict[str, Any] = {}
    problems: list[str] = []
    for field in JOB_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if field in DATE_FIELDS:
            clean[field] = _to_iso_date(field, value, problems)
            continue
        clean[field] = None if _is_blank(value) else str(value).strip()
    for field in REQUIRED_FIELDS:
        if field in clean and clean[field] is None:
            problems.append(f"{field} is required")
    if "status" in clean:
        if clean["status"] is None:
            problems.append("status is required")
        elif clean["status"] not in STATUSES:
            problems.append(f"status must be one of {', '.join(STATUSES)} (got {clean['status']!r})")
    return clean, problems


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


def add_job(conn: sqlite3.Connection, data: dict[str, Any], source: str = "manual") -> int:
    """Insert a job plus its initial status_history row (old_status NULL)."""
    if source not in HISTORY_SOURCES:
        raise ValueError(f"unknown history source {source!r}")
    data = {"status": "Applied", **data}
    if _is_blank(data.get("status")):
        data["status"] = "Applied"
    for field in REQUIRED_FIELDS:
        data.setdefault(field, None)
    clean, problems = normalize_fields(data)
    if problems:
        raise ValidationError(problems)

    now = utc_now()
    columns = list(clean) + ["created_at", "updated_at"]
    values = list(clean.values()) + [now, now]
    with transaction(conn):
        cur = conn.execute(
            f"INSERT INTO jobs ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
            values,
        )
        job_id = cur.lastrowid
        conn.execute(
            "INSERT INTO status_history (job_id, old_status, new_status, changed_at, source)"
            " VALUES (?, NULL, ?, ?, ?)",
            (job_id, clean["status"], now, source),
        )
    return job_id


def get_job(conn: sqlite3.Connection, job_id: int) -> dict[str, Any] | None:
    return _row_to_dict(conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone())


def list_jobs(
    conn: sqlite3.Connection,
    statuses: Iterable[str] | None = None,
    search: str | None = None,
) -> list[dict[str, Any]]:
    """Jobs filtered by status (None/empty = all) and a case-insensitive text
    search over company, role, requisition_id and notes."""
    sql = "SELECT * FROM jobs WHERE 1=1"
    params: list[Any] = []
    statuses = list(statuses or [])
    if statuses:
        sql += f" AND status IN ({', '.join('?' * len(statuses))})"
        params += statuses
    if search and search.strip():
        escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        sql += (
            " AND (company LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\'"
            " OR requisition_id LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')"
        )
        params += [pattern] * 4
    sql += " ORDER BY date_applied IS NULL, date_applied DESC, id DESC"
    return [dict(r) for r in conn.execute(sql, params)]


def find_duplicates(
    conn: sqlite3.Connection,
    company: str,
    requisition_id: str,
    exclude_id: int | None = None,
) -> list[dict[str, Any]]:
    """Jobs with the same company + requisition ID (trimmed, case-insensitive)."""
    rows = conn.execute(
        "SELECT * FROM jobs WHERE company = ? COLLATE NOCASE"
        " AND requisition_id = ? COLLATE NOCASE AND id IS NOT ? ORDER BY id",
        ((company or "").strip(), (requisition_id or "").strip(), exclude_id),
    )
    return [dict(r) for r in rows]


def existing_dup_keys(conn: sqlite3.Connection) -> set[tuple[str, str]]:
    return {dup_key(r[0], r[1]) for r in conn.execute("SELECT company, requisition_id FROM jobs")}


def update_job(
    conn: sqlite3.Connection,
    job_id: int,
    changes: dict[str, Any],
    expected_updated_at: str | None = None,
    source: str = "manual",
) -> dict[str, Any]:
    """Apply field changes to a job. A status change is routed through
    `change_status` in the same transaction.

    If `expected_updated_at` is given and the row's updated_at differs, raises
    ConflictError and changes nothing. Returns the updated job.
    """
    clean, problems = normalize_fields(changes)
    if problems:
        raise ValidationError(problems)
    new_status = clean.pop("status", None)

    with transaction(conn):
        current = get_job(conn, job_id)
        if current is None:
            raise ConflictError(f"job {job_id} no longer exists")
        if expected_updated_at is not None and current["updated_at"] != expected_updated_at:
            raise ConflictError(f"job {job_id} was changed elsewhere since it was loaded")
        field_changes = {k: v for k, v in clean.items() if current[k] != v}
        if field_changes:
            assignments = ", ".join(f"{k} = ?" for k in field_changes)
            conn.execute(
                f"UPDATE jobs SET {assignments}, updated_at = ? WHERE id = ?",
                [*field_changes.values(), _next_updated_at(current["updated_at"]), job_id],
            )
        if new_status is not None:
            change_status(conn, job_id, new_status, source)
        return get_job(conn, job_id)


def change_status(
    conn: sqlite3.Connection,
    job_id: int,
    new_status: str,
    source: str,
    expected_updated_at: str | None = None,
) -> bool:
    """The single entry point for status changes: updates jobs.status and
    inserts status_history atomically. Returns False if the status was
    already `new_status` (nothing written)."""
    if new_status not in STATUSES:
        raise ValidationError([f"status must be one of {', '.join(STATUSES)} (got {new_status!r})"])
    if source not in HISTORY_SOURCES:
        raise ValueError(f"unknown history source {source!r}")
    with transaction(conn):
        row = conn.execute("SELECT status, updated_at FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ConflictError(f"job {job_id} no longer exists")
        if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
            raise ConflictError(f"job {job_id} was changed elsewhere since it was loaded")
        if row["status"] == new_status:
            return False
        now = _next_updated_at(row["updated_at"])
        conn.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?", (new_status, now, job_id)
        )
        conn.execute(
            "INSERT INTO status_history (job_id, old_status, new_status, changed_at, source)"
            " VALUES (?, ?, ?, ?, ?)",
            (job_id, row["status"], new_status, now, source),
        )
    return True


def delete_job(conn: sqlite3.Connection, job_id: int) -> bool:
    """Delete a job; its history and suggestions cascade."""
    with transaction(conn):
        return conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,)).rowcount > 0


def get_status_history(conn: sqlite3.Connection, job_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM status_history WHERE job_id = ? ORDER BY changed_at, id", (job_id,)
    )
    return [dict(r) for r in rows]


def import_jobs(
    conn: sqlite3.Connection, records: list[dict[str, Any]]
) -> tuple[list[int], list[dict[str, Any]]]:
    """Insert validated records in one transaction with source='import'.

    Duplicates (against the DB and earlier records in the batch) are re-checked
    inside the transaction and skipped. Returns (inserted_ids, skipped_records).
    Any validation error rolls back the whole batch.
    """
    inserted: list[int] = []
    skipped: list[dict[str, Any]] = []
    with transaction(conn):
        seen = existing_dup_keys(conn)
        for record in records:
            key = dup_key(record.get("company") or "", record.get("requisition_id") or "")
            if key in seen:
                skipped.append(record)
                continue
            fields = {k: v for k, v in record.items() if k in JOB_FIELDS}
            inserted.append(add_job(conn, fields, source="import"))
            seen.add(key)
    return inserted, skipped


# ---------------------------------------------------------------------------
# Reminders & stats
# ---------------------------------------------------------------------------


def follow_ups_due(conn: sqlite3.Connection, today: date | str | None = None) -> list[dict[str, Any]]:
    """Jobs whose follow_up is today or earlier and whose status is not
    Rejected/Withdrawn/Offer. `today` defaults to the local date."""
    if today is None:
        today = date.today()
    if isinstance(today, date):
        today = today.isoformat()
    excluded = ", ".join("?" * len(FOLLOW_UP_EXCLUDED))
    rows = conn.execute(
        f"SELECT * FROM jobs WHERE follow_up IS NOT NULL AND follow_up <= ?"
        f" AND status NOT IN ({excluded}) ORDER BY follow_up, id",
        (today, *FOLLOW_UP_EXCLUDED),
    )
    return [dict(r) for r in rows]


def count_by_status(conn: sqlite3.Connection) -> dict[str, int]:
    """Count of jobs per status, in canonical order, including zeros."""
    counts = dict.fromkeys(STATUSES, 0)
    for status, n in conn.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status"):
        counts[status] = n
    return counts


def applications_per_week(conn: sqlite3.Connection) -> list[tuple[str, int]]:
    """(week_start, count) by date_applied; weeks start on Monday. Jobs
    without date_applied are excluded. Weeks with no applications are omitted."""
    rows = conn.execute(
        """
        SELECT date(date_applied, '-' || ((CAST(strftime('%w', date_applied) AS INTEGER) + 6) % 7)
                    || ' days') AS week_start,
               COUNT(*)
        FROM jobs
        WHERE date_applied IS NOT NULL
        GROUP BY week_start
        ORDER BY week_start
        """
    )
    return [(r[0], r[1]) for r in rows]


# ---------------------------------------------------------------------------
# Sync state
# ---------------------------------------------------------------------------


def get_sync_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM sync_state WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_sync_state(conn: sqlite3.Connection, key: str, value: str | None) -> None:
    with transaction(conn):
        conn.execute(
            "INSERT INTO sync_state (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
