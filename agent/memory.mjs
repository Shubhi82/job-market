/**
 * agent/memory.mjs
 * Persistent agent memory — reads/writes data/memory.json
 * Memory persists between GitHub Actions runs because we commit the file back.
 *
 * career-ops integration: also syncs seen jobs to data/scan-history.tsv
 * so career-ops's dedup system stays in sync with the agent.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const ROOT          = path.join(__dirname, '..');
const MEMORY_PATH   = path.join(ROOT, 'data/memory.json');
const TRACKER_PATH  = path.join(ROOT, 'data/tracker.tsv');
const SCAN_HIST     = path.join(ROOT, 'data/scan-history.tsv');  // career-ops dedup

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a stable job ID from URL (or title+company fallback) */
export function makeJobId(url, title = '', company = '') {
  const raw = url || `${company}::${title}`;
  return createHash('md5').update(raw).digest('hex').slice(0, 12);
}

// ── Memory read/write ─────────────────────────────────────────────────────────

export function loadMemory() {
  if (!existsSync(MEMORY_PATH)) return freshMemory();
  try {
    return JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
  } catch {
    console.warn('[memory] Could not parse memory.json — starting fresh');
    return freshMemory();
  }
}

export function saveMemory(mem) {
  writeFileSync(MEMORY_PATH, JSON.stringify(mem, null, 2), 'utf8');
}

function freshMemory() {
  return {
    seenJobs: [],
    appliedJobs: [],
    skippedJobs: [],
    skippedCompanies: [],
    preferenceSignals: { strongFit: [], weakFit: [] },
    lastRun: null,
    totalJobsDiscovered: 0,
    totalJobsScored: 0,
    totalHighFit: 0,
  };
}

// ── Predicate helpers ─────────────────────────────────────────────────────────

export function isAlreadySeen(mem, jobId) {
  return mem.seenJobs.includes(jobId);
}

export function isSkippedCompany(mem, companyName) {
  return mem.skippedCompanies.some(
    (c) => c.toLowerCase() === companyName.toLowerCase()
  );
}

// ── Mutation helpers ──────────────────────────────────────────────────────────

export function markSeen(mem, jobId) {
  if (!mem.seenJobs.includes(jobId)) mem.seenJobs.push(jobId);
}

export function markApplied(mem, jobId) {
  markSeen(mem, jobId);
  if (!mem.appliedJobs.includes(jobId)) mem.appliedJobs.push(jobId);
}

export function markSkipped(mem, jobId) {
  markSeen(mem, jobId);
  if (!mem.skippedJobs.includes(jobId)) mem.skippedJobs.push(jobId);
}

export function addStrongFitSignal(mem, signal) {
  if (!mem.preferenceSignals.strongFit.includes(signal)) {
    mem.preferenceSignals.strongFit.push(signal);
  }
}

export function addWeakFitSignal(mem, signal) {
  if (!mem.preferenceSignals.weakFit.includes(signal)) {
    mem.preferenceSignals.weakFit.push(signal);
  }
}

// ── Tracker (tracker.tsv) ─────────────────────────────────────────────────────

export function appendToTracker(job) {
  const {
    jobId, company, title, url, score, grade,
    dateSeen = new Date().toISOString().slice(0, 10),
    applied = 'no',
  } = job;

  const row = [jobId, company, title, url, score, grade, dateSeen, applied].join('\t');
  const existing = existsSync(TRACKER_PATH)
    ? readFileSync(TRACKER_PATH, 'utf8')
    : 'job_id\tcompany\ttitle\turl\tscore\tgrade\tdate_seen\tapplied\n';

  if (existing.includes(jobId)) return;

  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  writeFileSync(TRACKER_PATH, existing + (needsNewline ? '\n' : '') + row + '\n', 'utf8');

  // Also write to career-ops scan-history.tsv for cross-system dedup
  appendToScanHistory({ company, title, url, score, dateSeen });
}

export function markAppliedInTracker(jobId) {
  if (!existsSync(TRACKER_PATH)) return;
  const lines = readFileSync(TRACKER_PATH, 'utf8').split('\n');
  const updated = lines.map((line) => {
    const cols = line.split('\t');
    if (cols[0] === jobId) { cols[7] = 'yes'; return cols.join('\t'); }
    return line;
  });
  writeFileSync(TRACKER_PATH, updated.join('\n'), 'utf8');
}

export function getTrackerJobIds() {
  if (!existsSync(TRACKER_PATH)) return new Set();
  const lines = readFileSync(TRACKER_PATH, 'utf8').split('\n').slice(1);
  return new Set(lines.map((l) => l.split('\t')[0]).filter(Boolean));
}

// ── career-ops scan-history.tsv sync ─────────────────────────────────────────
// Format: date\tcompany\ttitle\turl\tscore\tsource

function appendToScanHistory({ company, title, url, score, dateSeen }) {
  const header = 'date\tcompany\ttitle\turl\tscore\tsource\n';
  const existing = existsSync(SCAN_HIST)
    ? readFileSync(SCAN_HIST, 'utf8')
    : header;

  // Dedup by URL
  if (existing.includes(url)) return;

  const row = [dateSeen, company, title, url, score, 'agent'].join('\t');
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const content = existing.startsWith('date\t') ? existing : header + existing;
  writeFileSync(SCAN_HIST, content + (needsNewline ? '\n' : '') + row + '\n', 'utf8');
}
