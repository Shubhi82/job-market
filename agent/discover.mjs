/**
 * agent/discover.mjs
 * Dynamic job discovery — searches LinkedIn, Naukri (standard + WFH), Indeed,
 * Google Jobs, iimjobs, Foundit, and TimesJobs using Playwright.
 * Returns raw job listings for scraping + scoring.
 */

import { chromium } from 'playwright';
import { makeJobId } from './memory.mjs';

// ── URL canonicalisation ──────────────────────────────────────────────────────

const STRIP_PARAMS = new Set([
  'refId', 'trackingId', 'position', 'pageNum',
  'src', 'sid', 'sn', 'fr', 'ut',
  'from', 'vjk', 'jsa',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
]);

function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.includes('linkedin.com')) { u.search = ''; return u.toString(); }
    for (const p of STRIP_PARAMS) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return raw;
  }
}

// ── Board scrapers ─────────────────────────────────────────────────────────────

/**
 * LinkedIn Jobs — two passes per query: India-wide + Remote-only (f_WT=2).
 * f_TPR=r604800 = last 7 days | f_E=3,4 = Associate + Mid-Senior level.
 */
async function searchLinkedIn(page, query, maxResults = 20) {
  const results = [];
  const urls = [
    `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=India&f_TPR=r604800&f_E=3%2C4`,
    `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&location=India&f_TPR=r604800&f_E=3%2C4&f_WT=2`,
  ];

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const jobs = await page.$$eval(
        'ul.jobs-search__results-list li',
        (items) =>
          items.slice(0, 20).map((el) => ({
            title:    el.querySelector('.base-search-card__title')?.textContent?.trim() || '',
            company:  el.querySelector('.base-search-card__subtitle')?.textContent?.trim() || '',
            location: el.querySelector('.job-search-card__location')?.textContent?.trim() || '',
            url:      el.querySelector('a.base-card__full-link')?.href || '',
          }))
      );

      for (const j of jobs) {
        if (j.title && j.url) {
          const canon = canonicalUrl(j.url);
          results.push({ ...j, url: canon, source: 'linkedin', jobId: makeJobId(canon, j.title, j.company) });
        }
      }
    } catch (err) {
      console.warn(`[discover] LinkedIn search failed for "${query}": ${err.message}`);
    }
  }

  return results.slice(0, maxResults);
}

/**
 * Naukri.com — standard search filtered to 3–5 years experience.
 */
async function searchNaukri(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://www.naukri.com/jobs-in-india?k=${encodeURIComponent(query)}&experienceMin=3&experienceMax=5&nignbevent_src=jobsearchDesk`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4000);

    const jobs = await page.evaluate(() => {
      const found = [];
      const wrappers = document.querySelectorAll('.srp-jobtuple-wrapper, [data-job-id], .cust-job-tuple');
      if (wrappers.length > 0) {
        wrappers.forEach((el) => {
          const titleEl = el.querySelector('a.title, .title a, a[title]');
          const companyEl = el.querySelector('.comp-name, .company-name, [class*="comp"]');
          const locEl = el.querySelector('.loc, .location, [class*="loc"]');
          if (titleEl) {
            found.push({
              title:    titleEl.textContent?.trim() || titleEl.getAttribute('title') || '',
              company:  companyEl?.textContent?.trim() || '',
              location: locEl?.textContent?.trim() || '',
              url:      titleEl.href || titleEl.getAttribute('href') || '',
            });
          }
        });
      }
      if (found.length === 0) {
        document.querySelectorAll('article.jobTuple').forEach((el) => {
          const titleEl = el.querySelector('a.title');
          if (titleEl) {
            found.push({
              title:    titleEl.textContent?.trim() || '',
              company:  el.querySelector('.subTitle')?.textContent?.trim() || '',
              location: el.querySelector('.location')?.textContent?.trim() || '',
              url:      titleEl.href || '',
            });
          }
        });
      }
      return found.slice(0, 20);
    });

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ ...j, url: canon, source: 'naukri', jobId: makeJobId(canon, j.title, j.company) });
      }
    }
  } catch (err) {
    console.warn(`[discover] Naukri search failed for "${query}": ${err.message}`);
  }
  return results.slice(0, maxResults);
}

/**
 * Naukri Work-From-Home — dedicated WFH/remote search on Naukri.
 * Uses Naukri's /remote-jobs and /work-from-home-jobs paths.
 */
async function searchNaukriRemote(page, query, maxResults = 15) {
  const results = [];
  const urls = [
    `https://www.naukri.com/remote-jobs?k=${encodeURIComponent(query)}&experienceMin=3&experienceMax=5`,
    `https://www.naukri.com/work-from-home-jobs?k=${encodeURIComponent(query)}&experienceMin=3&experienceMax=5`,
  ];

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(4000);

      const jobs = await page.evaluate(() => {
        const found = [];
        const wrappers = document.querySelectorAll('.srp-jobtuple-wrapper, [data-job-id], .cust-job-tuple');
        wrappers.forEach((el) => {
          const titleEl = el.querySelector('a.title, .title a, a[title]');
          const companyEl = el.querySelector('.comp-name, .company-name, [class*="comp"]');
          const locEl = el.querySelector('.loc, .location, [class*="loc"]');
          if (titleEl) {
            found.push({
              title:    titleEl.textContent?.trim() || titleEl.getAttribute('title') || '',
              company:  companyEl?.textContent?.trim() || '',
              location: locEl?.textContent?.trim() || 'Remote',
              url:      titleEl.href || titleEl.getAttribute('href') || '',
            });
          }
        });
        return found.slice(0, 20);
      });

      for (const j of jobs) {
        if (j.title && j.url) {
          const canon = canonicalUrl(j.url);
          results.push({ ...j, url: canon, source: 'naukri_remote', jobId: makeJobId(canon, j.title, j.company) });
        }
      }
    } catch (err) {
      console.warn(`[discover] Naukri remote search failed for "${query}": ${err.message}`);
    }
  }

  return results.slice(0, maxResults);
}

/**
 * Indeed India
 */
async function searchIndeed(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://in.indeed.com/jobs?q=${encodeURIComponent(query)}&l=India&fromage=7&explvl=mid_level`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const jobs = await page.$$eval(
      'div.job_seen_beacon',
      (items) =>
        items.slice(0, 20).map((el) => ({
          title:    el.querySelector('[data-testid="jobTitle"] span')?.textContent?.trim() || '',
          company:  el.querySelector('[data-testid="company-name"]')?.textContent?.trim() || '',
          location: el.querySelector('[data-testid="text-location"]')?.textContent?.trim() || '',
          url: el.querySelector('a[data-jk]')
            ? 'https://in.indeed.com' + el.querySelector('a[data-jk]')?.getAttribute('href')
            : '',
        }))
    );

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ ...j, url: canon, source: 'indeed', jobId: makeJobId(canon, j.title, j.company) });
      }
    }
  } catch (err) {
    console.warn(`[discover] Indeed search failed for "${query}": ${err.message}`);
  }
  return results.slice(0, maxResults);
}

/**
 * iimjobs.com — best platform for senior/MBA-level roles in India
 */
async function searchIimjobs(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://www.iimjobs.com/j/search?q=${encodeURIComponent(query)}&location=india`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4000);

    const jobs = await page.evaluate(() => {
      const found = [];
      const cards = document.querySelectorAll(
        '.job-list-item, .job-item, .job-wrap, [class*="joblist"], li[id*="job"]'
      );
      cards.forEach((el) => {
        const titleEl = el.querySelector('h2 a, h3 a, .heading-title a, a.job-title, a[class*="title"]');
        const companyEl = el.querySelector('.company-name, [class*="company"], .org-name');
        const locEl = el.querySelector('.location, [class*="location"], .city');
        if (titleEl) {
          found.push({
            title:    titleEl.textContent?.trim() || '',
            company:  companyEl?.textContent?.trim() || '',
            location: locEl?.textContent?.trim() || '',
            url:      titleEl.href || '',
          });
        }
      });
      return found.slice(0, 20);
    });

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ ...j, url: canon, source: 'iimjobs', jobId: makeJobId(canon, j.title, j.company) });
      }
    }
  } catch (err) {
    console.warn(`[discover] iimjobs search failed for "${query}": ${err.message}`);
  }
  return results.slice(0, maxResults);
}

/**
 * Foundit (foundit.in) — formerly Monster India.
 * No experience code filter — rely on query keywords and Gemini scoring.
 */
async function searchFoundit(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://www.foundit.in/srp/results?query=${encodeURIComponent(query)}&location=India`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4000);

    const jobs = await page.evaluate(() => {
      const found = [];
      const cards = document.querySelectorAll(
        '.card-apply-content, .srpResultCardContainer, [class*="jobCard"], [class*="job-card"]'
      );
      cards.forEach((el) => {
        const titleEl = el.querySelector('.jobTitle a, a.jobTitle, h3 a, [class*="title"] a');
        const companyEl = el.querySelector('.companyName, [class*="company"]');
        const locEl = el.querySelector('.location, [class*="location"]');
        if (titleEl) {
          found.push({
            title:    titleEl.textContent?.trim() || '',
            company:  companyEl?.textContent?.trim() || '',
            location: locEl?.textContent?.trim() || '',
            url:      titleEl.href || '',
          });
        }
      });
      return found.slice(0, 20);
    });

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ ...j, url: canon, source: 'foundit', jobId: makeJobId(canon, j.title, j.company) });
      }
    }
  } catch (err) {
    console.warn(`[discover] Foundit search failed for "${query}": ${err.message}`);
  }
  return results.slice(0, maxResults);
}

/**
 * TimesJobs
 */
async function searchTimesjobs(page, query, maxResults = 15) {
  const results = [];
  try {
    const url = `https://www.timesjobs.com/candidate/job-search.html?searchType=personalizedSearch&from=submit&txtKeywords=${encodeURIComponent(query)}&txtLocation=india`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);

    const jobs = await page.evaluate(() => {
      const found = [];
      const cards = document.querySelectorAll('.clearfix.job-bx.wht-shd-bx, .job-bx');
      cards.forEach((el) => {
        const titleEl = el.querySelector('h2 a, .job-title a');
        const companyEl = el.querySelector('.joblist-comp-name, .company-name');
        const locEl = el.querySelector('ul.top-jd-dtl li:first-child, .location');
        if (titleEl) {
          found.push({
            title:    titleEl.textContent?.trim() || '',
            company:  companyEl?.textContent?.trim() || '',
            location: locEl?.textContent?.trim() || '',
            url:      titleEl.href || '',
          });
        }
      });
      return found.slice(0, 20);
    });

    for (const j of jobs) {
      if (j.title && j.url) {
        const canon = canonicalUrl(j.url);
        results.push({ ...j, url: canon, source: 'timesjobs', jobId: makeJobId(canon, j.title, j.company) });
      }
    }
  } catch (err) {
    console.warn(`[discover] TimesJobs search failed for "${query}": ${err.message}`);
  }
  return results.slice(0, maxResults);
}

/**
 * Google Jobs — organic search linking to Naukri, LinkedIn, iimjobs,
 * Hirist, Instahyre, Foundit, and company career pages.
 * Two passes: India-wide + remote-only.
 */
async function searchGoogleJobs(page, query, maxResults = 15) {
  const results = [];
  const domainFilter = 'site:linkedin.com OR site:naukri.com OR site:indeed.com OR site:iimjobs.com OR site:foundit.in OR site:hirist.tech OR site:instahyre.com OR site:careers';

  const searches = [
    `${query} jobs India ${domainFilter}`,
    `${query} remote OR "work from home" India ${domainFilter}`,
  ];

  for (const fullQuery of searches) {
    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(fullQuery)}&tbs=qdr:w`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      const links = await page.$$eval('div#search a[href]', (els) =>
        els
          .map((a) => ({ href: a.href, text: a.innerText?.trim() }))
          .filter(
            (l) =>
              l.href &&
              !l.href.includes('google.com') &&
              l.text.length > 10 &&
              (l.href.includes('linkedin.com/jobs') ||
                l.href.includes('naukri.com') ||
                l.href.includes('indeed.com') ||
                l.href.includes('iimjobs.com') ||
                l.href.includes('foundit.in') ||
                l.href.includes('hirist.tech') ||
                l.href.includes('instahyre.com') ||
                l.href.includes('careers') ||
                l.href.includes('/jobs/'))
          )
          .slice(0, 15)
      );

      for (const link of links) {
        const title = link.text.split('\n')[0].slice(0, 120);
        const canon = canonicalUrl(link.href);
        results.push({
          title,
          company:  '',
          location: fullQuery.includes('remote') ? 'Remote' : 'India',
          url:      canon,
          source:   'google_jobs',
          jobId:    makeJobId(canon, title, ''),
        });
      }
    } catch (err) {
      console.warn(`[discover] Google Jobs search failed for "${query}": ${err.message}`);
    }
  }

  return results.slice(0, maxResults);
}

// ── Board dispatcher ──────────────────────────────────────────────────────────

const BOARD_FNS = {
  linkedin:     searchLinkedIn,
  naukri:       searchNaukri,
  naukri_remote: searchNaukriRemote,
  indeed:       searchIndeed,
  iimjobs:      searchIimjobs,
  foundit:      searchFoundit,
  timesjobs:    searchTimesjobs,
  google_jobs:  searchGoogleJobs,
};

// Run all boards every time — brain can add extras but we never drop defaults
const DEFAULT_BOARDS = ['linkedin', 'naukri', 'naukri_remote', 'iimjobs', 'foundit', 'indeed', 'timesjobs', 'google_jobs'];

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * @param {SearchPlan} plan  - from brain.mjs
 * @param {Set<string>} seenIds - already-processed job IDs
 * @returns {Promise<JobStub[]>}
 */
export async function discoverJobs(plan, seenIds = new Set()) {
  const { queries, boards = DEFAULT_BOARDS } = plan;
  const allResults = new Map();

  const boardList = [...new Set([...boards, ...DEFAULT_BOARDS])];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-IN',
    extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' },
  });

  try {
    for (const board of boardList) {
      const searchFn = BOARD_FNS[board];
      if (!searchFn) { console.warn(`[discover] Unknown board: ${board}`); continue; }

      const page = await context.newPage();
      await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (r) => r.abort());

      for (const query of queries) {
        console.log(`[discover] ${board}: "${query}"`);
        try {
          const jobs = await searchFn(page, query, 15);
          let added = 0;
          for (const job of jobs) {
            if (!seenIds.has(job.jobId) && !allResults.has(job.jobId)) {
              allResults.set(job.jobId, job);
              added++;
            }
          }
          console.log(`[discover]   → ${jobs.length} found, ${added} new`);
        } catch (err) {
          console.warn(`[discover] Error on ${board}/"${query}": ${err.message}`);
        }
      }

      await page.close();
    }
  } finally {
    await browser.close();
  }

  const jobs = [...allResults.values()];
  console.log(`[discover] Total: ${jobs.length} unique new jobs across all boards`);
  return jobs;
}
