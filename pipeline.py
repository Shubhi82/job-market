import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from company_portals import build_company_portals
from dedup import remove_duplicates
from filter import filter_jobs
from rank import rank_jobs
from sources import get_all_jobs

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.getenv("JOB_AGENT_CONFIG_FILE", BASE_DIR / "config.json"))
HISTORY_FILE = Path(os.getenv("JOB_HISTORY_FILE", BASE_DIR / "data/history.json"))
LATEST_JOBS_FILE = Path(os.getenv("JOB_LATEST_JOBS_FILE", BASE_DIR / "data/latest_jobs.json"))
APPLICATIONS_FILE = Path(os.getenv("JOB_APPLICATIONS_FILE", BASE_DIR / "data/applications.json"))
RECRUITER_CONTACTS_FILE = Path(os.getenv("JOB_RECRUITER_CONTACTS_FILE", BASE_DIR / "data/recruiter_contacts.json"))
COMPANY_PORTALS_FILE = Path(os.getenv("JOB_COMPANY_PORTALS_FILE", BASE_DIR / "data/company_portals.json"))


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read_json(path, default):
    if not path.exists():
        return default

    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def _matches_keyword(text, keyword):
    pattern = r"\b" + re.escape(keyword.lower()).replace(r"\ ", r"\s+") + r"\b"
    return re.search(pattern, text.lower()) is not None


def _job_text(job):
    return " ".join(
        [
            job.get("title", ""),
            job.get("company", ""),
            job.get("description", ""),
            job.get("location", ""),
            " ".join(job.get("tags", [])),
        ]
    ).lower()


def load_config():
    return _read_json(CONFIG_FILE, {})


def load_history():
    payload = _read_json(HISTORY_FILE, {"seen_job_ids": []})

    if isinstance(payload, dict):
        return set(payload.get("seen_job_ids", []))

    if isinstance(payload, list):
        return set(payload)

    raise ValueError(f"Unsupported history format in {HISTORY_FILE}")


def save_history(jobs):
    seen_ids = load_history()
    seen_ids.update(job["id"] for job in jobs)
    _write_json(
        HISTORY_FILE,
        {
            "seen_job_ids": sorted(seen_ids),
            "updated_at": utc_now_iso(),
        },
    )


def load_latest_jobs():
    return _read_json(LATEST_JOBS_FILE, {"refreshed_at": "", "jobs": [], "stats": {}})


def save_latest_jobs(snapshot):
    _write_json(LATEST_JOBS_FILE, snapshot)


def load_applications():
    payload = _read_json(APPLICATIONS_FILE, {})
    return payload if isinstance(payload, dict) else {}


def save_applications(applications):
    _write_json(APPLICATIONS_FILE, applications)


def load_recruiter_contacts():
    payload = _read_json(RECRUITER_CONTACTS_FILE, {})
    return payload if isinstance(payload, dict) else {}


def save_recruiter_contacts(contacts):
    _write_json(RECRUITER_CONTACTS_FILE, contacts)


def load_company_portal_notes():
    payload = _read_json(COMPANY_PORTALS_FILE, {})
    return payload if isinstance(payload, dict) else {}


def save_company_portal_notes(notes):
    _write_json(COMPANY_PORTALS_FILE, notes)


def get_company_portals(config=None):
    config = config or load_config()
    return build_company_portals(config)


def _location_fit_points(job, config):
    location_keywords = [keyword.lower() for keyword in config.get("location_keywords", [])]
    text = _job_text(job)
    if job.get("is_remote", False):
        return 15
    if any(_matches_keyword(text, keyword) for keyword in location_keywords):
        return 15
    return 0


def _title_fit_points(job, config):
    title = job.get("title", "").lower()
    target_roles = [role.lower() for role in config.get("profile", {}).get("target_roles", [])]
    if any(role in title for role in target_roles):
        return 35

    partial_titles = [phrase.lower() for phrase in config.get("profile", {}).get("title_signals", [])]
    matched = sum(1 for signal in partial_titles if signal in title)
    return min(28, matched * 7)


def _weighted_keyword_points(job, keywords, max_points):
    text = _job_text(job)
    if not keywords:
        return 0

    matched = sum(1 for keyword in keywords if _matches_keyword(text, keyword))
    return round((matched / len(keywords)) * max_points)


def compute_match_percentage(job, config):
    profile = config.get("profile", {})

    score = 0
    score += _title_fit_points(job, config)
    score += _weighted_keyword_points(job, profile.get("primary_keywords", []), 30)
    score += _weighted_keyword_points(job, profile.get("tool_keywords", []), 10)
    score += _weighted_keyword_points(job, profile.get("domain_keywords", []), 10)
    score += _location_fit_points(job, config)

    return min(100, int(score))


def build_outreach_email(job, config, recruiter_name=None):
    profile = config.get("profile", {})
    matched_keywords = ", ".join(job.get("matched_keywords", [])[:6]) or "data governance, MDM, privacy, and risk analytics"
    greeting = f"Hi {recruiter_name}," if recruiter_name else "Hello,"
    subject = f"Application Interest - {job['title']} at {job['company']}"
    body = "\n".join(
        [
            greeting,
            "",
            f"I’m reaching out regarding the {job['title']} role at {job['company']}.",
            "",
            f"I bring {profile.get('years_experience', '4+')} years of experience across {profile.get('headline', 'data governance, MDM, and risk analytics')}. In my current and prior roles at Macquarie Asset Management and Deloitte, I have led governed data programs spanning master data management, data quality, privacy, regulatory reporting, and executive dashboards.",
            "",
            f"This role stood out because of its overlap with {matched_keywords}. My background includes building Collibra-governed data foundations, defining enterprise data models, automating data pipelines on GCP and AWS, and delivering compliance-ready reporting for senior stakeholders.",
            "",
            "If helpful, I would be glad to share my resume and briefly discuss how my background could support your team.",
            "",
            "Best regards,",
            profile.get("name", "Shubhi Vashistha"),
            profile.get("email", ""),
        ]
    ).strip()
    return {"subject": subject, "body": body}


def contact_for_job(job, applications=None, contacts=None):
    applications = applications or {}
    contacts = contacts or {}
    company_key = job.get("company", "").strip().lower()

    app_record = applications.get(job["id"], {})
    if app_record.get("recruiter_email"):
        return {
            "email": app_record.get("recruiter_email", ""),
            "name": app_record.get("recruiter_name", ""),
            "source": "application tracker",
        }

    company_record = contacts.get(company_key, {})
    if company_record.get("email"):
        return {
            "email": company_record.get("email", ""),
            "name": company_record.get("name", ""),
            "source": "saved company contact",
        }

    return {"email": "", "name": "", "source": ""}


def refresh_jobs(config=None, exclude_history=False, persist_history=False, limit=None):
    config = config or load_config()

    raw_jobs = get_all_jobs(config)
    filtered_jobs = filter_jobs(raw_jobs, config)
    unique_jobs = remove_duplicates(filtered_jobs)

    if exclude_history:
        history = load_history()
        candidate_jobs = [job for job in unique_jobs if job["id"] not in history]
    else:
        candidate_jobs = unique_jobs

    ranked_jobs = rank_jobs(candidate_jobs, config)
    enriched_jobs = []
    for job in ranked_jobs:
        enriched_job = dict(job)
        enriched_job["apply_url"] = job.get("apply_url") or job.get("url", "")
        enriched_job["match_percentage"] = compute_match_percentage(enriched_job, config)
        enriched_jobs.append(enriched_job)

    if limit is not None:
        enriched_jobs = enriched_jobs[: int(limit)]

    snapshot = {
        "refreshed_at": utc_now_iso(),
        "stats": {
            "raw_jobs": len(raw_jobs),
            "filtered_jobs": len(filtered_jobs),
            "deduplicated_jobs": len(unique_jobs),
            "ranked_jobs": len(ranked_jobs),
            "returned_jobs": len(enriched_jobs),
            "exclude_history": exclude_history,
        },
        "jobs": enriched_jobs,
    }
    save_latest_jobs(snapshot)

    if persist_history:
        save_history(enriched_jobs)

    return snapshot
