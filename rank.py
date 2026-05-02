import re


def _matches_keyword(text, keyword):
    pattern = r"\b" + re.escape(keyword.lower()).replace(r"\ ", r"\s+") + r"\b"
    return re.search(pattern, text) is not None


def _job_text(job):
    return " ".join(
        [
            job.get("title", ""),
            job.get("description", ""),
            job.get("location", ""),
            " ".join(job.get("tags", [])),
        ]
    ).lower()


def score_job(job, config):
    text = _job_text(job)
    weights = config.get("weights", {})

    score = 0
    matched_keywords = []
    for keyword, weight in weights.items():
        if _matches_keyword(text, keyword):
            score += int(weight)
            matched_keywords.append(keyword)

    if job.get("is_remote", False):
        score += int(config.get("remote_bonus", 0))

    return score, matched_keywords


def rank_jobs(jobs, config):
    min_score = int(config.get("min_score", 0))
    ranked_jobs = []

    for job in jobs:
        enriched_job = dict(job)
        enriched_job["score"], enriched_job["matched_keywords"] = score_job(enriched_job, config)
        if enriched_job["score"] >= min_score:
            ranked_jobs.append(enriched_job)

    return sorted(
        ranked_jobs,
        key=lambda job: (job["score"], job.get("published_at", ""), job.get("title", "")),
        reverse=True,
    )
