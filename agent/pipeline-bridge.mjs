/**
 * agent/pipeline-bridge.mjs
 * Writes high-fit jobs discovered by the autonomous agent into career-ops's
 * data/pipeline.md so /career-ops pipeline can run full A-G evaluations on them.
 *
 * Format mirrors what career-ops expects:
 *   - {url}   ← career-ops reads this to fetch + evaluate
 *
 * Also writes a summary comment with agent pre-score so you know what to expect
 * before running the full evaluation.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.join(__dirname, '..');
const PIPELINE_PATH = path.join(ROOT, 'data/pipeline.md');

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadPipeline() {
  if (!existsSync(PIPELINE_PATH)) {
    return `# Pipeline — Pending Evaluations\n\nAdd job URLs here, one per line. Run \`/career-ops pipeline\` to process.\n\n`;
  }
  return readFileSync(PIPELINE_PATH, 'utf8');
}

/** Check if URL is already in pipeline (avoid duplicates) */
function isAlreadyQueued(content, url) {
  return content.includes(url);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Add high-fit jobs to data/pipeline.md for career-ops deep evaluation.
 *
 * @param {Array<{title, company, url, score, grade, summary, highlights, gaps}>} highFitJobs
 * @returns {number} count of new jobs added
 */
export function addToPipeline(highFitJobs) {
  if (!highFitJobs || highFitJobs.length === 0) return 0;

  let content = loadPipeline();
  const today = new Date().toISOString().slice(0, 10);
  let added = 0;

  const newLines = [];

  for (const job of highFitJobs) {
    const url = job.applyUrl || job.url;
    if (!url) continue;
    if (isAlreadyQueued(content, url)) {
      console.log(`[pipeline-bridge] Already queued: ${job.title} @ ${job.company}`);
      continue;
    }

    // Build a comment block so career-ops knows the agent pre-score
    const highlightStr = (job.highlights || []).slice(0, 2).map(h => `#   + ${h}`).join('\n');
    const gapStr = (job.gaps || []).slice(0, 1).map(g => `#   - ${g}`).join('\n');

    const comment = [
      `# [agent-${today}] ${job.grade} ${job.score}/5 — ${job.title} @ ${job.company} (${job.location || 'India'})`,
      job.summary ? `# ${job.summary}` : null,
      highlightStr || null,
      gapStr || null,
    ].filter(Boolean).join('\n');

    newLines.push(`${comment}\n- ${url}`);
    added++;
    console.log(`[pipeline-bridge] Queued: ${job.title} @ ${job.company} (${job.grade} ${job.score})`);
  }

  if (added > 0) {
    // Append to end of pipeline file
    const separator = content.trimEnd().endsWith('\n') ? '\n' : '\n\n';
    content = content.trimEnd() + separator + newLines.join('\n\n') + '\n';
    writeFileSync(PIPELINE_PATH, content, 'utf8');
    console.log(`[pipeline-bridge] ${added} job(s) added to data/pipeline.md`);
  }

  return added;
}
