/**
 * agent/goal-sync.mjs
 * Reads career-ops config/profile.yml + modes/_profile.md and auto-generates
 * data/goal.md so the autonomous agent stays aligned with your career-ops profile.
 *
 * Called at the start of every agent run. You never need to edit data/goal.md
 * manually — just update config/profile.yml and it propagates automatically.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROFILE_YML  = path.join(ROOT, 'config/profile.yml');
const PROFILE_MD   = path.join(ROOT, 'modes/_profile.md');
const GOAL_PATH    = path.join(ROOT, 'data/goal.md');

// ── Minimal YAML parser for the fields we need ────────────────────────────────
// Avoids a heavy dependency for simple key: "value" and list items.

function extractYamlValue(yaml, key) {
  const re = new RegExp(`^\\s*${key}:\\s*["']?([^"'\\n]+)["']?`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim() : null;
}

function extractYamlList(yaml, parentKey) {
  const start = yaml.indexOf(`${parentKey}:`);
  if (start === -1) return [];
  const block = yaml.slice(start + parentKey.length + 1);
  const items = [];
  for (const line of block.split('\n')) {
    // Only match simple string list items: - "value" or - value
    // Skip object list items like: - name: "..." (those start with a key)
    const m = line.match(/^\s+-\s+["']([^"']+)["']|^\s+-\s+([^"'\s{][^\n:]*[^\s])$/);
    if (m) {
      const val = (m[1] || m[2] || '').trim();
      if (val) items.push(val);
    } else if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('-') && !/^\s/.test(line)) {
      break;
    }
  }
  return items;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function syncGoal() {
  if (!existsSync(PROFILE_YML)) {
    console.log('[goal-sync] config/profile.yml not found — keeping existing data/goal.md');
    return;
  }

  const yml = readFileSync(PROFILE_YML, 'utf8');

  // Extract profile fields
  const name      = extractYamlValue(yml, 'full_name') || 'Candidate';
  const location  = extractYamlValue(yml, 'city') || 'India';
  const country   = extractYamlValue(yml, 'country') || 'India';
  const remote    = extractYamlValue(yml, 'remote');
  const minimum   = extractYamlValue(yml, 'minimum') || '';
  const currency  = extractYamlValue(yml, 'currency') || 'INR';

  const primaryRoles = extractYamlList(yml, 'primary');
  const archetypeBlock = yml.match(/archetypes:([\s\S]*?)(?=\n\w|\n#|$)/)?.[1] || '';
  const archetypeNames = [...archetypeBlock.matchAll(/name:\s*["']?([^"'\n]+)["']?/g)].map(m => m[1].trim());

  // Build location string
  const locationLine = remote === 'true'
    ? `Priority: Remote / Work From Home. Secondary: ${location}, ${country}. No international relocation.`
    : `Priority: ${location}, ${country}. Open to remote within ${country}.`;

  // Experience context (hardcoded to 4 yrs — update manually if needed)
  const expNote = `Experience level: I have 4 years of total experience. Target roles requiring 3–5 years. DO NOT surface roles requiring 6+ years or 8–12 years. Avoid "Senior Manager", "Director", "VP", "Head of" unless JD explicitly says 3–5 years is fine.`;

  // Comp context
  const compNote = minimum
    ? `Minimum compensation: ${minimum} ${currency}. Avoid roles with no comp signal or that appear below this floor.`
    : '';

  // Build goal
  const roleList = primaryRoles.length
    ? primaryRoles.join(', ')
    : archetypeNames.slice(0, 3).join(', ') || 'Data Engineer, Data Governance Manager';

  const goal = `# Agent Goal — auto-generated from config/profile.yml
# Last synced: ${new Date().toISOString().slice(0, 10)}
# To change targets, edit config/profile.yml — this file is overwritten each run.

Find 5 high-fit roles in ${country} today.

Target roles: ${roleList}.

${expNote}

${locationLine}

Prefer roles at established financial institutions, large tech companies, or well-funded scale-ups with good data teams. Avoid roles below 4.0/5.0 fit score.

${compNote}

Domains to prioritise: Data Governance, Data Management, Analytics Engineering, Data Platform, ML Platform, BI Engineering.
`.trim();

  writeFileSync(GOAL_PATH, goal, 'utf8');
  console.log(`[goal-sync] data/goal.md updated from profile.yml (targets: ${roleList})`);
}
