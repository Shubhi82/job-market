import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape


def format_jobs_text(jobs):
    if not jobs:
        return "No new matching jobs were found today."

    sections = []
    for index, job in enumerate(jobs, start=1):
        section = [
            f"{index}. {job['title']} at {job['company']}",
            f"Score: {job.get('score', 0)}",
            f"Source: {job.get('source', 'unknown')}",
            f"Location: {job.get('location') or 'Not specified'}",
            f"Matched keywords: {', '.join(job.get('matched_keywords', [])) or 'None'}",
            job["url"],
        ]
        sections.append("\n".join(section))

    return "\n\n".join(sections)


def format_jobs_html(jobs):
    if not jobs:
        return "<p>No new matching jobs were found today.</p>"

    parts = ["<h2>Daily Job Matches</h2>", "<ol>"]
    for job in jobs:
        parts.append(
            "".join(
                [
                    "<li>",
                    f"<strong>{escape(job['title'])}</strong> at {escape(job['company'])}<br>",
                    f"Score: {job.get('score', 0)}<br>",
                    f"Source: {escape(job.get('source', 'unknown'))}<br>",
                    f"Location: {escape(job.get('location') or 'Not specified')}<br>",
                    f"Matched keywords: {escape(', '.join(job.get('matched_keywords', [])) or 'None')}<br>",
                    f"<a href=\"{escape(job['url'])}\">{escape(job['url'])}</a>",
                    "</li>",
                ]
            )
        )
    parts.append("</ol>")
    return "".join(parts)


def send_email(jobs, config):
    subject = config.get("email_subject", "Daily Job Matches")
    sender = os.environ.get("EMAIL")
    recipient = os.environ.get("EMAIL_TO", sender)
    password = os.environ.get("PASSWORD")
    dry_run = os.environ.get("DRY_RUN_EMAIL", "").lower() in {"1", "true", "yes"}

    text_body = format_jobs_text(jobs)
    html_body = format_jobs_html(jobs)

    if dry_run:
        print(f"[DRY RUN] Subject: {subject}")
        print(text_body)
        return

    if not sender or not recipient or not password:
        raise RuntimeError("EMAIL, PASSWORD, and optionally EMAIL_TO must be set to send mail")

    message = MIMEMultipart("alternative")
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.attach(MIMEText(text_body, "plain", "utf-8"))
    message.attach(MIMEText(html_body, "html", "utf-8"))

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(sender, password)
        server.send_message(message)
