import hashlib
import html
import logging
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote_plus

import requests

DEFAULT_TIMEOUT_SECONDS = 20


def _source_enabled(config, source_name):
    sources = {name.lower() for name in config.get("sources", [])}
    return not sources or source_name.lower() in sources


def _fetch_json(url, timeout_seconds):
    response = requests.get(
        url,
        headers={"User-Agent": "job-agent/1.0"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    return response.json()


def _fetch_text(url, timeout_seconds):
    response = requests.get(
        url,
        headers={"User-Agent": "job-agent/1.0"},
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    return response.text


def _strip_html(text):
    if not text:
        return ""

    text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _build_job_id(source, raw_id, url):
    base = str(raw_id).strip() if raw_id is not None else url.strip()
    if not base:
        base = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return f"{source}:{base}"


def _split_title_and_company(title_text):
    text = str(title_text or "").strip()
    for separator in (" at ", " @ ", " - "):
        if separator in text:
            left, right = text.split(separator, 1)
            return left.strip(), right.strip()
    return text, ""


def _normalize_job(
    source,
    raw_id,
    title,
    company,
    url,
    apply_url="",
    description="",
    location="",
    tags=None,
    published_at="",
):
    clean_description = _strip_html(description)
    clean_tags = [str(tag).strip() for tag in (tags or []) if str(tag).strip()]
    clean_title = str(title or "").strip()
    clean_company = str(company or "").strip() or "Unknown"
    clean_url = str(url or "").strip()
    clean_apply_url = str(apply_url or clean_url).strip() or clean_url
    clean_location = str(location or "").strip()
    clean_published_at = str(published_at or "").strip()
    remote_text = " ".join([clean_title, clean_description, clean_location, " ".join(clean_tags)]).lower()

    return {
        "id": _build_job_id(source, raw_id, clean_url),
        "source": source,
        "title": clean_title,
        "company": clean_company,
        "url": clean_url,
        "apply_url": clean_apply_url,
        "description": clean_description,
        "location": clean_location,
        "tags": clean_tags,
        "published_at": clean_published_at,
        "is_remote": "remote" in remote_text,
    }


def get_remotive(timeout_seconds):
    payload = _fetch_json("https://remotive.com/api/remote-jobs", timeout_seconds)
    jobs = []

    for item in payload.get("jobs", []):
        jobs.append(
            _normalize_job(
                source="remotive",
                raw_id=item.get("id"),
                title=item.get("title"),
                company=item.get("company_name"),
                url=item.get("url"),
                apply_url=item.get("url"),
                description=item.get("description", ""),
                location=item.get("candidate_required_location", ""),
                tags=[item.get("category"), *(item.get("tags") or [])],
                published_at=item.get("publication_date", ""),
            )
        )

    return jobs


def get_remoteok(timeout_seconds):
    payload = _fetch_json("https://remoteok.com/api", timeout_seconds)
    jobs = []

    for item in payload:
        if "id" not in item or "position" not in item:
            continue

        jobs.append(
            _normalize_job(
                source="remoteok",
                raw_id=item.get("id"),
                title=item.get("position"),
                company=item.get("company"),
                url=item.get("url") or item.get("apply_url", ""),
                apply_url=item.get("apply_url") or item.get("url", ""),
                description=item.get("description", ""),
                location=item.get("location", ""),
                tags=item.get("tags") or [],
                published_at=item.get("date", ""),
            )
        )

    return jobs


def get_arbeitnow(timeout_seconds):
    payload = _fetch_json("https://www.arbeitnow.com/api/job-board-api", timeout_seconds)
    jobs = []

    for item in payload.get("data", []):
        url = item.get("url") or ""
        if not url and item.get("slug"):
            url = f"https://www.arbeitnow.com/jobs/{item['slug']}"

        tags = item.get("tags") or []
        if item.get("remote"):
            tags = [*tags, "remote"]

        jobs.append(
            _normalize_job(
                source="arbeitnow",
                raw_id=item.get("slug") or item.get("id") or url,
                title=item.get("title"),
                company=item.get("company_name"),
                url=url,
                apply_url=url,
                description=item.get("description", ""),
                location=item.get("location", ""),
                tags=tags,
                published_at=item.get("created_at", ""),
            )
        )

    return jobs


def get_himalayas(timeout_seconds, config):
    search_terms = config.get(
        "himalayas_search_terms",
        [
            "data governance",
            "master data",
            "data quality",
            "privacy",
            "risk",
            "analytics engineer",
        ],
    )
    max_terms = int(config.get("himalayas_max_terms", 4))

    jobs = []
    for search_term in search_terms[:max_terms]:
        url = f"https://himalayas.app/jobs/api/search?q={quote_plus(search_term)}&sort=recent&page=1"
        try:
            payload = _fetch_json(url, timeout_seconds)
        except requests.RequestException as exc:
            logging.warning("Himalayas query failed for '%s': %s", search_term, exc)
            continue

        for item in payload.get("jobs", []):
            location_bits = item.get("locationRestrictions") or item.get("location") or []
            if isinstance(location_bits, str):
                location_text = location_bits
            else:
                location_text = ", ".join(str(part).strip() for part in location_bits if str(part).strip())

            tags = item.get("skills") or item.get("categories") or []
            jobs.append(
                _normalize_job(
                    source="himalayas",
                    raw_id=item.get("id") or item.get("slug") or item.get("applicationLink"),
                    title=item.get("title"),
                    company=item.get("companyName") or item.get("company", {}).get("name"),
                    url=item.get("url")
                    or item.get("jobUrl")
                    or item.get("applicationLink")
                    or item.get("applyUrl", ""),
                    apply_url=item.get("applicationLink") or item.get("applyUrl") or item.get("url", ""),
                    description=item.get("shortDescription") or item.get("description", ""),
                    location=location_text,
                    tags=tags,
                    published_at=item.get("publishedAt") or item.get("createdAt", ""),
                )
            )

    return jobs


def get_weworkremotely(timeout_seconds):
    feed_xml = _fetch_text("https://weworkremotely.com/remote-jobs.rss", timeout_seconds)
    root = ET.fromstring(feed_xml)
    jobs = []

    for item in root.findall(".//item"):
        raw_title = item.findtext("title", default="")
        title, company = _split_title_and_company(raw_title)
        description = item.findtext("description", default="")
        link = item.findtext("link", default="")
        published_at = item.findtext("pubDate", default="")
        category_nodes = item.findall("category")
        tags = [node.text.strip() for node in category_nodes if node.text and node.text.strip()]

        jobs.append(
            _normalize_job(
                source="weworkremotely",
                raw_id=item.findtext("guid", default=link),
                title=title,
                company=company or "Unknown",
                url=link,
                apply_url=link,
                description=description,
                location="Remote",
                tags=tags,
                published_at=published_at,
            )
        )

    return jobs


def get_all_jobs(config):
    timeout_seconds = int(config.get("source_timeout_seconds", DEFAULT_TIMEOUT_SECONDS))
    all_jobs = []
    failures = []

    sources = [
        ("remotive", get_remotive),
        ("remoteok", get_remoteok),
        ("arbeitnow", get_arbeitnow),
        ("himalayas", lambda timeout: get_himalayas(timeout, config)),
        ("weworkremotely", get_weworkremotely),
    ]

    for source_name, loader in sources:
        if not _source_enabled(config, source_name):
            continue

        try:
            source_jobs = loader(timeout_seconds)
            logging.info("Loaded %s jobs from %s", len(source_jobs), source_name)
            all_jobs.extend(source_jobs)
        except Exception as exc:
            failures.append((source_name, str(exc)))
            logging.warning("Failed to load jobs from %s: %s", source_name, exc)

    if not all_jobs and failures:
        sources_list = ", ".join(name for name, _ in failures)
        raise RuntimeError(f"All sources failed: {sources_list}")

    return all_jobs
