import logging

from notify import send_email
from pipeline import load_config, refresh_jobs


def run():
    config = load_config()

    logging.info("Refreshing ranked job snapshot")
    snapshot = refresh_jobs(config=config, exclude_history=True, persist_history=True)
    jobs = snapshot["jobs"]
    logging.info("Ranked %s unseen jobs for email delivery", len(jobs))

    top_jobs = jobs[: int(config.get("top_n", 20))]
    send_email(top_jobs, config)

    logging.info("Sent notification with %s jobs", len(top_jobs))
    return top_jobs


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    run()
