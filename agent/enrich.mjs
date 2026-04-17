/**
 * agent/enrich.mjs
 * Enriches high-fit jobs with company research + STAR stories.
 *
 * career-ops integration:
 * - Reads cv.md from career-ops root
 * - Saves stories to data/stories.json (agent format)
 * - ALSO appends stories to interview-prep/story-bank.md (career-ops format)
 *   so /career-ops interview-prep can find them
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import path from 'path';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const ROOT           = path.join(__dirname, '..');
const CV_PATH        = path.join(ROOT, 'cv.md');               // career-ops canonical CV
const STORIES_PATH   = path.join(ROOT, 'data/stories.json');   // agent JSON store
const STORY_BANK_MD  = path.join(ROOT, 'interview-prep/story-bank.md');  // career-ops markdown

// ── Story bank — JSON (agent format) ─────────────────────────────────────────

export function loadStories() {
  if (!existsSync(STORIES_PATH)) return { stories: [] };
  try { return JSON.parse(readFileSync(STORIES_PATH, 'utf8')); }
  catch { return { stories: [] }; }
}

export function saveStories(bank) {
  writeFileSync(STORIES_PATH, JSON.stringify(bank, null, 2), 'utf8');
}

export function addStory(bank, story) {
  const id = createHash('md5')
    .update(`${story.project || ''}::${story.skill || ''}`)
    .digest('hex')
    .slice(0, 10);
  const existing = bank.stories.find((s) => s.id === id);
  if (existing) {
    existing.useCount = (existing.useCount || 0) + 1;
    existing.lastUsed = story.dateAdded;
  } else {
    bank.stories.push({ id, useCount: 1, lastUsed: story.dateAdded, ...story });
  }
}

// ── Story bank — Markdown (career-ops format) ─────────────────────────────────

function appendStoryToMarkdown(story, roleName, companyName, date) {
  try {
    // Ensure interview-prep/ exists
    const dir = path.dirname(STORY_BANK_MD);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const existing = existsSync(STORY_BANK_MD)
      ? readFileSync(STORY_BANK_MD, 'utf8')
      : '# Story Bank\n\nReusable STAR+R stories accumulated across evaluations.\n\n';

    // Check if this exact story (by project+skill) already exists in markdown
    const dedupKey = `${story.project || ''}::${story.skill || ''}`;
    if (existing.includes(story.project || '') && existing.includes(story.skill || '')) return;

    const block = `
## ${story.project || 'Project'} · ${story.skill || 'Skill'}
*Added: ${date} | Role: ${roleName} @ ${companyName}*

**S (Situation):** ${story.situation || ''}

**T (Task):** ${story.task || ''}

**A (Action):** ${story.action || ''}

**R (Result):** ${story.result || ''}

**Reflection:** ${story.relevance || '— (add what you learned)'}

---
`.trimStart();

    writeFileSync(STORY_BANK_MD, existing + block, 'utf8');
  } catch (err) {
    console.warn(`[enrich] Failed to write to story-bank.md: ${err.message}`);
  }
}

// ── Gemini helpers ────────────────────────────────────────────────────────────

let _model = null;
function getModel() {
  if (!_model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    const genAI = new GoogleGenerativeAI(apiKey);
    _model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  }
  return _model;
}

async function callGeminiWithRetry(prompt, maxRetries = 4) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await getModel().generateContent(prompt);
      return result.response.text();
    } catch (err) {
      const isLimit = err?.status === 429 || /quota|rate/i.test(err?.message || '');
      if (isLimit && attempt < maxRetries) {
        console.warn(`[enrich] Rate limit — retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else throw err;
    }
  }
}

// ── Main enrichment ───────────────────────────────────────────────────────────

export async function enrichJob(job) {
  const { title, company, description = '' } = job;

  const cv = existsSync(CV_PATH)
    ? readFileSync(CV_PATH, 'utf8')
    : 'Experienced data professional, India-based.';

  const prompt = `
You are a career coach helping a candidate prepare for interviews.

## Candidate CV
${cv.slice(0, 3500)}

## Target Role
**Title:** ${title}
**Company:** ${company}
**Description:**
${description.slice(0, 2000)}

## Task
Return ONLY valid JSON, no markdown fences:
{
  "research": {
    "snapshot": "2-3 sentences about ${company}: what they do, size/stage, India presence",
    "whyApply": "1-2 sentences on why THIS candidate is a strong fit here (reference CV specifics)",
    "recentContext": "Any relevant news or context about ${company} the candidate should know"
  },
  "talkingPoints": [
    "Specific talking point 1 — tie candidate's actual experience to this role",
    "Specific talking point 2 — reference a real project from CV",
    "Specific talking point 3 — connect CV background to ${company}'s domain"
  ],
  "starStories": [
    {
      "project": "Name of project from CV (e.g. Unified Asset Master, Google RAI Platform)",
      "skill": "Primary skill demonstrated",
      "situation": "1-2 sentences: context and challenge",
      "task": "1 sentence: what the candidate was responsible for",
      "action": "2-3 sentences: specific actions (draw from CV details)",
      "result": "1-2 sentences: measurable outcomes",
      "relevance": "Why this story maps directly to ${title} at ${company}"
    }
  ]
}

Rules:
- starStories MUST reference actual projects from CV (Unified Asset Master at Macquarie, Google Core Privacy Pipeline, Google Photos RAI Platform, NYL AWS ETL, Phoenix DLP, MMM Streamlit)
- talkingPoints must be specific — reference actual experience
- Provide exactly 2 starStories, the 2 most relevant to this specific job
`.trim();

  try {
    const raw = await callGeminiWithRetry(prompt);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const result = {
      research: parsed.research || {},
      talkingPoints: parsed.talkingPoints || [],
      starStories: parsed.starStories || [],
    };

    // Write stories to career-ops story-bank.md
    const today = new Date().toISOString().slice(0, 10);
    for (const story of result.starStories) {
      appendStoryToMarkdown(story, title, company, today);
    }

    return result;
  } catch (err) {
    const isQuota = err?.status === 429 || /quota/i.test(err?.message || '');
    if (isQuota) console.warn(`[enrich] Quota exhausted for "${title}" @ ${company} — skipping`);
    else console.warn(`[enrich] Failed for "${title}" @ ${company}: ${err.message}`);
    return null;
  }
}
