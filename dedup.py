import re
from urllib.parse import urlsplit, urlunsplit


def _normalize_text(value):
    return re.sub(r"\W+", " ", (value or "").lower()).strip()


def _normalize_url(value):
    if not value:
        return ""

    split = urlsplit(value)
    return urlunsplit((split.scheme.lower(), split.netloc.lower(), split.path.rstrip("/"), "", ""))


def _job_key(job):
    title = _normalize_text(job.get("title", ""))
    company = _normalize_text(job.get("company", ""))
    url = _normalize_url(job.get("url", ""))

    if title and company:
        return ("title_company", title, company)

    if url:
        return ("url", url)

    return ("id", job.get("id", ""))


def _job_quality(job):
    return (
        len(job.get("description", "")),
        len(job.get("tags", [])),
        len(job.get("location", "")),
    )


def remove_duplicates(jobs):
    unique_jobs = {}

    for job in jobs:
        key = _job_key(job)
        existing = unique_jobs.get(key)
        if existing is None or _job_quality(job) > _job_quality(existing):
            unique_jobs[key] = job

    return list(unique_jobs.values())
