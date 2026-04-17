/**
 * agent/score.mjs
 * AI job scoring + tailored resume generation via Gemini.
 *
 * career-ops integration:
 * - Reads cv.md from career-ops root (not resume/cv.md)
 * - Scoring rubric aligned with career-ops A-F dimensions
 * - Returns tailoredResume for digest + story seeds for story-bank.md
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CV_PATH   = path.join(__dirname, '../cv.md');  // career-ops canonical CV

export const PASS_THRESHOLD = 4.0;

function isGeminiQuotaError(err) {
  return err?.status === 429 || err?.message?.toLowerCase?.().includes('quota exceeded');
}

function scoreToGrade(score) {
  if (score >= 4.5) return 'A+';
  if (score >= 4.0) return 'A';
  if (score >= 3.5) return 'B+';
  if (score >= 3.0) return 'B';
  if (score >= 2.5) return 'C';
  return 'F';
}

async function callGeminiWithRetry(model, prompt, maxRetries = 4) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      const isRateLimit = err?.status === 429 || /quota|rate/i.test(err?.message || '');
      if (isRateLimit && attempt < maxRetries) {
        console.warn(`[score] Rate limit — retrying in ${delay / 1000}s (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else throw err;
    }
  }
}

let _model = null;
function getModel() {
  if (!_model) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY env var is not set');
    const genAI = new GoogleGenerativeAI(apiKey);
    _model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
  }
  return _model;
}

function heuristicScore(job) {
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  const text = `${title} ${description}`;
  let score = 2.8;
  if (/(data|analytics|governance|science|machine learning|ai|bi)\b/.test(title)) score += 0.8;
  if (/(lead|senior analyst|data scientist|bi lead|analytics lead|data engineer)\b/.test(title)) score += 0.3;
  if (/(python|sql|analytics|governance|dashboard|etl|warehouse|snowflake|bigquery|dbt|collibra)\b/.test(text)) score += 0.5;
  if (/(remote|hybrid|india|bengaluru|bangalore|hyderabad|pune|mumbai|gurgaon|gurugram|delhi|noida|chennai)\b/.test(text)) score += 0.3;
  if (/(intern|fresher|entry level|0-2 years)\b/.test(text)) score -= 1.0;
  if (/(8.{0,4}year|10.{0,4}year|12.{0,4}year|senior manager|director|vp |vice president|head of|principal)\b/.test(text)) score -= 1.2;
  score = Math.max(1.0, Math.min(5.0, Math.round(score * 10) / 10));
  return {
    score,
    grade: scoreToGrade(score),
    summary: 'Heuristic score — Gemini quota exhausted. Review manually.',
    highlights: ['Role keywords overlap with target profile.'],
    gaps: ['AI scoring unavailable — Gemini quota exhausted.'],
    dimensions: { heuristic: true },
    tailoredResume: null,
  };
}

/**
 * Score a job and generate tailored resume content.
 * career-ops alignment: scoring rubric mirrors A-F dimensions.
 */
export async function scoreJob(job) {
  const { title, company, description } = job;
  if (!description) {
    console.warn(`[score] No description for ${title} @ ${company} — skipping`);
    return null;
  }

  const cv = existsSync(CV_PATH)
    ? readFileSync(CV_PATH, 'utf8')
    : 'Experienced data professional, India-based.';

  const prompt = `
You are an expert career coach evaluating job fit AND tailoring a resume for a specific role.

## Candidate Resume
${cv.slice(0, 3500)}

## Job Posting
**Title:** ${title}
**Company:** ${company}
**Description:**
${description.slice(0, 3000)}

## Task
Return ONLY valid JSON, no markdown fences:
{
  "dimensions": {
    "title_match": 4,
    "seniority_fit": 4,
    "location_fit": 5,
    "skills_overlap": 4,
    "domain_match": 5,
    "salary_signals": 3,
    "remote_hybrid": 4,
    "company_tier": 4,
    "growth_signals": 4,
    "red_flags": 5
  },
  "score": 4.2,
  "highlights": ["2–3 specific strengths with evidence from resume"],
  "gaps": ["1–2 specific gaps with evidence"],
  "summary": "Exactly 2 sentences on overall fit.",
  "tailoredResume": {
    "summaryStatement": "3-sentence tailored summary for this role",
    "topBullets": [
      "Bullet from candidate's actual experience, made specific to this role",
      "Bullet 2...",
      "Bullet 3...",
      "Bullet 4..."
    ],
    "skillsToLead": ["Skill1", "Skill2", "Skill3", "Skill4", "Skill5", "Skill6"],
    "coverSnippet": "2-sentence cover letter opening."
  }
}

Scoring dimensions (each 1–5):
1. title_match    — Job title vs candidate target roles
2. seniority_fit  — CRITICAL: Candidate has 4 yrs. Score 5 if 3-5 yrs required. Score 1-2 if 6+ yrs or Director/VP/Principal.
3. location_fit   — India/remote preference
4. skills_overlap — Tech stack: BigQuery, dbt, Collibra, AWS (S3/Lambda/Glue/Redshift), Tableau, Power BI, Python, SQL
5. domain_match   — Finance/Private Markets/AI governance/Cybersecurity/Analytics
6. salary_signals — Comp competitiveness (India, 26-35 LPA target)
7. remote_hybrid  — Work arrangement (remote preferred)
8. company_tier   — Company reputation/stage
9. growth_signals — Career growth potential toward senior data/governance roles
10. red_flags     — Absence of red flags (5 = clean)

Rules:
- score = weighted avg: title_match×1.5, skills_overlap×1.5, seniority_fit×2.0, others×1. Range 1.0–5.0
- Low seniority_fit (1–2) MUST pull total below 4.0
- topBullets MUST reference real achievements from the resume — no fabrication
`.trim();

  try {
    const model = getModel();
    const raw = await callGeminiWithRetry(model, prompt);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    let score = parseFloat(parsed.score);
    if (isNaN(score)) score = 2.5;
    score = Math.max(1.0, Math.min(5.0, Math.round(score * 10) / 10));

    return {
      score,
      grade: scoreToGrade(score),
      summary: parsed.summary || '',
      highlights: parsed.highlights || [],
      gaps: parsed.gaps || [],
      dimensions: parsed.dimensions || {},
      tailoredResume: parsed.tailoredResume || null,
    };
  } catch (err) {
    if (isGeminiQuotaError(err)) {
      console.warn(`[score] Quota exhausted for "${title}" @ ${company} — heuristic fallback`);
      return heuristicScore({ title, description });
    }
    console.warn(`[score] Scoring failed for "${title}" @ ${company}: ${err.message}`);
    return null;
  }
}

export async function scoreBatch(jobs) {
  const results = [];
  for (const job of jobs) {
    const scoreResult = await scoreJob(job);
    results.push({ ...job, scoreResult });
    await new Promise((r) => setTimeout(r, 1500));
  }
  return results;
}
