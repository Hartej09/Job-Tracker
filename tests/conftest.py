import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "test.db"


@pytest.fixture
def conn(db_path):
    connection = db.connect(db_path)
    yield connection
    connection.close()


@pytest.fixture
def make_job(conn):
    def _make(**overrides):
        data = {"requisition_id": "R-1001", "company": "Acme", "role": "Engineer", **overrides}
        return db.add_job(conn, data)

    return _make
