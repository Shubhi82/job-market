/**
 * agent/loop.mjs
 * Main agent orchestrator — runs the full agentic job search loop.
 *
 * career-ops integration:
 * 1. Calls goal-sync.mjs to regenerate data/goal.md from config/profile.yml
 * 2. After scoring, calls pipeline-bridge.mjs to add high-fit jobs to data/pipeline.md
 * 3. Enriched STAR stories are written to interview-prep/story-bank.md
 * 4. Tracker entries sync to data/scan-history.tsv
 *
 * Flow:
 * 1. Sync goal from profile.yml
 * 2. Read goal.md + memory.json
 * 3. Brain → search plan
 * 4. Discover (job boards) + portals
 * 5. For each job: check memory → scrape → score
 * 6. Re-plan if goal not met (max 2 passes)
 * 7. Enrich high-fit jobs (STAR stories + company research)
 * 8. Add high-fit jobs to career-ops pipeline.md
 * 9. Update memory.json + tracker.tsv + scan-history.tsv + stories.json
 * 10. Export results for send-digest.mjs
 */

import { fileURLToPath } from 'url';
import path from 'path';
import { writeFileSync } from 'fs';

import { syncGoal }                           from './goal-sync.mjs';
import { buildSearchPlan }                    from './brain.mjs';
import { discoverJobs }                       from './discover.mjs';
import { scanPortals }                        from './portals.mjs';
import { scrapeJobDescription, closeBrowser } from './scrape.mjs';
import { scoreJob, PASS_THRESHOLD }           from './score.mjs';
import { enrichJob, loadStories, saveStories, addStory } from './enrich.mjs';
import { addToPipeline }                      from './pipeline-bridge.mjs';
import {
  loadMemory, saveMemory, makeJobId,
  isAlreadySeen, markSeen, appendToTracker, getTrackerJobIds,
} from './memory.mjs';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH  = path.join(__dirname, '../data/results.json');

const MAX_PASSES      = 2;
const DRY_RUN         = process.env.DRY_RUN === 'true';
const REMOTE_LIMIT    = 5;
const LOCATION_LIMIT  = 5;

const REMOTE_LOCS   = ['remote', 'wfh', 'work from home'];
const PRIMARY_LOCS  = ['hyderabad', 'pune', 'noida', 'gurugram', 'gurgaon', 'remote', 'work from home', 'wfh'];

function isRemoteJob(job) {
  const loc = (job.location || '').toLowerCase();
  return REMOTE_LOCS.some(r => loc.includes(r));
}

function locationTier(job) {
  const loc = (job.location || '').toLowerCase();
  return PRIMARY_LOCS.some(l => loc.includes(l)) ? 0 : 1;
}

const stats = {
  discovered: 0, fromPortals: 0, scraped: 0, scored: 0,
  highFit: 0, scrapeFailures: 0, scoreFailures: 0, enriched: 0,
  addedToPipeline: 0,
};

async function processJob(job, memory) {
  const jobId = job.jobId || makeJobId(job.url, job.title, job.company);
  if (isAlreadySeen(memory, jobId)) return null;

  const scraped = await scrapeJobDescription(job);
  stats.scraped++;

  if (!scraped) {
    stats.scrapeFailures++;
    markSeen(memory, jobId);
    return null;
  }

  const { description, applyUrl } = scraped;
  const scoreResult = await scoreJob({ ...job, description });
  stats.scored++;

  if (!scoreResult) {
    stats.scoreFailures++;
    markSeen(memory, jobId);
    return null;
  }

  const { score, grade, summary, highlights, gaps } = scoreResult;

  markSeen(memory, jobId);
  appendToTracker({
    jobId,
    company: job.company || 'Unknown',
    title: job.title || 'Unknown',
    url: job.url || '',
    score,
    grade,
    dateSeen: new Date().toISOString().slice(0, 10),
    applied: 'no',
  });

  if (score >= PASS_THRESHOLD) {
    stats.highFit++;
    const resolvedApplyUrl = applyUrl || job.url;
    return { ...job, jobId, score, grade, summary, highlights, gaps, description, applyUrl: resolvedApplyUrl };
  }
  return null;
}

async function runLoop() {
  console.log('\n========================================');
  console.log('  career-ops Agent — Job Search Loop');
  console.log(`  ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('  *** DRY RUN — email skipped ***');
  console.log('========================================\n');

  // ── Step 1: Sync goal from career-ops profile ────────────────────────────
  console.log('[loop] Syncing goal from config/profile.yml...');
  syncGoal();

  const memory = loadMemory();
  const seenIds = new Set([...memory.seenJobs, ...getTrackerJobIds()]);
  const highFitJobs = [];
  let targetCount = 5;
  let planQueries = [];

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    console.log(`\n--- Pass ${pass}/${MAX_PASSES} ---`);

    const previousResults = pass > 1
      ? `Found ${highFitJobs.length}/${targetCount} qualifying jobs after pass 1`
      : null;

    let plan;
    try {
      plan = await buildSearchPlan(memory, { previousResults });
      targetCount = plan.targetCount || 5;
      planQueries = plan.queries || [];
    } catch (err) {
      console.error('[loop] brain.mjs failed:', err.message);
      process.exit(1);
    }

    let discovered = [];
    try {
      discovered = await discoverJobs(plan, seenIds);
    } catch (err) {
      console.error('[loop] discover.mjs failed:', err.message);
    }

    if (pass === 1) {
      try {
        console.log('\n[loop] Scanning company portals...');
        const portalJobs = await scanPortals(planQueries, seenIds);
        stats.fromPortals += portalJobs.length;
        discovered = [...portalJobs, ...discovered];
      } catch (err) {
        console.warn('[loop] Portal scan failed (non-fatal):', err.message);
      }
    }

    stats.discovered += discovered.length;
    console.log(`\n[loop] Processing ${discovered.length} new jobs...`);

    for (const job of discovered) {
      try {
        const result = await processJob(job, memory);
        if (result) {
          highFitJobs.push(result);
          console.log(`  ✓ HIGH FIT [${result.grade} ${result.score}] ${result.title} @ ${result.company}`);
        }
      } catch (err) {
        console.warn(`[loop] Error processing "${job.title}": ${err.message}`);
        markSeen(memory, job.jobId || makeJobId(job.url, job.title, job.company));
      }
      seenIds.add(job.jobId || makeJobId(job.url, job.title, job.company));
    }

    if (highFitJobs.length >= targetCount) {
      console.log(`\n[loop] Goal met: ${highFitJobs.length}/${targetCount} high-fit jobs.`);
      break;
    }

    if (pass < MAX_PASSES) {
      console.log(`\n[loop] Not met (${highFitJobs.length}/${targetCount}). Re-planning...`);
    }
  }

  // ── Finalize memory ────────────────────────────────────────────────────────
  memory.lastRun = new Date().toISOString().slice(0, 10);
  memory.totalJobsDiscovered += stats.discovered;
  memory.totalJobsScored += stats.scored;
  memory.totalHighFit += stats.highFit;
  saveMemory(memory);

  // ── Sort + cap results: 5 remote + 5 Pune/Noida ───────────────────────────
  const remoteSection   = highFitJobs.filter(isRemoteJob)
    .sort((a, b) => b.score - a.score)
    .slice(0, REMOTE_LIMIT);

  const locationSection = highFitJobs.filter(j => !isRemoteJob(j))
    .sort((a, b) => locationTier(a) - locationTier(b) || b.score - a.score)
    .slice(0, LOCATION_LIMIT);

  const rankedJobs = [...remoteSection, ...locationSection];

  console.log(`\n[loop] ${remoteSection.length} remote + ${locationSection.length} Pune/Noida/Hyd jobs:`);
  remoteSection.forEach((j, i) =>
    console.log(`  R${i + 1}. [remote] ${j.grade} ${j.score} — ${j.title} @ ${j.company}`));
  locationSection.forEach((j, i) =>
    console.log(`  L${i + 1}. [${j.location || 'unknown'}] ${j.grade} ${j.score} — ${j.title} @ ${j.company}`));

  // ── Add high-fit jobs to career-ops pipeline.md ────────────────────────────
  if (!DRY_RUN) {
    console.log('\n[loop] Adding high-fit jobs to career-ops pipeline.md...');
    stats.addedToPipeline = addToPipeline(rankedJobs);
    console.log(`[loop] ${stats.addedToPipeline} job(s) queued for deep /career-ops evaluation`);
  } else {
    console.log('[loop] DRY RUN — skipping pipeline.md update');
  }

  // ── Enrich high-fit jobs ──────────────────────────────────────────────────
  console.log('\n[loop] Enriching high-fit jobs with research + STAR stories...');
  const storyBank = loadStories();
  const today = new Date().toISOString().slice(0, 10);

  for (const job of rankedJobs) {
    try {
      console.log(`  Enriching: ${job.title} @ ${job.company}...`);
      const enrichment = await enrichJob(job);
      if (enrichment) {
        job.enrichment = enrichment;
        stats.enriched++;
        for (const story of (enrichment.starStories || [])) {
          addStory(storyBank, { ...story, roleAppliedTo: job.title, appliedAtCompany: job.company, dateAdded: today });
        }
        console.log(`    ✓ research + ${enrichment.starStories?.length || 0} stories (also saved to story-bank.md)`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.warn(`  ✗ Enrichment failed for ${job.title}: ${err.message}`);
    }
  }

  saveStories(storyBank);
  console.log(`[loop] Story bank: ${storyBank.stories.length} total stories`);

  // ── Print summary ──────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  Run Summary');
  console.log('========================================');
  console.log(`  Discovered   : ${stats.discovered} (${stats.fromPortals} from portals)`);
  console.log(`  Scraped      : ${stats.scraped}`);
  console.log(`  Scored       : ${stats.scored}`);
  console.log(`  High-fit ≥4.0: ${stats.highFit}`);
  console.log(`  → Pipeline   : ${stats.addedToPipeline} queued for /career-ops evaluate`);
  console.log(`  → Enriched   : ${stats.enriched}`);
  console.log(`  Failures     : ${stats.scrapeFailures} scrape, ${stats.scoreFailures} score`);
  console.log('========================================\n');

  // ── Write results for send-digest.mjs ─────────────────────────────────────
  const strip = ({ description, ...rest }) => rest;
  const output = {
    date: today,
    stats,
    jobs: rankedJobs.map(strip),
    remoteJobs: remoteSection.map(strip),
    locationJobs: locationSection.map(strip),
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[loop] Results written to data/results.json`);
  if (stats.addedToPipeline > 0) {
    console.log(`[loop] Run /career-ops pipeline to do deep A-G evaluations on ${stats.addedToPipeline} queued job(s)`);
  }

  return output;
}

runLoop()
  .catch((err) => { console.error('[loop] Fatal error:', err); process.exit(1); })
  .finally(async () => { await closeBrowser(); });
