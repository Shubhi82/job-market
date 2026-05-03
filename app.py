from datetime import datetime, timezone

import streamlit as st

from pipeline import (
    build_outreach_email,
    contact_for_job,
    load_applications,
    load_config,
    load_latest_jobs,
    load_recruiter_contacts,
    refresh_jobs,
    save_applications,
    save_recruiter_contacts,
)

STATUSES = ["Not started", "Saved", "Applied", "Interviewing", "Offer", "Rejected", "Closed"]


def parse_iso(value):
    if not value:
        return None

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def snapshot_is_stale(snapshot):
    refreshed_at = parse_iso(snapshot.get("refreshed_at", ""))
    if not refreshed_at:
        return True

    return (datetime.now(timezone.utc) - refreshed_at).total_seconds() > 24 * 60 * 60


def save_tracker_record(job_id, current_record, recruiter_contacts):
    applications = load_applications()

    status = st.session_state.get(f"status_{job_id}", current_record.get("status", "Not started"))
    recruiter_email = st.session_state.get(f"email_{job_id}", current_record.get("recruiter_email", "")).strip()
    recruiter_name = st.session_state.get(f"name_{job_id}", current_record.get("recruiter_name", "")).strip()
    notes = st.session_state.get(f"notes_{job_id}", current_record.get("notes", "")).strip()

    record = dict(current_record)
    record.update(
        {
            "status": status,
            "recruiter_email": recruiter_email,
            "recruiter_name": recruiter_name,
            "notes": notes,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    if status == "Applied" and not record.get("applied_at"):
        record["applied_at"] = datetime.now(timezone.utc).isoformat()

    applications[job_id] = record
    save_applications(applications)

    company_key = current_record.get("company_key", "")
    if company_key and recruiter_email:
        recruiter_contacts[company_key] = {
            "email": recruiter_email,
            "name": recruiter_name,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        save_recruiter_contacts(recruiter_contacts)


def render_job_card(job, applications, contacts, config):
    tracker_record = dict(applications.get(job["id"], {}))
    tracker_record["company_key"] = job.get("company", "").strip().lower()
    contact = contact_for_job(job, applications, contacts)
    draft = build_outreach_email(job, config, recruiter_name=contact.get("name"))

    title_line = f"{job['title']} - {job['company']}"
    badges = f"Match {job['match_percentage']}% | Score {job['score']} | {job.get('location') or 'Location not listed'}"
    st.markdown(f"### {title_line}")
    st.caption(badges)

    col1, col2, col3, col4 = st.columns([1.1, 1.2, 1, 1.2])
    with col1:
        st.link_button("Open Job", job["url"], use_container_width=True)
    with col2:
        st.link_button("Apply Link", job["apply_url"], use_container_width=True)
    with col3:
        st.write(f"Status: **{tracker_record.get('status', 'Not started')}**")
    with col4:
        if contact.get("email"):
            st.write(f"Contact: `{contact['email']}`")
        else:
            st.write("Contact: add manually")

    if job.get("matched_keywords"):
        st.write("Matched profile signals:", ", ".join(job["matched_keywords"]))

    if job.get("description"):
        st.write(job["description"][:380] + ("..." if len(job["description"]) > 380 else ""))

    with st.expander("Track application and outreach", expanded=False):
        st.selectbox(
            "Application status",
            STATUSES,
            index=STATUSES.index(tracker_record.get("status", "Not started")),
            key=f"status_{job['id']}",
        )
        st.text_input(
            "Recruiter or HR email",
            value=tracker_record.get("recruiter_email", contact.get("email", "")),
            key=f"email_{job['id']}",
            help="Public job APIs rarely include recruiter emails. Add one here when you find it on LinkedIn or the company site.",
        )
        st.text_input(
            "Recruiter name",
            value=tracker_record.get("recruiter_name", contact.get("name", "")),
            key=f"name_{job['id']}",
        )
        st.text_area(
            "Notes",
            value=tracker_record.get("notes", ""),
            key=f"notes_{job['id']}",
            placeholder="Referral lead, application date, interview notes, portal status, or next follow-up.",
        )
        st.button(
            "Save tracker update",
            key=f"save_{job['id']}",
            on_click=save_tracker_record,
            args=(job["id"], tracker_record, contacts),
            use_container_width=True,
        )

        st.write("Suggested outreach subject")
        st.code(draft["subject"])
        st.write("Suggested outreach email")
        st.text_area("Email draft", value=draft["body"], height=220, key=f"draft_{job['id']}")


st.set_page_config(page_title="Shubhi Job Radar", page_icon="briefcase", layout="wide")
st.markdown(
    """
    <style>
      .stApp {
        background:
          radial-gradient(circle at top right, rgba(233, 179, 132, 0.22), transparent 28%),
          radial-gradient(circle at left, rgba(83, 135, 185, 0.18), transparent 26%),
          linear-gradient(180deg, #f6f1e8 0%, #fbfaf7 55%, #eef4f7 100%);
      }
      .block-container {
        padding-top: 2rem;
        padding-bottom: 3rem;
        max-width: 1200px;
      }
    </style>
    """,
    unsafe_allow_html=True,
)

config = load_config()
applications = load_applications()
contacts = load_recruiter_contacts()
snapshot = load_latest_jobs()

if "auto_refresh_attempted" not in st.session_state:
    st.session_state.auto_refresh_attempted = False

if snapshot_is_stale(snapshot) and not st.session_state.auto_refresh_attempted:
    st.session_state.auto_refresh_attempted = True
    try:
        snapshot = refresh_jobs(config=config, exclude_history=False, persist_history=False)
    except Exception as exc:
        st.warning(f"Automatic refresh could not complete right now: {exc}")

st.title("Shubhi Job Radar")
st.write("Daily-updated job radar for governance, MDM, privacy, risk, and analytics roles with outreach drafting and application tracking.")

with st.sidebar:
    st.header("Controls")
    if st.button("Refresh jobs now", use_container_width=True):
        with st.spinner("Refreshing job feed..."):
            snapshot = refresh_jobs(config=config, exclude_history=False, persist_history=False)
        st.success("Job feed refreshed.")

    min_match = st.slider("Minimum match %", min_value=0, max_value=100, value=60, step=5)
    selected_statuses = st.multiselect("Application statuses", STATUSES, default=STATUSES)
    company_filter = st.text_input("Company contains")
    only_high_match = st.checkbox("Show only 95%+ matches", value=False)

jobs = snapshot.get("jobs", [])

for job in jobs:
    tracker_record = applications.get(job["id"], {})
    job["application_status"] = tracker_record.get("status", "Not started")
    contact = contact_for_job(job, applications, contacts)
    job["recruiter_email"] = contact.get("email", "")

filtered_jobs = []
for job in jobs:
    if job["match_percentage"] < min_match:
        continue
    if job["application_status"] not in selected_statuses:
        continue
    if company_filter and company_filter.lower() not in job.get("company", "").lower():
        continue
    if only_high_match and job["match_percentage"] < 95:
        continue
    filtered_jobs.append(job)

stats = snapshot.get("stats", {})
refreshed_at = snapshot.get("refreshed_at", "Not yet refreshed")
high_match_jobs = [job for job in jobs if job["match_percentage"] >= 95]
applied_jobs = [record for record in applications.values() if record.get("status") == "Applied"]

metric1, metric2, metric3, metric4 = st.columns(4)
metric1.metric("Current relevant jobs", len(jobs))
metric2.metric("Visible after filters", len(filtered_jobs))
metric3.metric("95%+ matches", len(high_match_jobs))
metric4.metric("Tracked as applied", len(applied_jobs))
st.caption(f"Latest refresh: {refreshed_at}")

tab1, tab2, tab3 = st.tabs(["Live Matches", "Application Tracker", "95%+ Outreach"])

with tab1:
    if not filtered_jobs:
        st.info("No jobs match the current filters. Lower the minimum match score or refresh the feed.")
    for job in filtered_jobs:
        render_job_card(job, applications, contacts, config)
        st.divider()

with tab2:
    if not applications:
        st.info("No applications tracked yet. Save a status from the Live Matches tab to start building your pipeline.")
    else:
        tracked_rows = []
        jobs_by_id = {job["id"]: job for job in jobs}
        for job_id, record in applications.items():
            job = jobs_by_id.get(job_id, {})
            tracked_rows.append(
                {
                    "title": job.get("title", record.get("title", "Unknown role")),
                    "company": job.get("company", record.get("company", "Unknown company")),
                    "status": record.get("status", "Not started"),
                    "match %": job.get("match_percentage", ""),
                    "location": job.get("location", ""),
                    "recruiter_email": record.get("recruiter_email", ""),
                    "applied_at": record.get("applied_at", ""),
                    "notes": record.get("notes", ""),
                }
            )
        st.dataframe(tracked_rows, use_container_width=True, hide_index=True)

with tab3:
    if not high_match_jobs:
        st.info("No jobs are at 95%+ match yet. This threshold is intentionally strict so recruiter outreach only triggers for near-perfect fits.")
    for job in high_match_jobs:
        contact = contact_for_job(job, applications, contacts)
        draft = build_outreach_email(job, config, recruiter_name=contact.get("name"))
        st.markdown(f"### {job['title']} - {job['company']}")
        st.caption(f"Match {job['match_percentage']}% | {job.get('location') or 'Location not listed'}")
        if contact.get("email"):
            st.write(f"Recruiter email: `{contact['email']}`")
        else:
            st.warning("No recruiter email is available yet for this role. Add one from LinkedIn or the company careers page in the tracker.")
        st.code(draft["subject"])
        st.text_area(
            f"Email draft for {job['company']}",
            value=draft["body"],
            height=220,
            key=f"highmatch_{job['id']}",
        )
        st.divider()
