import re


def _matches_keyword(text, keyword):
    pattern = r"\b" + re.escape(keyword.lower()).replace(r"\ ", r"\s+") + r"\b"
    return re.search(pattern, text) is not None


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


def filter_jobs(jobs, config):
    keywords = [keyword.lower() for keyword in config.get("keywords", [])]
    exclude_keywords = [keyword.lower() for keyword in config.get("exclude_keywords", [])]
    remote_only = bool(config.get("remote_only", False))
    include_remote_jobs = bool(config.get("include_remote_jobs", True))
    location_keywords = [keyword.lower() for keyword in config.get("location_keywords", [])]

    result = []
    for job in jobs:
        text = _job_text(job)
        is_remote = job.get("is_remote", False)
        matches_location = any(_matches_keyword(text, keyword) for keyword in location_keywords) if location_keywords else False

        if keywords and not any(_matches_keyword(text, keyword) for keyword in keywords):
            continue

        if exclude_keywords and any(_matches_keyword(text, keyword) for keyword in exclude_keywords):
            continue

        if remote_only and not job.get("is_remote", False):
            continue

        if not remote_only and (include_remote_jobs or location_keywords):
            if not ((include_remote_jobs and is_remote) or matches_location):
                continue

        result.append(job)

    return result
