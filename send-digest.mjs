/**
 * send-digest.mjs
 * Email digest: top matched roles + deep-dive cards (research + STAR stories)
 *
 * career-ops integration:
 * - Reads data/results.json written by agent/loop.mjs
 * - Footer notes that high-fit jobs have been queued to data/pipeline.md
 *   for full /career-ops pipeline evaluation
 */

import { Resend } from 'resend';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.join(__dirname, 'data/results.json');
const DRY_RUN      = process.env.DRY_RUN === 'true';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PRIMARY_LOCS = ['hyderabad', 'pune', 'noida', 'gurugram', 'gurgaon', 'remote', 'wfh', 'work from home'];
function isPrimary(loc) {
  return PRIMARY_LOCS.some(l => (loc || '').toLowerCase().includes(l));
}

function jobRow(job, index) {
  const primary = isPrimary(job.location);
  const locBadge = primary
    ? `<span style="background:#dafbe1;color:#1a7f37;padding:1px 7px;border-radius:8px;font-size:11px;font-weight:600;">★ ${esc(job.location || 'Remote')}</span>`
    : `<span style="background:#f6f8fa;color:#57606a;padding:1px 7px;border-radius:8px;font-size:11px;">${esc(job.location || 'India')}</span>`;

  const sourceTag = job.source?.startsWith('portal_')
    ? `<span style="background:#fff8c5;color:#9a6700;padding:1px 6px;border-radius:6px;font-size:10px;font-weight:600;margin-left:6px;">direct</span>`
    : '';

  return `
<tr style="border-bottom:1px solid #eee;">
  <td style="padding:14px 12px;font-size:13px;color:#57606a;font-weight:600;white-space:nowrap;">#${index + 1}</td>
  <td style="padding:14px 12px;vertical-align:top;">
    <div style="font-size:15px;font-weight:700;color:#0969da;margin-bottom:2px;">
      <a href="${esc(job.url || '#')}" style="color:#0969da;text-decoration:none;" target="_blank">${esc(job.title)}</a>${sourceTag}
    </div>
    <div style="font-size:13px;color:#57606a;">${esc(job.company)}</div>
  </td>
  <td style="padding:14px 12px;vertical-align:middle;">${locBadge}</td>
  <td style="padding:14px 12px;vertical-align:middle;white-space:nowrap;">
    <span style="font-size:13px;font-weight:700;color:#1a7f37;">${job.score.toFixed(1)}/5</span>
  </td>
  <td style="padding:14px 12px;vertical-align:middle;">
    <a href="${esc(job.applyUrl || job.url || '#')}"
       style="background:#0969da;color:#fff;padding:6px 16px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;white-space:nowrap;"
       target="_blank">Apply →</a>
  </td>
</tr>`;
}

function deepDiveCard(job, index) {
  const { enrichment } = job;
  if (!enrichment) return '';
  const { research = {}, talkingPoints = [], starStories = [] } = enrichment;

  const tpHtml = talkingPoints.length
    ? `<ul style="margin:6px 0 0;padding-left:18px;">${talkingPoints.map(tp =>
        `<li style="font-size:13px;color:#24292f;margin-bottom:5px;line-height:1.5;">${esc(tp)}</li>`
      ).join('')}</ul>` : '';

  const storyHtml = starStories.slice(0, 2).map(s => `
    <div style="background:#f6f8fa;border-left:3px solid #0969da;border-radius:0 4px 4px 0;padding:10px 14px;margin-bottom:10px;">
      <div style="font-size:11px;font-weight:700;color:#0969da;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">
        ${esc(s.project || 'Story')} · ${esc(s.skill || '')}
      </div>
      <div style="font-size:12.5px;color:#24292f;line-height:1.55;margin-bottom:3px;"><strong>S:</strong> ${esc(s.situation)}</div>
      <div style="font-size:12.5px;color:#24292f;line-height:1.55;margin-bottom:3px;"><strong>T:</strong> ${esc(s.task)}</div>
      <div style="font-size:12.5px;color:#24292f;line-height:1.55;margin-bottom:3px;"><strong>A:</strong> ${esc(s.action)}</div>
      <div style="font-size:12.5px;color:#24292f;line-height:1.55;margin-bottom:6px;"><strong>R:</strong> ${esc(s.result)}</div>
      ${s.relevance ? `<div style="font-size:11px;color:#57606a;font-style:italic;">↳ ${esc(s.relevance)}</div>` : ''}
    </div>`).join('');

  return `
<div style="background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px 18px;margin-bottom:14px;">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;border-bottom:1px solid #eee;padding-bottom:10px;">
    <div>
      <span style="font-size:13px;font-weight:700;color:#24292f;">#${index + 1} </span>
      <a href="${esc(job.applyUrl || job.url || '#')}" style="font-size:14px;font-weight:700;color:#0969da;text-decoration:none;" target="_blank">${esc(job.title)}</a>
      <span style="font-size:13px;color:#57606a;"> · ${esc(job.company)}</span>
    </div>
    <span style="font-size:13px;font-weight:700;color:#1a7f37;white-space:nowrap;">${job.score.toFixed(1)}/5</span>
  </div>

  ${research.snapshot ? `
  <div style="font-size:11px;font-weight:700;color:#57606a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Company Snapshot</div>
  <p style="font-size:13px;color:#24292f;margin:0 0 10px;line-height:1.55;">${esc(research.snapshot)}</p>` : ''}

  ${research.whyApply ? `
  <div style="background:#dafbe1;border-radius:6px;padding:8px 12px;margin-bottom:12px;">
    <span style="font-size:11px;font-weight:700;color:#1a7f37;">Why You Fit: </span>
    <span style="font-size:13px;color:#24292f;">${esc(research.whyApply)}</span>
  </div>` : ''}

  ${tpHtml ? `
  <div style="font-size:11px;font-weight:700;color:#57606a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Key Talking Points</div>
  ${tpHtml}` : ''}

  ${storyHtml ? `
  <div style="font-size:11px;font-weight:700;color:#57606a;text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px;">Best STAR Stories for This Role</div>
  ${storyHtml}` : ''}

  ${research.recentContext && !research.recentContext.toLowerCase().includes('no specific') ? `
  <div style="font-size:11.5px;color:#57606a;margin-top:8px;padding-top:8px;border-top:1px solid #eee;">
    <strong>Context:</strong> ${esc(research.recentContext)}
  </div>` : ''}
</div>`;
}

function jobSection(title, icon, headerColor, jobs, globalOffset) {
  if (!jobs.length) return '';
  const rows = jobs.map((job, i) => jobRow(job, globalOffset + i)).join('');
  return `
  <div style="padding:20px 28px 0;">
    <div style="font-size:14px;font-weight:700;color:${headerColor};margin-bottom:10px;padding-bottom:6px;border-bottom:2px solid #d0d7de;">
      ${icon} ${esc(title)} (${jobs.length})
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f6f8fa;border-bottom:2px solid #d0d7de;">
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.5px;">#</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.5px;">Role</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.5px;">Location</th>
          <th style="padding:10px 12px;text-align:left;font-size:11px;color:#57606a;text-transform:uppercase;letter-spacing:.5px;">Score</th>
          <th style="padding:10px 12px;"></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildHtml(data) {
  const { date, stats = {} } = data;

  // Support new 2-bucket format or fall back to splitting flat jobs array
  const REMOTE_LOCS = ['remote', 'wfh', 'work from home'];
  const isRemote = (j) => REMOTE_LOCS.some(r => (j.location || '').toLowerCase().includes(r));
  const allJobs      = data.jobs || [];
  const remoteJobs   = data.remoteJobs   || allJobs.filter(isRemote).slice(0, 5);
  const locationJobs = data.locationJobs || allJobs.filter(j => !isRemote(j)).slice(0, 5);

  const displayDate = new Date(date + 'T00:00:00').toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const totalCount = remoteJobs.length + locationJobs.length;
  const pipelineNote = stats.addedToPipeline > 0
    ? `<div style="padding:16px 28px 0;">
        <p style="font-size:12px;color:#0969da;background:#ddf4ff;border:1px solid #b6e3ff;border-radius:6px;padding:8px 14px;margin:0;">
          ✅ ${stats.addedToPipeline} role(s) queued in <strong>data/pipeline.md</strong> — run <code>/career-ops pipeline</code> for full A-G evaluation + PDF
        </p>
       </div>` : '';

  const enrichedJobs = [...remoteJobs, ...locationJobs].filter(j => j.enrichment);
  const deepDives = enrichedJobs.map((job, i) => deepDiveCard(job, i)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">

  <div style="background:#24292f;padding:16px 28px;">
    <span style="font-size:17px;color:#fff;font-weight:700;">career-ops Agent</span>
    <span style="font-size:12px;color:#8b949e;margin-left:10px;">${displayDate}</span>
  </div>

  <div style="background:#0969da;padding:20px 28px 18px;">
    <div style="font-size:22px;font-weight:700;color:#fff;">Top ${totalCount} matched roles today</div>
    <div style="font-size:12px;color:#cae8ff;margin-top:3px;">
      🌐 ${remoteJobs.length} Remote &nbsp;·&nbsp; 📍 ${locationJobs.length} Pune / Noida / Hyderabad
    </div>
  </div>

  ${pipelineNote}
  ${jobSection('Remote — Work from Anywhere', '🌐', '#0969da', remoteJobs, 0)}
  ${jobSection('Pune / Noida / Hyderabad', '📍', '#1a7f37', locationJobs, remoteJobs.length)}

  ${deepDives ? `
  <div style="padding:20px 28px 0;">
    <div style="font-size:15px;font-weight:700;color:#24292f;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #d0d7de;">
      Interview Prep — Deep Dives
    </div>
    ${deepDives}
  </div>` : ''}

  <div style="padding:16px 28px 28px;text-align:center;">
    <p style="font-size:11px;color:#aaa;margin:0;">
      career-ops agent · edit <code>config/profile.yml</code> to change search targets ·
      run <code>/career-ops pipeline</code> to evaluate queued jobs in depth
    </p>
  </div>

</body>
</html>`.trim();
}

async function main() {
  if (!existsSync(RESULTS_PATH)) {
    console.error('[digest] data/results.json not found — run agent/loop.mjs first');
    process.exit(1);
  }

  let data;
  try { data = JSON.parse(readFileSync(RESULTS_PATH, 'utf8')); }
  catch (err) { console.error('[digest] Bad results.json:', err.message); process.exit(1); }

  const { jobs = [], date } = data;
  const REMOTE_LOCS = ['remote', 'wfh', 'work from home'];
  const isRemote = (j) => REMOTE_LOCS.some(r => (j.location || '').toLowerCase().includes(r));

  // Prefer pre-bucketed arrays; fall back to splitting flat jobs array
  let remoteJobs   = data.remoteJobs   ?? jobs.filter(isRemote).slice(0, 5);
  let locationJobs = data.locationJobs ?? jobs.filter(j => !isRemote(j)).slice(0, 5);

  // If buckets are empty but there ARE jobs (location just says "India"),
  // put them all in locationJobs so the email always sends
  const allHighFit = [...remoteJobs, ...locationJobs];
  if (allHighFit.length === 0 && jobs.length > 0) {
    locationJobs = jobs.slice(0, 10);
  }

  const totalCount = remoteJobs.length + locationJobs.length;
  if (totalCount === 0) { console.log('[digest] No jobs — skipping email.'); return; }

  const enrichedCount = [...remoteJobs, ...locationJobs].filter(j => j.enrichment).length;
  const subject = `career-ops: ${remoteJobs.length} remote + ${locationJobs.length} location roles — ${date}`;
  const html = buildHtml(data);

  if (DRY_RUN) {
    console.log(`\n[digest] DRY RUN · ${subject}`);
    console.log('  --- Remote ---');
    remoteJobs.forEach((j, i) => console.log(`  R${i+1} ${j.score}/5 · ${j.title} @ ${j.company}`));
    console.log('  --- Pune/Noida/Hyd ---');
    locationJobs.forEach((j, i) => console.log(`  L${i+1} ${j.score}/5 · ${j.title} @ ${j.company} · ${j.location}`));
    return;
  }

  const missing = ['RESEND_API_KEY','DIGEST_TO','DIGEST_FROM'].filter(v => !process.env[v]);
  if (missing.length) { console.error(`[digest] Missing env vars: ${missing.join(', ')}`); process.exit(1); }

  const resend = new Resend(process.env.RESEND_API_KEY);
  console.log(`[digest] Sending to ${process.env.DIGEST_TO}...`);

  const { data: sent, error } = await resend.emails.send({
    from: process.env.DIGEST_FROM,
    to: process.env.DIGEST_TO,
    subject,
    html,
  });

  if (error) { console.error('[digest] Resend error:', error); process.exit(1); }
  console.log(`[digest] Sent · ID: ${sent?.id} · ${remoteJobs.length} remote + ${locationJobs.length} location roles · ${enrichedCount} with deep dives`);
}

main().catch(err => { console.error('[digest] Fatal:', err); process.exit(1); });
