"""Headless UI smoke tests using Streamlit's AppTest (no browser, no network)."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

import db

APP = str(Path(__file__).resolve().parent.parent / "app.py")
PAGES = ["Phone view", "Jobs", "Add job", "Follow-ups", "Stats", "Import CSV"]


@pytest.fixture
def app_env(monkeypatch, db_path):
    monkeypatch.setenv("JOBTRACKER_DB_PATH", str(db_path))
    # Empty (not unset) so a real .env can't supply a password via load_dotenv.
    monkeypatch.setenv("JOBTRACKER_PASSWORD", "")
    conn = db.connect(db_path)
    db.add_job(conn, {"requisition_id": "R-1", "company": "Acme", "role": "Eng", "follow_up": "2026-01-01"})
    db.add_job(conn, {"requisition_id": "R-2", "company": "Globex", "role": "PM", "date_applied": "2026-03-04"})
    conn.close()
    return monkeypatch


@pytest.mark.parametrize("page", PAGES)
def test_every_page_renders(app_env, page):
    at = AppTest.from_file(APP, default_timeout=30)
    at.run()
    at.sidebar.radio(key="nav").set_value(page).run()
    assert not at.exception, at.exception


def test_password_gate(app_env):
    app_env.setenv("JOBTRACKER_PASSWORD", "s3cret")
    at = AppTest.from_file(APP, default_timeout=30)
    at.run()
    assert not at.sidebar.radio  # nothing but the login form
    at.text_input[0].input("wrong")
    at.button[0].click().run()
    assert any("Wrong password" in e.value for e in at.error)
    assert not at.sidebar.radio

    at.text_input[0].input("s3cret")
    at.button[0].click().run()
    assert not at.exception
    assert at.sidebar.radio(key="nav")


def test_no_password_by_default(app_env):
    at = AppTest.from_file(APP, default_timeout=30)
    at.run()
    assert at.sidebar.radio(key="nav")
