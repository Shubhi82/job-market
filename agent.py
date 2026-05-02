import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dedup import remove_duplicates
from filter import filter_jobs
from notify import send_email
from rank import rank_jobs
from sources import get_all_jobs

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = Path(os.getenv("JOB_AGENT_CONFIG_FILE", BASE_DIR / "config.json"))
HISTORY_FILE = Path(os.getenv("JOB_HISTORY_FILE", BASE_DIR / "data/history.json"))


def load_config():
    with CONFIG_FILE.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_history():
    if not HISTORY_FILE.exists():
        return set()

    with HISTORY_FILE.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    if isinstance(payload, dict):
        return set(payload.get("seen_job_ids", []))

    if isinstance(payload, list):
        return set(payload)

    raise ValueError(f"Unsupported history format in {HISTORY_FILE}")


def save_history(jobs):
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    seen_ids = load_history()
    seen_ids.update(job["id"] for job in jobs)

    payload = {
        "seen_job_ids": sorted(seen_ids),
        "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    }

    with HISTORY_FILE.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


def run():
    config = load_config()

    logging.info("Fetching jobs from configured sources")
    jobs = get_all_jobs(config)
    logging.info("Fetched %s raw jobs", len(jobs))

    jobs = filter_jobs(jobs, config)
    logging.info("%s jobs matched keyword filters", len(jobs))

    jobs = remove_duplicates(jobs)
    logging.info("%s jobs remain after deduplication", len(jobs))

    history = load_history()
    jobs = [job for job in jobs if job["id"] not in history]
    logging.info("%s unseen jobs remain after history filter", len(jobs))

    jobs = rank_jobs(jobs, config)
    logging.info("%s jobs remain after score thresholding", len(jobs))

    top_jobs = jobs[: int(config.get("top_n", 20))]
    save_history(jobs)
    send_email(top_jobs, config)

    logging.info("Sent notification with %s jobs", len(top_jobs))
    return top_jobs


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    run()
