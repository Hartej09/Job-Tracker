"""CSV import: header auto-mapping, US date parsing, row validation and
duplicate detection. No SQL here; persistence goes through db.py."""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, BinaryIO

import pandas as pd

import db

FIELD_LABELS = {
    "requisition_id": "Requisition ID",
    "company": "Company",
    "role": "Role",
    "date_applied": "Date applied",
    "status": "Status",
    "location": "Location",
    "salary_range": "Salary range",
    "job_url": "Job URL",
    "contact": "Contact",
    "email_domain": "Email domain",
    "follow_up": "Follow-up",
    "notes": "Notes",
}

# Normalized header names that auto-map to each field. The first entry is the
# field's own name and wins over aliases of other fields.
FIELD_ALIASES: dict[str, list[str]] = {
    "requisition_id": [
        "requisitionid", "requisition", "requisitionnumber", "requisitionno", "reqid",
        "req", "reqno", "reqnumber", "jobid", "jobreqid", "jobrequisitionid", "postingid",
    ],
    "company": ["company", "companyname", "employer", "organization", "organisation"],
    "role": ["role", "title", "jobtitle", "position", "positiontitle", "jobrole"],
    "date_applied": [
        "dateapplied", "applied", "appliedon", "applieddate", "applicationdate", "dateofapplication",
    ],
    "status": ["status", "stage", "applicationstatus"],
    "location": ["location", "city", "joblocation"],
    "salary_range": ["salaryrange", "salary", "compensation", "pay", "payrange"],
    "job_url": ["joburl", "url", "link", "joblink", "postingurl", "postinglink"],
    "contact": ["contact", "recruiter", "contactname", "hiringmanager"],
    "email_domain": ["emaildomain", "domain"],
    "follow_up": ["followup", "followupdate", "nextfollowup", "followupon"],
    "notes": ["notes", "note", "comments", "comment"],
}

# US conventions: 03/04/2026 is March 4.
DATE_FORMATS = (
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%m-%d-%y",
    "%m.%d.%Y",
    "%b %d %Y",
    "%B %d %Y",
    "%d %b %Y",
    "%d %B %Y",
    "%d-%b-%Y",
    "%d-%b-%y",
    "%b-%d-%Y",
    "%Y%m%d",
)

_TIME_SUFFIX = re.compile(
    r"^(?P<date>.+?)[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?$"
)


def normalize_header(header: str) -> str:
    """Lowercase and drop spaces/punctuation: 'Req. #' -> 'req'."""
    return re.sub(r"[\W_]+", "", str(header).casefold())


def suggest_mapping(headers: list[str]) -> dict[str, str | None]:
    """For each DB field, the CSV header that matches it (or None). Each header
    is used at most once; exact field names beat aliases."""
    normalized = {h: normalize_header(h) for h in headers}
    mapping: dict[str, str | None] = dict.fromkeys(db.JOB_FIELDS)
    used: set[str] = set()

    def claim(field_name: str, alias: str) -> bool:
        for header, norm in normalized.items():
            if header not in used and norm == alias:
                mapping[field_name] = header
                used.add(header)
                return True
        return False

    for field_name in db.JOB_FIELDS:
        claim(field_name, FIELD_ALIASES[field_name][0])
    for field_name in db.JOB_FIELDS:
        if mapping[field_name] is None:
            for alias in FIELD_ALIASES[field_name][1:]:
                if claim(field_name, alias):
                    break
    return mapping


def parse_date(value: Any) -> tuple[str | None, bool]:
    """Parse a date in a common (US-ordered) format.

    Returns (iso_date_or_None, ok). Blank -> (None, True); unparseable ->
    (None, False).
    """
    if value is None or (isinstance(value, float) and value != value):
        return None, True
    if isinstance(value, datetime):
        return value.date().isoformat(), True
    if isinstance(value, date):
        return value.isoformat(), True
    text = " ".join(str(value).replace(",", " ").split())
    if not text:
        return None, True
    match = _TIME_SUFFIX.match(text)
    if match:
        text = match.group("date")
    text = re.sub(r"\bSept\b", "Sep", text, flags=re.IGNORECASE)
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text, fmt).date().isoformat(), True
        except ValueError:
            continue
    return None, False


def parse_status(value: Any) -> str | None:
    """Canonical status (case-insensitive); blank -> 'Applied'; unknown -> None."""
    text = "" if value is None else str(value).strip()
    if not text:
        return "Applied"
    for status in db.STATUSES:
        if status.casefold() == text.casefold():
            return status
    return None


def read_csv(source: bytes | str | os.PathLike | BinaryIO) -> pd.DataFrame:
    """Read a CSV as all-text columns. Tries UTF-8 (with BOM), then Windows-1252.
    Adds no columns; fully blank rows are dropped. The index is the spreadsheet
    row number (header = row 1)."""
    if isinstance(source, bytes):
        data = source
    elif isinstance(source, (str, os.PathLike)):
        data = Path(source).read_bytes()
    else:
        data = source.read()
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    df = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False, skip_blank_lines=True)
    df.columns = [str(c).strip() for c in df.columns]
    df.index = df.index + 2
    blank = df.apply(lambda r: all(not str(v).strip() for v in r), axis=1)
    return df[~blank] if len(df) else df


def records_from_dataframe(df: pd.DataFrame, mapping: dict[str, str | None]) -> list[dict[str, Any]]:
    """Raw (string) records keyed by DB field, plus '_row' (spreadsheet row)."""
    records = []
    for row_number, row in df.iterrows():
        record: dict[str, Any] = {"_row": int(row_number)}
        for field_name in db.JOB_FIELDS:
            header = mapping.get(field_name)
            value = row[header] if header else ""
            record[field_name] = "" if value is None else str(value).strip()
        records.append(record)
    return records


def validate_record(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """Convert a raw record into a clean one. Returns (clean, []) or (None, problems)."""
    problems: list[str] = []
    clean: dict[str, Any] = {"_row": raw.get("_row")}

    def text(field_name: str) -> str:
        value = raw.get(field_name)
        if value is None or (isinstance(value, float) and value != value):
            return ""
        return str(value).strip()

    for field_name in db.JOB_FIELDS:
        value = text(field_name)
        if field_name in db.REQUIRED_FIELDS and not value:
            problems.append(f"missing {FIELD_LABELS[field_name]}")
        if field_name in db.DATE_FIELDS:
            iso, ok = parse_date(value)
            if not ok:
                problems.append(f"unrecognized {FIELD_LABELS[field_name]} date {value!r}")
            clean[field_name] = iso
        elif field_name == "status":
            status = parse_status(value)
            if status is None:
                problems.append(f"unknown status {value!r}")
            clean[field_name] = status
        else:
            clean[field_name] = value or None
    if problems:
        return None, problems
    return clean, []


@dataclass
class ImportPlan:
    ready: list[dict[str, Any]] = field(default_factory=list)
    invalid: list[tuple[dict[str, Any], list[str]]] = field(default_factory=list)
    duplicates: list[tuple[dict[str, Any], str]] = field(default_factory=list)


def build_plan(raw_records: list[dict[str, Any]], existing_keys: set[tuple[str, str]]) -> ImportPlan:
    """Split records into ready / invalid / duplicate. Duplicates are checked
    (company + requisition ID, case-insensitive) against `existing_keys` and
    earlier rows in the file; the first occurrence wins."""
    plan = ImportPlan()
    first_seen: dict[tuple[str, str], int] = {}
    for raw in raw_records:
        clean, problems = validate_record(raw)
        if clean is None:
            plan.invalid.append((raw, problems))
            continue
        key = db.dup_key(clean["company"], clean["requisition_id"])
        if key in existing_keys:
            plan.duplicates.append((clean, "already in tracker"))
        elif key in first_seen:
            plan.duplicates.append((clean, f"duplicate of row {first_seen[key]} in this file"))
        else:
            first_seen[key] = clean["_row"]
            plan.ready.append(clean)
    return plan
