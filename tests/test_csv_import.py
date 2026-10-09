import pytest

import csv_import
import db

MESSY_CSV = (
    "Req #,Hiring Co.,Position,Applied On,Stage,City,Next Follow-Up,Comments\n"
    "R-100,Acme,Engineer,03/04/2026,interviewing,Austin,3/11/26,first\n"
    ",Globex,Analyst,2026-03-05,,Remote,,missing req\n"
    "R-300,Initech,PM,not a date,Applied,,,bad date\n"
    "r-100,ACME,Engineer II,Mar 6 2026,Applied,,,dup of row 2\n"
    "R-400,Umbrella,,03/07/2026,Phone screen,,,missing role + bad status\n"
    ",,,,,,,\n"
    "R-500,Hooli,SRE,\"March 8, 2026\",Rejected,,,\n"
)


def load(text=MESSY_CSV):
    df = csv_import.read_csv(text.encode("utf-8"))
    mapping = csv_import.suggest_mapping(list(df.columns))
    return df, mapping


# --- Header auto-mapping ------------------------------------------------------


def test_normalize_header():
    assert csv_import.normalize_header("Req. #") == "req"
    assert csv_import.normalize_header(" Requisition_ID ") == "requisitionid"
    assert csv_import.normalize_header("Follow-Up") == "followup"


def test_suggest_mapping_exact_names_ignore_case_and_punctuation():
    headers = ["REQUISITION ID", "company", "Role", "date-applied", "Status", "Job URL", "e-mail domain", "NOTES"]
    mapping = csv_import.suggest_mapping(headers)
    assert mapping["requisition_id"] == "REQUISITION ID"
    assert mapping["company"] == "company"
    assert mapping["role"] == "Role"
    assert mapping["date_applied"] == "date-applied"
    assert mapping["job_url"] == "Job URL"
    assert mapping["email_domain"] == "e-mail domain"
    assert mapping["notes"] == "NOTES"
    assert mapping["location"] is None


def test_suggest_mapping_aliases_and_unmatched():
    df, mapping = load()
    assert mapping["requisition_id"] == "Req #"
    assert mapping["role"] == "Position"
    assert mapping["date_applied"] == "Applied On"
    assert mapping["status"] == "Stage"
    assert mapping["location"] == "City"
    assert mapping["follow_up"] == "Next Follow-Up"
    assert mapping["notes"] == "Comments"
    assert mapping["company"] is None  # "Hiring Co." has no match; user picks it


def test_exact_field_name_beats_alias():
    # "Title" is an alias for role, but an actual "Role" column wins.
    mapping = csv_import.suggest_mapping(["Title", "Role", "Requisition", "Requisition ID"])
    assert mapping["role"] == "Role"
    assert mapping["requisition_id"] == "Requisition ID"


def test_each_header_used_once():
    mapping = csv_import.suggest_mapping(["Company"])
    assert list(mapping.values()).count("Company") == 1


# --- Dates & statuses -------------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("2026-03-04", "2026-03-04"),
        ("03/04/2026", "2026-03-04"),  # US: March 4
        ("3/4/2026", "2026-03-04"),
        ("3/4/26", "2026-03-04"),
        ("03-04-2026", "2026-03-04"),
        ("2026/03/04", "2026-03-04"),
        ("Mar 4 2026", "2026-03-04"),
        ("March 4, 2026", "2026-03-04"),
        ("Sept 4, 2026", "2026-09-04"),
        ("4 Mar 2026", "2026-03-04"),
        ("04-Mar-2026", "2026-03-04"),
        ("2026-03-04T10:15:00Z", "2026-03-04"),
        ("3/4/2026 2:15 PM", "2026-03-04"),
        ("  03/04/2026 ", "2026-03-04"),
    ],
)
def test_parse_date_common_formats(text, expected):
    assert csv_import.parse_date(text) == (expected, True)


@pytest.mark.parametrize("text", ["not a date", "13/01/2026", "02/30/2026", "2026-13-01", "yesterday"])
def test_parse_date_bad(text):
    assert csv_import.parse_date(text) == (None, False)


@pytest.mark.parametrize("text", ["", "   ", None])
def test_parse_date_blank(text):
    assert csv_import.parse_date(text) == (None, True)


def test_parse_status():
    assert csv_import.parse_status("interviewing") == "Interviewing"
    assert csv_import.parse_status(" OFFER ") == "Offer"
    assert csv_import.parse_status("") == "Applied"
    assert csv_import.parse_status("Phone screen") is None


# --- Reading & validating ---------------------------------------------------


def test_read_csv_handles_bom_and_cp1252_and_blank_rows():
    df = csv_import.read_csv("﻿Company,Role\nCafé,Dev\n,\n".encode("utf-8"))
    assert list(df.columns) == ["Company", "Role"]
    assert df.iloc[0]["Company"] == "Café"
    assert len(df) == 1
    df = csv_import.read_csv("Company,Role\nCafé,Dev\n".encode("cp1252"))
    assert df.iloc[0]["Company"] == "Café"


def test_read_csv_keeps_text_as_is():
    df = csv_import.read_csv(b"Req,Company\n00123,NA\n")
    assert df.iloc[0]["Req"] == "00123"  # no int conversion
    assert df.iloc[0]["Company"] == "NA"  # not treated as missing


def test_records_carry_spreadsheet_row_numbers():
    df, mapping = load()
    mapping["company"] = "Hiring Co."
    records = csv_import.records_from_dataframe(df, mapping)
    assert [r["_row"] for r in records] == [2, 3, 4, 5, 6, 8]  # row 7 was blank
    assert records[0]["company"] == "Acme"


def test_validate_record_problems():
    clean, problems = csv_import.validate_record(
        {"_row": 9, "requisition_id": "", "company": "X", "role": "", "date_applied": "nope", "status": "Hired"}
    )
    assert clean is None
    assert problems == [
        "missing Requisition ID",
        "missing Role",
        "unrecognized Date applied date 'nope'",
        "unknown status 'Hired'",
    ]


def test_build_plan_missing_fields_bad_dates_and_duplicates(conn):
    db.add_job(conn, {"requisition_id": "R-500", "company": "hooli", "role": "SRE"})
    df, mapping = load()
    mapping["company"] = "Hiring Co."
    records = csv_import.records_from_dataframe(df, mapping)
    plan = csv_import.build_plan(records, db.existing_dup_keys(conn))

    assert [r["_row"] for r in plan.ready] == [2]
    ready = plan.ready[0]
    assert ready["date_applied"] == "2026-03-04"
    assert ready["follow_up"] == "2026-03-11"
    assert ready["status"] == "Interviewing"

    invalid = {raw["_row"]: problems for raw, problems in plan.invalid}
    assert invalid[3] == ["missing Requisition ID"]
    assert invalid[4] == ["unrecognized Date applied date 'not a date'"]
    assert invalid[6] == ["missing Role", "unknown status 'Phone screen'"]

    dups = {r["_row"]: why for r, why in plan.duplicates}
    assert dups == {5: "duplicate of row 2 in this file", 8: "already in tracker"}


def test_fixed_rows_become_ready(conn):
    df, mapping = load()
    mapping["company"] = "Hiring Co."
    records = csv_import.records_from_dataframe(df, mapping)
    by_row = {r["_row"]: r for r in records}
    by_row[3]["requisition_id"] = "G-1"  # filled in
    by_row[4]["date_applied"] = ""  # cleared the bad date
    del by_row[6]  # skipped
    plan = csv_import.build_plan(sorted(by_row.values(), key=lambda r: r["_row"]), set())
    assert [r["_row"] for r in plan.ready] == [2, 3, 4, 8]
    assert plan.invalid == []
    assert next(r for r in plan.ready if r["_row"] == 4)["date_applied"] is None


# --- Committing -------------------------------------------------------------


def test_import_jobs_writes_import_history_and_skips_duplicates(conn):
    existing = db.add_job(conn, {"requisition_id": "R-1", "company": "Acme", "role": "Eng"})
    records = [
        {"_row": 2, "requisition_id": "R-2", "company": "Globex", "role": "Analyst", "status": "Offer"},
        {"_row": 3, "requisition_id": "r-1", "company": "ACME", "role": "Eng"},  # dup of DB
        {"_row": 4, "requisition_id": "R-2", "company": "globex", "role": "Analyst"},  # dup in batch
        {"_row": 5, "requisition_id": "R-3", "company": "Initech", "role": "PM", "date_applied": "2026-03-04"},
    ]
    inserted, skipped = db.import_jobs(conn, records)
    assert len(inserted) == 2
    assert [r["_row"] for r in skipped] == [3, 4]
    for job_id in inserted:
        (history,) = db.get_status_history(conn, job_id)
        assert history["source"] == "import" and history["old_status"] is None
    assert db.get_job(conn, inserted[0])["status"] == "Offer"
    assert db.get_job(conn, inserted[1])["status"] == "Applied"
    assert db.get_status_history(conn, existing)[0]["source"] == "manual"


def test_import_jobs_is_all_or_nothing(conn):
    records = [
        {"requisition_id": "R-1", "company": "Acme", "role": "Eng"},
        {"requisition_id": "R-2", "company": "Globex", "role": ""},  # invalid
    ]
    with pytest.raises(db.ValidationError):
        db.import_jobs(conn, records)
    assert db.list_jobs(conn) == []


def test_end_to_end_messy_csv(conn):
    df, mapping = load()
    mapping["company"] = "Hiring Co."
    records = csv_import.records_from_dataframe(df, mapping)
    plan = csv_import.build_plan(records, db.existing_dup_keys(conn))
    inserted, skipped = db.import_jobs(conn, plan.ready)
    assert len(inserted) == 2 and skipped == []  # rows 2 and 8
    companies = sorted(j["company"] for j in db.list_jobs(conn))
    assert companies == ["Acme", "Hooli"]
