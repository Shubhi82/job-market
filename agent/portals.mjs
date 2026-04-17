/**
 * agent/portals.mjs
 * Scans company career portals directly for job listings.
 *
 * career-ops integration:
 * - Reads data/portals.json if present (custom override)
 * - Falls back to DEFAULT_PORTALS which are India-focused for Shubhi's search
 * - Note: career-ops's portals.yml has a different schema (for /career-ops scan),
 *   this file uses its own lightweight format for the autonomous agent
 */

import { chromium } from 'playwright';
import { makeJobId } from './memory.mjs';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const ROOT          = path.join(__dirname, '..');
const PORTALS_PATH  = path.join(ROOT, 'data/portals.json');

// ── Default portal list (India data/analytics/governance focus) ───────────────

const DEFAULT_PORTALS = [
  // ── Consulting / Big 4 ──────────────────────────────────────────────────────
  { company: 'Deloitte India',       type: 'duckduckgo', domain: 'apply.deloitte.com' },
  { company: 'KPMG India',           type: 'duckduckgo', domain: 'kpmg.com/in/en/careers' },
  { company: 'EY India',             type: 'duckduckgo', domain: 'ey.com/en_in/careers' },
  { company: 'PwC India',            type: 'duckduckgo', domain: 'pwc.in/careers' },
  { company: 'Accenture India',      type: 'workday',    tenant: 'https://accenture.wd3.myworkdayjobs.com/AccentureJobs' },
  { company: 'Capgemini India',      type: 'duckduckgo', domain: 'capgemini.com/in-en/careers' },

  // ── Banks / Financial Services ─────────────────────────────────────────────
  { company: 'Macquarie Group',      type: 'duckduckgo', domain: 'macquarie.com/in/en/careers' },
  { company: 'Goldman Sachs India',  type: 'duckduckgo', domain: 'goldmansachs.com/careers' },
  { company: 'JPMorgan India',       type: 'duckduckgo', domain: 'jpmorgan.com/global/careers' },
  { company: 'Morgan Stanley India', type: 'workday',    tenant: 'https://morganstanley.wd5.myworkdayjobs.com/MS_External_Career_Site' },
  { company: 'HSBC India',           type: 'duckduckgo', domain: 'hsbc.com/careers' },
  { company: 'Citi India',           type: 'duckduckgo', domain: 'jobs.citi.com' },
  { company: 'Deutsche Bank India',  type: 'duckduckgo', domain: 'careers.db.com' },

  // ── Tech ───────────────────────────────────────────────────────────────────
  { company: 'Amazon India',         type: 'amazon' },
  { company: 'Microsoft India',      type: 'duckduckgo', domain: 'careers.microsoft.com' },
  { company: 'IBM India',            type: 'duckduckgo', domain: 'ibm.com/careers' },
  { company: 'Google India',         type: 'duckduckgo', domain: 'careers.google.com' },
  { company: 'Salesforce India',     type: 'duckduckgo', domain: 'salesforce.com/company/careers' },
  { company: 'Adobe India',          type: 'duckduckgo', domain: 'adobe.com/careers' },

  // ── Indian IT / Analytics ──────────────────────────────────────────────────
  { company: 'Wipro',                type: 'duckduckgo', domain: 'wipro.com/careers' },
  { company: 'Infosys',              type: 'duckduckgo', domain: 'infosys.com/careers' },
  { company: 'Cognizant India',      type: 'duckduckgo', domain: 'careers.cognizant.com' },
  { company: 'Fractal Analytics',    type: 'duckduckgo', domain: 'fractal.ai/careers' },
  { company: 'Tiger Analytics',      type: 'duckduckgo', domain: 'tigeranalytics.com/careers' },
  { company: 'Mu Sigma',             type: 'duckduckgo', domain: 'mu-sigma.com/careers' },

  // ── Insurance / Asset Management ──────────────────────────────────────────
  { company: 'HDFC Life',            type: 'duckduckgo', domain: 'hdfclife.com/careers' },
  { company: 'Bajaj Finserv',        type: 'duckduckgo', domain: 'bajajfinserv.in/careers' },
  { company: 'Kotak Mahindra',       type: 'duckduckgo', domain: 'kotak.com/careers' },
];

function loadPortals() {
  if (existsSync(PORTALS_PATH)) {
    try {
      return JSON.parse(readFileSync(PORTALS_PATH, 'utf8'));
    } catch {
      console.warn('[portals] Could not parse data/portals.json — using defaults');
    }
  }
  return DEFAULT_PORTALS;
}

function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes('linkedin.com')) { u.search = ''; return u.toString(); }
    ['refId','trackingId','position','pageNum','utm_source','utm_medium','utm_campaign'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch { return raw; }
}

async function searchWorkday(page, tenantUrl, query, company, maxResults = 12) {
  const results = [];
  try {
    const url = `${tenantUrl}?q=${encodeURIComponent(query)}&locationCountry=IN`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('[data-automation-id="jobTitle"]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const jobs = await page.$$eval('[data-automation-id="jobTitle"]', (els) =>
      els.slice(0, 15).map((el) => ({ title: el.textContent?.trim() || '', url: el.href || el.querySelector('a')?.href || '' }))
    );

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ title: j.title, company, location: 'India', url: canon, source: 'portal_workday', jobId: makeJobId(canon, j.title, company) });
      }
    }
  } catch (err) {
    console.warn(`[portals] Workday failed for ${company}: ${err.message}`);
  }
  return results.slice(0, maxResults);
}

async function searchAmazon(page, query, maxResults = 12) {
  const results = [];
  try {
    const url = `https://www.amazon.jobs/en/search?base_query=${encodeURIComponent(query)}&loc_query=India&country=IN&result_limit=20`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const jobs = await page.$$eval('.job-tile', (items) =>
      items.slice(0, 15).map((el) => ({
        title: el.querySelector('h3.job-title, .job-title')?.textContent?.trim() || '',
        location: el.querySelector('.location-and-id li:first-child, .location')?.textContent?.trim() || 'India',
        url: el.querySelector('a[href*="/jobs/"]')?.href || '',
      }))
    );

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ title: j.title, company: 'Amazon', location: j.location, url: canon, source: 'portal_amazon', jobId: makeJobId(canon, j.title, 'Amazon') });
      }
    }
  } catch (err) {
    console.warn(`[portals] Amazon failed: ${err.message}`);
  }
  return results.slice(0, maxResults);
}

async function searchDuckDuckGo(page, query, domain, company, maxResults = 8) {
  const results = [];
  try {
    const fullQuery = `${query} india site:${domain}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(fullQuery)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const links = await page.$$eval('.result', (items) =>
      items.slice(0, 12).map((el) => ({
        title: el.querySelector('a.result__a')?.textContent?.trim() || '',
        url: el.querySelector('a.result__a')?.href || '',
      }))
    );

    for (const l of links) {
      if (!l.title || !l.url) continue;
      const u = l.url.toLowerCase();
      const looksLikeJob = /\/job[s]?\/|\/position[s]?\/|\/opening[s]?\/|\/role[s]?\/|\/vacancy|\/apply|jobid|job_id|requisition/i.test(u)
        || l.title.toLowerCase().includes(query.split(' ')[0].toLowerCase());
      if (!looksLikeJob) continue;

      const canon = canonicalUrl(l.url);
      results.push({ title: l.title.split(' | ')[0].split(' - ')[0].trim().slice(0, 120), company, location: 'India', url: canon, source: 'portal_ddg', jobId: makeJobId(canon, l.title, company) });
    }
  } catch (err) {
    console.warn(`[portals] DuckDuckGo failed for ${company}: ${err.message}`);
  }
  return results.slice(0, maxResults);
}

export async function scanPortals(keywords, seenIds = new Set()) {
  const portals = loadPortals();
  const allResults = new Map();
  const queries = keywords.slice(0, 2);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-IN',
  });

  try {
    const page = await context.newPage();
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (r) => r.abort());

    for (const portal of portals) {
      for (const query of queries) {
        let jobs = [];
        try {
          if (portal.type === 'workday') {
            const wpPage = await context.newPage();
            await wpPage.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (r) => r.abort());
            jobs = await searchWorkday(wpPage, portal.tenant, query, portal.company);
            await wpPage.close();
          } else if (portal.type === 'amazon') {
            jobs = await searchAmazon(page, query);
          } else {
            jobs = await searchDuckDuckGo(page, query, portal.domain, portal.company);
          }

          let added = 0;
          for (const job of jobs) {
            if (!seenIds.has(job.jobId) && !allResults.has(job.jobId)) { allResults.set(job.jobId, job); added++; }
          }
          if (jobs.length > 0) console.log(`[portals] ${portal.company}: ${jobs.length} found, ${added} new`);
        } catch (err) {
          console.warn(`[portals] Error scanning ${portal.company}: ${err.message}`);
        }
      }
    }
    await page.close();
  } finally {
    await browser.close();
  }

  const results = [...allResults.values()];
  console.log(`[portals] Total from portals: ${results.length} unique new jobs`);
  return results;
}
