/**
 * agent/brain.mjs
 * Decision engine — reads data/goal.md + data/memory.json, calls Gemini,
 * and outputs a structured search plan for the current run.
 *
 * career-ops integration: goal.md is auto-generated from config/profile.yml
 * by goal-sync.mjs before this runs.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');
const GOAL_PATH = path.join(ROOT, 'data/goal.md');
const CV_PATH   = path.join(ROOT, 'cv.md');  // career-ops canonical CV

function isGeminiQuotaError(err) {
  return err?.status === 429 || err?.message?.toLowerCase?.().includes('quota exceeded');
}

function buildFallbackPlan(memory, goal, rationale) {
  const targetMatch = goal.match(/\b(\d+)\b/);
  const targetCount = targetMatch ? Number(targetMatch[1]) : 5;
  return {
    queries: [
      'Data Governance Analyst 3-5 years India',
      'Senior Data Analyst Data Governance India',
      'Data Platform Engineer 4 years India remote',
      'Analytics Engineer dbt BigQuery India',
      'Data Governance Lead India remote',
      'Senior Business Analyst Data Analytics India',
    ],
    boards: ['linkedin', 'naukri', 'iimjobs', 'foundit', 'indeed', 'timesjobs', 'google_jobs'],
    targetCount,
    avoidCompanies: memory.skippedCompanies || [],
    rationale,
  };
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
        console.warn(`[brain] Gemini rate limit — retrying in ${delay / 1000}s (${attempt}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      } else throw err;
    }
  }
}

/**
 * @param {object} memory  - loaded memory.json
 * @param {object} [opts]
 * @param {string} [opts.previousResults]
 * @returns {Promise<SearchPlan>}
 */
export async function buildSearchPlan(memory, opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var is not set');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });

  const goal = existsSync(GOAL_PATH)
    ? readFileSync(GOAL_PATH, 'utf8')
    : 'Find senior data roles in India.';

  const cvSnippet = existsSync(CV_PATH)
    ? readFileSync(CV_PATH, 'utf8').slice(0, 2000)
    : 'Experienced data professional, 4 years, India-based.';

  const today = new Date().toISOString().slice(0, 10);

  const memoryContext = `
- Jobs already seen: ${memory.seenJobs.length} job IDs
- Companies to avoid: ${[...memory.skippedCompanies, ...(opts.avoidExtra || [])].join(', ') || 'none'}
- Strong fit signals: ${memory.preferenceSignals.strongFit.join(', ') || 'none yet'}
- Weak fit signals: ${memory.preferenceSignals.weakFit.join(', ') || 'none yet'}
- Previous runs: ${memory.totalJobsScored} total scored, ${memory.totalHighFit} high-fit found
`.trim();

  const rePlanNote = opts.previousResults
    ? `\nFirst-pass result: ${opts.previousResults}. Goal not yet met — expand or diversify.\n`
    : '';

  const prompt = `
You are a job search strategist. Today is ${today}.

## Candidate Goal
${goal}

## Candidate Resume (excerpt)
${cvSnippet}

## Agent Memory
${memoryContext}
${rePlanNote}

## Task
Generate a JSON search plan. Return ONLY valid JSON, no markdown fences.

Required shape:
{
  "queries": ["query 1", "query 2", ...],
  "boards": ["linkedin", "naukri", "indeed", "google_jobs"],
  "targetCount": 5,
  "avoidCompanies": [],
  "rationale": "one sentence"
}

Rules:
- CRITICAL: candidate has 4 years experience — queries MUST target 3–5 year roles
- DO NOT generate queries for "Senior Manager", "Director", "VP", "Head of", "Principal"
- Good titles: Data Analyst, Senior Data Analyst, Data Scientist, Analytics Lead, Data Governance Analyst/Lead, BI Lead, Analytics Engineer, Data Platform Engineer
- Include 1–2 broader fallback queries
- boards: only ["linkedin","naukri","iimjobs","foundit","indeed","timesjobs","google_jobs"]
- avoidCompanies = skippedCompanies from memory
`.trim();

  console.log('[brain] Calling Gemini to build search plan...');
  let raw;
  try {
    raw = await callGeminiWithRetry(model, prompt);
  } catch (err) {
    if (isGeminiQuotaError(err)) {
      const plan = buildFallbackPlan(memory, goal, 'Fallback — Gemini quota exhausted');
      console.warn('[brain] Quota exhausted. Using fallback plan.');
      return plan;
    }
    throw err;
  }

  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch {
    console.error('[brain] Failed to parse Gemini JSON:\n', raw);
    plan = buildFallbackPlan(memory, goal, 'Fallback — Gemini parse error');
  }

  console.log('[brain] Search plan:', JSON.stringify(plan, null, 2));
  return plan;
}
