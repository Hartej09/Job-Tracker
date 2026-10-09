import sqlite3
from datetime import date

import pytest

import db


# --- CRUD -------------------------------------------------------------------


def test_add_and_get_job(conn):
    job_id = db.add_job(
        conn,
        {
            "requisition_id": "  R-1001 ",
            "company": " Acme ",
            "role": "Engineer",
            "date_applied": date(2026, 3, 4),
            "follow_up": "2026-03-11",
            "location": "  ",
            "notes": "referred by Sam",
        },
    )
    job = db.get_job(conn, job_id)
    assert job["requisition_id"] == "R-1001"
    assert job["company"] == "Acme"
    assert job["status"] == "Applied"
    assert job["date_applied"] == "2026-03-04"
    assert job["follow_up"] == "2026-03-11"
    assert job["location"] is None
    assert job["created_at"].endswith("Z") and job["created_at"] == job["updated_at"]


def test_add_job_writes_initial_history(conn, make_job):
    job_id = make_job(status="Interviewing")
    (history,) = db.get_status_history(conn, job_id)
    assert history["old_status"] is None
    assert history["new_status"] == "Interviewing"
    assert history["source"] == "manual"


def test_list_jobs_filters_and_search(conn, make_job):
    make_job(requisition_id="A1", company="Acme", role="Data Analyst", notes="great team")
    make_job(requisition_id="B2", company="Globex", role="Engineer", status="Rejected")
    make_job(requisition_id="C3_x", company="Initech", role="PM")

    assert len(db.list_jobs(conn)) == 3
    assert [j["company"] for j in db.list_jobs(conn, statuses=["Rejected"])] == ["Globex"]
    assert [j["company"] for j in db.list_jobs(conn, search="GREAT")] == ["Acme"]
    assert [j["company"] for j in db.list_jobs(conn, search="analyst")] == ["Acme"]
    assert [j["company"] for j in db.list_jobs(conn, search="b2")] == ["Globex"]
    # LIKE wildcards in the search text are literal.
    assert [j["company"] for j in db.list_jobs(conn, search="3_x")] == ["Initech"]
    assert db.list_jobs(conn, search="%") == []
    assert db.list_jobs(conn, statuses=["Applied"], search="Globex") == []


def test_update_job_fields(conn, make_job):
    job_id = make_job()
    before = db.get_job(conn, job_id)
    after = db.update_job(conn, job_id, {"notes": " called ", "follow_up": "2026-05-01"})
    assert after["notes"] == "called"
    assert after["follow_up"] == "2026-05-01"
    assert after["updated_at"] > before["updated_at"]
    assert len(db.get_status_history(conn, job_id)) == 1  # no status change


def test_update_job_with_status_writes_history(conn, make_job):
    job_id = make_job()
    db.update_job(conn, job_id, {"status": "Interviewing", "notes": "phone screen"})
    job = db.get_job(conn, job_id)
    assert job["status"] == "Interviewing" and job["notes"] == "phone screen"
    history = db.get_status_history(conn, job_id)
    assert [(h["old_status"], h["new_status"], h["source"]) for h in history] == [
        (None, "Applied", "manual"),
        ("Applied", "Interviewing", "manual"),
    ]


def test_update_job_conflict_detection(conn, make_job):
    job_id = make_job()
    stale = db.get_job(conn, job_id)["updated_at"]
    db.update_job(conn, job_id, {"notes": "changed elsewhere"})
    with pytest.raises(db.ConflictError):
        db.update_job(conn, job_id, {"notes": "mine"}, expected_updated_at=stale)
    assert db.get_job(conn, job_id)["notes"] == "changed elsewhere"


def test_update_missing_job_is_conflict(conn):
    with pytest.raises(db.ConflictError):
        db.update_job(conn, 999, {"notes": "x"})


def test_delete_job_cascades(conn, make_job):
    job_id = make_job()
    db.change_status(conn, job_id, "Interviewing", "manual")
    assert db.delete_job(conn, job_id)
    assert db.get_job(conn, job_id) is None
    assert db.get_status_history(conn, job_id) == []
    assert not db.delete_job(conn, job_id)


# --- Validation -------------------------------------------------------------


@pytest.mark.parametrize("field", ["requisition_id", "company", "role"])
@pytest.mark.parametrize("value", [None, "", "   ", "\t\n"])
def test_required_fields_on_add(conn, field, value):
    data = {"requisition_id": "R1", "company": "Acme", "role": "Eng", field: value}
    with pytest.raises(db.ValidationError) as exc:
        db.add_job(conn, data)
    assert f"{field} is required" in exc.value.problems
    assert db.list_jobs(conn) == []


@pytest.mark.parametrize("field", ["requisition_id", "company", "role"])
def test_required_fields_missing_entirely(conn, field):
    data = {"requisition_id": "R1", "company": "Acme", "role": "Eng"}
    del data[field]
    with pytest.raises(db.ValidationError):
        db.add_job(conn, data)


def test_required_fields_on_update(conn, make_job):
    job_id = make_job()
    with pytest.raises(db.ValidationError):
        db.update_job(conn, job_id, {"company": "  "})
    assert db.get_job(conn, job_id)["company"] == "Acme"


def test_invalid_status_and_dates_rejected(conn):
    base = {"requisition_id": "R1", "company": "Acme", "role": "Eng"}
    with pytest.raises(db.ValidationError, match="status"):
        db.add_job(conn, {**base, "status": "Hired"})
    with pytest.raises(db.ValidationError, match="date_applied"):
        db.add_job(conn, {**base, "date_applied": "03/04/2026"})
    with pytest.raises(db.ValidationError, match="follow_up"):
        db.add_job(conn, {**base, "follow_up": "2026-02-30"})


# --- Duplicates -------------------------------------------------------------


def test_find_duplicates_case_insensitive_and_trimmed(conn, make_job):
    job_id = make_job(company="Acme Corp", requisition_id="REQ-77")
    make_job(company="Other", requisition_id="REQ-77")
    dups = db.find_duplicates(conn, "  acme corp ", "req-77")
    assert [d["id"] for d in dups] == [job_id]
    assert db.find_duplicates(conn, "Acme Corp", "REQ-78") == []
    assert db.find_duplicates(conn, "acme corp", "REQ-77", exclude_id=job_id) == []


def test_duplicates_are_allowed_but_detectable(conn, make_job):
    # The UI warns rather than blocks, so the DB must accept a duplicate.
    make_job(company="Acme", requisition_id="R1")
    make_job(company="ACME", requisition_id="r1")
    assert len(db.find_duplicates(conn, "acme", "R1")) == 2


def test_dup_key_matches_sql_nocase(conn, make_job):
    make_job(company="Acme", requisition_id="Ab-1")
    assert db.existing_dup_keys(conn) == {db.dup_key(" ACME", "aB-1 ")}


# --- Status changes ---------------------------------------------------------


def test_change_status_writes_history(conn, make_job):
    job_id = make_job()
    assert db.change_status(conn, job_id, "Interviewing", "manual")
    assert db.change_status(conn, job_id, "Applied", "email")  # any transition allowed
    job = db.get_job(conn, job_id)
    history = db.get_status_history(conn, job_id)
    assert job["status"] == "Applied"
    assert [(h["old_status"], h["new_status"], h["source"]) for h in history] == [
        (None, "Applied", "manual"),
        ("Applied", "Interviewing", "manual"),
        ("Interviewing", "Applied", "email"),
    ]
    assert history[-1]["changed_at"] == job["updated_at"]


def test_change_status_same_status_is_noop(conn, make_job):
    job_id = make_job()
    assert not db.change_status(conn, job_id, "Applied", "manual")
    assert len(db.get_status_history(conn, job_id)) == 1


def test_change_status_validates(conn, make_job):
    job_id = make_job()
    with pytest.raises(db.ValidationError):
        db.change_status(conn, job_id, "Hired", "manual")
    with pytest.raises(ValueError):
        db.change_status(conn, job_id, "Offer", "robot")
    with pytest.raises(db.ConflictError):
        db.change_status(conn, 999, "Offer", "manual")


def test_change_status_is_atomic(conn, make_job):
    job_id = make_job()
    # Make the history insert fail after the jobs UPDATE has run.
    conn.execute(
        "CREATE TRIGGER fail_history BEFORE INSERT ON status_history"
        " BEGIN SELECT RAISE(ABORT, 'boom'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="boom"):
        db.change_status(conn, job_id, "Offer", "manual")
    assert db.get_job(conn, job_id)["status"] == "Applied"
    assert not conn.in_transaction
    conn.execute("DROP TRIGGER fail_history")
    assert len(db.get_status_history(conn, job_id)) == 1


def test_update_job_rolls_back_fields_when_status_fails(conn, make_job):
    job_id = make_job()
    conn.execute(
        "CREATE TRIGGER fail_history BEFORE INSERT ON status_history"
        " BEGIN SELECT RAISE(ABORT, 'boom'); END"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.update_job(conn, job_id, {"notes": "new", "status": "Offer"})
    job = db.get_job(conn, job_id)
    assert job["notes"] is None and job["status"] == "Applied"


def test_change_status_conflict(conn, make_job):
    job_id = make_job()
    stale = db.get_job(conn, job_id)["updated_at"]
    db.update_job(conn, job_id, {"notes": "x"})
    with pytest.raises(db.ConflictError):
        db.change_status(conn, job_id, "Offer", "manual", expected_updated_at=stale)


# --- Follow-ups & stats -----------------------------------------------------


def test_follow_ups_due(conn, make_job):
    today = date(2026, 10, 9)
    overdue = make_job(requisition_id="1", follow_up="2026-10-01")
    due_today = make_job(requisition_id="2", follow_up="2026-10-09", status="Interviewing")
    make_job(requisition_id="3", follow_up="2026-10-10")  # future
    make_job(requisition_id="4")  # no follow-up
    for i, status in enumerate(["Rejected", "Withdrawn", "Offer"]):
        make_job(requisition_id=f"x{i}", follow_up="2026-10-01", status=status)
    ghosted = make_job(requisition_id="5", follow_up="2026-09-01", status="Ghosted")

    due = db.follow_ups_due(conn, today)
    assert [j["id"] for j in due] == [ghosted, overdue, due_today]
    assert [j["id"] for j in db.follow_ups_due(conn, "2026-10-09")] == [ghosted, overdue, due_today]


def test_count_by_status(conn, make_job):
    make_job(requisition_id="1")
    make_job(requisition_id="2")
    make_job(requisition_id="3", status="Offer")
    counts = db.count_by_status(conn)
    assert list(counts) == list(db.STATUSES)
    assert counts["Applied"] == 2 and counts["Offer"] == 1 and counts["Ghosted"] == 0


def test_applications_per_week(conn, make_job):
    make_job(requisition_id="1", date_applied="2026-10-05")  # Monday
    make_job(requisition_id="2", date_applied="2026-10-11")  # Sunday, same week
    make_job(requisition_id="3", date_applied="2026-10-12")  # next Monday
    make_job(requisition_id="4", date_applied="2026-09-30")  # Wednesday
    make_job(requisition_id="5")  # no date: excluded
    assert db.applications_per_week(conn) == [
        ("2026-09-28", 1),
        ("2026-10-05", 2),
        ("2026-10-12", 1),
    ]


# --- Sync state -------------------------------------------------------------


def test_sync_state_roundtrip(conn):
    assert db.get_sync_state(conn, "history_id") is None
    db.set_sync_state(conn, "history_id", "123")
    db.set_sync_state(conn, "history_id", "456")
    assert db.get_sync_state(conn, "history_id") == "456"
