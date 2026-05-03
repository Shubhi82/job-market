# Autonomous Job Agent

A daily job search agent that:

- Pulls jobs from multiple public sources
- Normalizes them into one schema
- Filters, deduplicates, and ranks matches
- Skips jobs already seen in prior runs
- Emails the top results automatically
- Runs on a schedule through GitHub Actions

## Project Layout

```text
.
├── agent.py
├── sources.py
├── filter.py
├── dedup.py
├── rank.py
├── notify.py
├── config.json
├── requirements.txt
├── data/
│   └── history.json
└── .github/workflows/agent.yml
```

## Sources

- Remotive
- RemoteOK
- Arbeitnow

## Configuration

Edit `config.json` to control:

- `keywords`: include terms
- `exclude_keywords`: reject terms
- `weights`: ranking weights
- `min_score`: minimum score to keep a job
- `top_n`: how many jobs to email
- `remote_only`: only keep remote jobs

## Local Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Local Dry Run

This prints the email body instead of sending it:

```bash
DRY_RUN_EMAIL=1 python3 agent.py
```

## Email Setup

The agent sends mail through Gmail SMTP. In GitHub repository secrets, add:

- `EMAIL`: your Gmail address
- `PASSWORD`: your Gmail App Password
- `EMAIL_TO`: optional alternate recipient

## GitHub Actions

The workflow is in `.github/workflows/agent.yml`.

- Scheduled time: `01:30 UTC`
- Equivalent local time in India: `07:00 Asia/Kolkata`
- Manual trigger: supported through `workflow_dispatch`

The workflow also commits `data/history.json` back to the repository so seen-job history survives across scheduled runs.

## Dashboard App

The repo also includes a Streamlit dashboard for live job review and application tracking:

```bash
streamlit run app.py
```

What it does:

- Refreshes and stores the latest relevant jobs
- Shows job link and apply link
- Scores each role against your profile with a match percentage
- Lets you track application status and notes
- Stores recruiter emails when you add them
- Drafts outreach emails for high-match roles

Important note:

- Public job feeds usually do not provide recruiter email addresses, so the app does not fabricate them. Add recruiter emails manually when you find them on LinkedIn or the company careers page, and the app will reuse them for future outreach drafts.

## First Run Checklist

1. Push this repository to GitHub.
2. Add the required repository secrets.
3. Enable GitHub Actions.
4. Run the workflow manually once.
5. Confirm the email arrives and adjust `config.json` if needed.

## Notes

- GitHub Actions cron uses UTC, not your local timezone.
- Public job APIs can change over time, so source behavior may occasionally need updates.
- If you want stronger ranking later, `rank.py` is the right place to add AI scoring.
