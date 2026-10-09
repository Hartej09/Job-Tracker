"""Job Tracker UI. Run with: streamlit run app.py

No SQL in this file; everything goes through db.py.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime

import pandas as pd
import streamlit as st
from dotenv import load_dotenv

import csv_import
import db

load_dotenv()
st.set_page_config(page_title="Job Tracker", page_icon="💼", layout="wide")

LABELS = csv_import.FIELD_LABELS
NOT_MAPPED = "— not mapped —"
DATE_FORMAT = "MM/DD/YYYY"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def flash(kind: str, message: str) -> None:
    """Queue a message to show after the next rerun."""
    st.session_state.setdefault("_flash", []).append((kind, message))


def show_flashes() -> None:
    for kind, message in st.session_state.pop("_flash", []):
        getattr(st, kind)(message)


def bump(name: str) -> None:
    """Increment a counter used in widget keys, to reset that widget."""
    st.session_state[name] = st.session_state.get(name, 0) + 1


def version(name: str) -> int:
    return st.session_state.get(name, 0)


def to_date(value) -> date | None:
    # pandas turns missing values into NaN, so check for a real string.
    return date.fromisoformat(value) if isinstance(value, str) and value else None


def us_date(value) -> str:
    parsed = to_date(value)
    return parsed.strftime("%m/%d/%Y") if parsed else ""


def norm(value) -> str | None:
    """Normalize an editor cell for comparison: blanks -> None, dates -> ISO."""
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date):
        return value.isoformat()
    text = str(value).strip()
    return text or None


def jobs_frame(jobs: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(jobs, columns=["id", *db.JOB_FIELDS, "created_at", "updated_at"])
    for field in db.JOB_FIELDS:
        if field in db.DATE_FIELDS:
            df[field] = df[field].map(to_date).astype(object)
        else:
            df[field] = df[field].fillna("")  # show blanks, not "None"
    return df


def display_frame(rows: list[dict], extra: dict[str, list] | None = None) -> pd.DataFrame:
    """Read-only table with friendly column names and US dates."""
    df = pd.DataFrame(rows, columns=list(db.JOB_FIELDS))
    for field in db.DATE_FIELDS:
        df[field] = df[field].map(us_date)
    df = df.fillna("").rename(columns=LABELS)
    for name, values in (extra or {}).items():
        df.insert(0, name, values)
    return df


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------


def page_jobs(conn) -> None:
    st.header("Jobs")

    f1, f2 = st.columns([1, 2])
    statuses = f1.multiselect("Status", db.STATUSES, key="filter_status")
    search = f2.text_input(
        "Search", key="filter_search", placeholder="Company, role, requisition ID or notes"
    )
    jobs = db.list_jobs(conn, statuses, search)

    if not jobs:
        st.info("No jobs match." if (statuses or search) else "No jobs yet. Add one or import a CSV.")
        return

    original = jobs_frame(jobs)
    original.insert(0, "delete", False)
    fingerprint = hashlib.md5(
        repr([(j["id"], j["updated_at"]) for j in jobs]).encode()
    ).hexdigest()[:10]

    edited = st.data_editor(
        original,
        key=f"jobs_editor_{version('editor_v')}_{fingerprint}",
        hide_index=True,
        num_rows="fixed",
        width="stretch",
        column_order=["delete", "id", *db.JOB_FIELDS],
        disabled=["id"],
        column_config={
            "delete": st.column_config.CheckboxColumn("Delete", width="small"),
            "id": st.column_config.NumberColumn("ID", width="small"),
            "requisition_id": st.column_config.TextColumn(LABELS["requisition_id"], required=True),
            "company": st.column_config.TextColumn(LABELS["company"], required=True),
            "role": st.column_config.TextColumn(LABELS["role"], required=True),
            "date_applied": st.column_config.DateColumn(LABELS["date_applied"], format=DATE_FORMAT),
            "status": st.column_config.SelectboxColumn(
                LABELS["status"], options=list(db.STATUSES), required=True
            ),
            "location": st.column_config.TextColumn(LABELS["location"]),
            "salary_range": st.column_config.TextColumn(LABELS["salary_range"]),
            "job_url": st.column_config.LinkColumn(LABELS["job_url"]),
            "contact": st.column_config.TextColumn(LABELS["contact"]),
            "email_domain": st.column_config.TextColumn(LABELS["email_domain"]),
            "follow_up": st.column_config.DateColumn(LABELS["follow_up"], format=DATE_FORMAT),
            "notes": st.column_config.TextColumn(LABELS["notes"], width="large"),
        },
    )

    # Diff edited rows against what was loaded from the DB.
    loaded = {row["id"]: row for row in jobs}
    changes: dict[int, dict[str, str | None]] = {}
    for _, row in edited.iterrows():
        job_id = int(row["id"])
        row_changes = {
            field: norm(row[field])
            for field in db.JOB_FIELDS
            if norm(row[field]) != norm(loaded[job_id][field])
        }
        if row_changes:
            changes[job_id] = row_changes
    to_delete = [int(i) for i in edited.loc[edited["delete"].astype(bool), "id"]]

    b1, b2, b3 = st.columns([1, 1, 2])
    if b1.button(
        f"Save changes ({len(changes)})" if changes else "Save changes",
        type="primary",
        disabled=not changes,
    ):
        save_edits(conn, changes, loaded)
    if b2.button(f"Delete selected ({len(to_delete)})…", disabled=not to_delete):
        st.session_state["confirm_delete"] = to_delete
    b3.download_button(
        "Export current view (CSV)",
        data=pd.DataFrame(jobs).to_csv(index=False).encode("utf-8-sig"),
        file_name=f"jobs_export_{date.today().isoformat()}.csv",
        mime="text/csv",
    )
    if changes:
        st.caption("Unsaved edits are discarded if you change the filters or another process updates these jobs.")

    pending_delete = st.session_state.get("confirm_delete")
    if pending_delete:
        names = [f"{loaded[i]['company']} — {loaded[i]['role']}" for i in pending_delete if i in loaded]
        st.error(
            f"Permanently delete {len(pending_delete)} job(s)? Their status history is deleted too. "
            "This can't be undone.\n\n" + "\n".join(f"- {n}" for n in names)
        )
        c1, c2, _ = st.columns([1, 1, 4])
        if c1.button("Yes, delete", type="primary"):
            deleted = sum(db.delete_job(conn, job_id) for job_id in pending_delete)
            st.session_state.pop("confirm_delete")
            flash("success", f"Deleted {deleted} job(s).")
            bump("editor_v")
            st.rerun()
        if c2.button("Cancel"):
            st.session_state.pop("confirm_delete")
            st.rerun()

    with st.expander("Status history"):
        choice = st.selectbox(
            "Job",
            [j["id"] for j in jobs],
            format_func=lambda i: f"#{i} {loaded[i]['company']} — {loaded[i]['role']} ({loaded[i]['requisition_id']})",
        )
        history = db.get_status_history(conn, choice)
        st.dataframe(
            pd.DataFrame(history, columns=["changed_at", "old_status", "new_status", "source"]),
            hide_index=True,
            width="stretch",
        )


def save_edits(conn, changes: dict[int, dict], loaded: dict[int, dict]) -> None:
    # Validate everything first so a bad cell doesn't leave a half-saved batch.
    errors = []
    for job_id, row_changes in changes.items():
        _, problems = db.normalize_fields(row_changes)
        if problems:
            label = f"{loaded[job_id]['company']} — {loaded[job_id]['role']} (#{job_id})"
            errors.append(f"{label}: {'; '.join(problems)}")
    if errors:
        st.error("Nothing saved. Fix these first:\n\n" + "\n".join(f"- {e}" for e in errors))
        return

    saved = 0
    for job_id, row_changes in changes.items():
        try:
            db.update_job(conn, job_id, row_changes, expected_updated_at=loaded[job_id]["updated_at"])
            saved += 1
        except db.ConflictError as exc:
            flash("warning", f"Not saved — {exc}. The table now shows the latest data; re-apply your edit.")
    if saved:
        flash("success", f"Saved {saved} job(s).")
    bump("editor_v")
    st.rerun()


def page_add(conn) -> None:
    st.header("Add job")
    with st.form(f"add_job_{version('add_v')}"):
        c1, c2, c3 = st.columns(3)
        requisition_id = c1.text_input("Requisition ID *")
        company = c2.text_input("Company *")
        role = c3.text_input("Role *")
        c1, c2, c3 = st.columns(3)
        date_applied = c1.date_input("Date applied", value=date.today(), format=DATE_FORMAT)
        status = c2.selectbox("Status", db.STATUSES)
        follow_up = c3.date_input("Follow-up", value=None, format=DATE_FORMAT)
        c1, c2, c3 = st.columns(3)
        location = c1.text_input("Location")
        salary_range = c2.text_input("Salary range")
        contact = c3.text_input("Contact")
        c1, c2 = st.columns(2)
        job_url = c1.text_input("Job URL")
        email_domain = c2.text_input("Email domain", help="e.g. acme.com — used later to match emails")
        notes = st.text_area("Notes")
        submitted = st.form_submit_button("Add job", type="primary")

    if submitted:
        data = {
            "requisition_id": requisition_id,
            "company": company,
            "role": role,
            "date_applied": date_applied,
            "status": status,
            "location": location,
            "salary_range": salary_range,
            "job_url": job_url,
            "contact": contact,
            "email_domain": email_domain,
            "follow_up": follow_up,
            "notes": notes,
        }
        _, problems = db.normalize_fields(data)
        if problems:
            st.error("\n".join(f"- {p}" for p in problems))
        elif db.find_duplicates(conn, company, requisition_id):
            st.session_state["pending_add"] = data
        else:
            add_and_reset(conn, data)

    pending = st.session_state.get("pending_add")
    if pending:
        dups = db.find_duplicates(conn, pending["company"], pending["requisition_id"])
        st.warning(
            f"You already have {len(dups)} job(s) at **{pending['company'].strip()}** with requisition ID "
            f"**{pending['requisition_id'].strip()}**:"
        )
        st.dataframe(display_frame(dups), hide_index=True, width="stretch")
        c1, c2, _ = st.columns([1, 1, 4])
        if c1.button("Add anyway", type="primary"):
            add_and_reset(conn, pending)
        if c2.button("Cancel"):
            st.session_state.pop("pending_add")
            st.rerun()


def add_and_reset(conn, data: dict) -> None:
    db.add_job(conn, data)
    st.session_state.pop("pending_add", None)
    flash("success", f"Added {data['company'].strip()} — {data['role'].strip()}.")
    bump("add_v")
    st.rerun()


def page_follow_ups(conn) -> None:
    st.header("Follow-ups due")
    due = db.follow_ups_due(conn)
    if not due:
        st.success("Nothing due. 🎉")
        return
    today = date.today()
    overdue = [(today - date.fromisoformat(j["follow_up"])).days for j in due]
    st.dataframe(
        display_frame(due, {"Days overdue": overdue}),
        hide_index=True,
        width="stretch",
        column_config={LABELS["job_url"]: st.column_config.LinkColumn(LABELS["job_url"])},
    )
    st.caption("Change or clear the follow-up date in the Jobs table once you've followed up.")


def page_stats(conn) -> None:
    st.header("Stats")
    counts = db.count_by_status(conn)
    total = sum(counts.values())
    if not total:
        st.info("No jobs yet.")
        return
    cols = st.columns(len(counts) + 1)
    cols[0].metric("Total", total)
    for col, (status, n) in zip(cols[1:], counts.items()):
        col.metric(status, n)

    c1, c2 = st.columns(2)
    with c1:
        st.subheader("Jobs by status")
        by_status = pd.DataFrame({"Status": list(counts), "Jobs": list(counts.values())})
        st.bar_chart(by_status, x="Status", y="Jobs", sort=False)
    with c2:
        st.subheader("Applications per week")
        weeks = db.applications_per_week(conn)
        if not weeks:
            st.info("No jobs have a date applied.")
        else:
            series = pd.Series({pd.Timestamp(w): n for w, n in weeks})
            full = pd.date_range(series.index.min(), series.index.max(), freq="W-MON")
            per_week = series.reindex(full, fill_value=0)
            chart = pd.DataFrame({"Week of": per_week.index.strftime("%m/%d/%Y"), "Applications": per_week.values})
            st.bar_chart(chart, x="Week of", y="Applications", sort=False)


def page_import(conn) -> None:
    st.header("Import CSV")
    report = st.session_state.pop("import_report", None)
    if report:
        st.success(report["summary"])
        if report["duplicates"]:
            st.write("Skipped duplicates:")
            st.dataframe(pd.DataFrame(report["duplicates"]), hide_index=True, width="stretch")
        if report["skipped"]:
            st.write("Skipped rows with problems:")
            st.dataframe(pd.DataFrame(report["skipped"]), hide_index=True, width="stretch")

    upload = st.file_uploader("CSV file", type=["csv"], key=f"uploader_{version('upload_v')}")
    if upload is None:
        return
    raw_bytes = upload.getvalue()
    try:
        df = csv_import.read_csv(raw_bytes)
    except (pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
        st.error(f"Couldn't read that CSV: {exc}")
        return
    if df.empty:
        st.warning("That file has no data rows.")
        return
    file_id = hashlib.md5(raw_bytes).hexdigest()[:10]
    headers = list(df.columns)

    # 1. Column mapping
    st.subheader("1. Map columns")
    st.caption(f"{len(df)} data rows. Suggested matches are pre-selected; correct any that are wrong.")
    suggested = csv_import.suggest_mapping(headers)
    options = [NOT_MAPPED, *headers]
    mapping: dict[str, str | None] = {}
    cols = st.columns(4)
    for i, field in enumerate(db.JOB_FIELDS):
        label = LABELS[field] + (" *" if field in db.REQUIRED_FIELDS else "")
        default = options.index(suggested[field]) if suggested[field] else 0
        choice = cols[i % 4].selectbox(label, options, index=default, key=f"map_{file_id}_{field}")
        mapping[field] = None if choice == NOT_MAPPED else choice
    used = [h for h in mapping.values() if h]
    if len(used) != len(set(used)):
        st.warning("The same CSV column is mapped to more than one field.")
    unmapped_required = [LABELS[f] for f in db.REQUIRED_FIELDS if not mapping[f]]
    if unmapped_required:
        st.warning(
            f"{', '.join(unmapped_required)} not mapped — every row will need it filled in below."
        )
    with st.expander("Raw file preview"):
        st.dataframe(df.head(20), width="stretch")

    records = csv_import.records_from_dataframe(df, mapping)
    ok_raw, problem_raw = [], []
    for record in records:
        _, problems = csv_import.validate_record(record)
        (problem_raw if problems else ok_raw).append((record, problems))

    # 2. Fix-up table
    st.subheader("2. Rows with problems")
    fixed_raw: list[dict] = []
    skipped: list[dict] = []
    if not problem_raw:
        st.success("No rows with missing required fields, bad dates or unknown statuses.")
    else:
        st.caption(
            "Fill in or correct the cells (dates as MM/DD/YYYY), or tick **Skip** to leave a row out."
        )
        fix_df = pd.DataFrame(
            [
                {"skip": False, "_row": r["_row"], "problems": "; ".join(p), **{f: r[f] for f in db.JOB_FIELDS}}
                for r, p in problem_raw
            ]
        )
        status_options = list(db.STATUSES) + sorted(
            {r["status"] for r, _ in problem_raw if r["status"] and csv_import.parse_status(r["status"]) is None}
        )
        mapping_id = hashlib.md5(repr(sorted(mapping.items(), key=lambda kv: kv[0])).encode()).hexdigest()[:8]
        skip_all = st.checkbox("Skip all rows with problems", key=f"skipall_{file_id}")
        fixed_df = st.data_editor(
            fix_df,
            key=f"fix_{file_id}_{mapping_id}",
            hide_index=True,
            num_rows="fixed",
            width="stretch",
            disabled=["_row", "problems"] + (list(fix_df.columns) if skip_all else []),
            column_config={
                "skip": st.column_config.CheckboxColumn("Skip", width="small"),
                "_row": st.column_config.NumberColumn("CSV row", width="small"),
                "problems": st.column_config.TextColumn("Problems", width="medium"),
                "status": st.column_config.SelectboxColumn(LABELS["status"], options=status_options),
                **{
                    f: st.column_config.TextColumn(LABELS[f] + (" *" if f in db.REQUIRED_FIELDS else ""))
                    for f in db.JOB_FIELDS
                    if f != "status"
                },
            },
        )
        for _, row in fixed_df.iterrows():
            record = {"_row": int(row["_row"]), **{f: norm(row[f]) or "" for f in db.JOB_FIELDS}}
            if skip_all or bool(row["skip"]):
                skipped.append({"CSV row": record["_row"], "Problems": row["problems"]})
            else:
                fixed_raw.append(record)

    final_records = sorted([r for r, _ in ok_raw] + fixed_raw, key=lambda r: r["_row"])
    plan = csv_import.build_plan(final_records, db.existing_dup_keys(conn))

    # 3. Preview & commit
    st.subheader("3. Preview")
    m = st.columns(4)
    m[0].metric("Ready to import", len(plan.ready))
    m[1].metric("Duplicates (skipped)", len(plan.duplicates))
    m[2].metric("Rows skipped", len(skipped))
    m[3].metric("Still need fixing", len(plan.invalid))

    if plan.invalid:
        st.error(
            "These rows still have problems — fix them above or tick Skip:\n\n"
            + "\n".join(f"- Row {r['_row']}: {'; '.join(p)}" for r, p in plan.invalid)
        )
    if plan.ready:
        st.dataframe(
            display_frame(plan.ready, {"CSV row": [r["_row"] for r in plan.ready]}),
            hide_index=True,
            width="stretch",
        )
    dup_rows = [
        {"CSV row": r["_row"], "Company": r["company"], "Requisition ID": r["requisition_id"], "Reason": why}
        for r, why in plan.duplicates
    ]
    if dup_rows:
        with st.expander(f"Duplicates that will be skipped ({len(dup_rows)})", expanded=True):
            st.dataframe(pd.DataFrame(dup_rows), hide_index=True, width="stretch")

    if st.button(
        f"Import {len(plan.ready)} job(s)",
        type="primary",
        disabled=bool(plan.invalid) or not plan.ready,
    ):
        inserted, late_dups = db.import_jobs(conn, plan.ready)
        dup_rows += [
            {"CSV row": r["_row"], "Company": r["company"], "Requisition ID": r["requisition_id"],
             "Reason": "added to tracker during import"}
            for r in late_dups
        ]
        st.session_state["import_report"] = {
            "summary": f"Imported {len(inserted)} job(s). Skipped {len(dup_rows)} duplicate(s) "
            f"and {len(skipped)} row(s) with problems.",
            "duplicates": dup_rows,
            "skipped": skipped,
        }
        bump("upload_v")
        st.rerun()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    conn = db.connect()
    try:
        due = len(db.follow_ups_due(conn))
        pages = {
            "Jobs": page_jobs,
            "Add job": page_add,
            "Follow-ups": page_follow_ups,
            "Stats": page_stats,
            "Import CSV": page_import,
        }
        with st.sidebar:
            st.title("💼 Job Tracker")
            choice = st.radio(
                "Go to",
                list(pages),
                format_func=lambda p: f"{p} ({due})" if p == "Follow-ups" and due else p,
                label_visibility="collapsed",
                key="nav",
            )
            st.divider()
            st.caption(f"Database: `{db.default_db_path()}`")
        show_flashes()
        pages[choice](conn)
    finally:
        conn.close()


main()
