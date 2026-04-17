/**
 * agent/scrape.mjs
 * Self-correcting job description scraper.
 *
 * Attempt 1: Direct URL scrape
 * Attempt 2: Google search for "[company] [title] apply"
 * Attempt 3: Find company careers homepage
 * All fail → log and return null
 */

import { chromium } from 'playwright';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract visible text from a page, trimmed to maxChars */
async function extractPageText(page, maxChars = 6000) {
  try {
    const text = await page.evaluate(() => {
      // Remove nav, footer, scripts, ads
      const remove = ['nav', 'footer', 'script', 'style', 'header', '[role="banner"]', '.advertisement'];
      remove.forEach((sel) => {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      });
      return document.body?.innerText || '';
    });
    return text.replace(/\s{3,}/g, '\n\n').trim().slice(0, maxChars);
  } catch {
    return '';
  }
}

/** Check if extracted text looks like a real job description */
function looksLikeJobDescription(text) {
  if (!text || text.length < 200) return false;
  const keywords = ['responsibilities', 'requirements', 'qualifications', 'experience',
                    'skills', 'role', 'position', 'opportunity', 'apply', 'team'];
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k)).length >= 2;
}

// ── Attempt 1: Direct scrape ──────────────────────────────────────────────────

/**
 * For LinkedIn pages, try to find the external "Apply on company website" URL.
 * Returns null if it's LinkedIn Easy Apply or link isn't visible.
 */
async function findExternalApplyUrl(page, originalUrl) {
  if (!originalUrl?.includes('linkedin.com')) return null;
  try {
    return await page.evaluate(() => {
      // LinkedIn external apply button selectors (public job pages)
      const candidates = [
        ...document.querySelectorAll(
          'a.apply-button--link, ' +
          'a[data-tracking-control-name*="apply-link-offsite"], ' +
          'a[data-tracking-control-name*="apply_link"], ' +
          'a.top-card-layout__cta'
        ),
      ];

      // Also search all <a> tags whose text contains "apply" and href is external
      document.querySelectorAll('a[href]').forEach(a => candidates.push(a));

      for (const a of candidates) {
        const href = a.href || '';
        const text = (a.textContent || '').toLowerCase();
        if (
          href.startsWith('http') &&
          !href.includes('linkedin.com') &&
          !href.includes('google.com') &&
          (text.includes('apply') || /\/apply|\/job[s]?\/|\/career|\/opening|requisition/i.test(href))
        ) {
          return href;
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}

async function scrapeDirectly(browser, url) {
  const page = await browser.newPage();
  try {
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', (r) => r.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);

    // Try to find the direct company apply URL (for LinkedIn jobs)
    const applyUrl = await findExternalApplyUrl(page, url);

    // Try known job description containers first
    const selectors = [
      '[data-testid="jobDescriptionText"]',   // Indeed
      '.jobs-description__content',            // LinkedIn
      '.job-description',
      '#job-description',
      '[class*="description"]',
      '[class*="jobDetail"]',
      'main',
      'article',
    ];

    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await el.innerText().catch(() => '');
        if (looksLikeJobDescription(text)) {
          return { text: text.trim().slice(0, 6000), applyUrl };
        }
      }
    }

    // Fall back to full page text
    const fullText = await extractPageText(page);
    if (looksLikeJobDescription(fullText)) return { text: fullText, applyUrl };
    return null;
  } catch (err) {
    console.warn(`[scrape] Direct scrape error (${url}): ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ── Attempt 2: Google redirect ────────────────────────────────────────────────

async function scrapeViaGoogle(browser, company, title) {
  const page = await browser.newPage();
  try {
    const query = `${company} ${title} job apply`;
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Get first non-Google result
    const href = await page.$eval(
      'div#search a[href]:not([href*="google.com"])',
      (a) => a.href
    ).catch(() => null);

    if (!href) return null;

    console.log(`[scrape] Google redirect → ${href}`);
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);

    const text = await extractPageText(page);
    if (looksLikeJobDescription(text)) return { text, applyUrl: page.url() !== href ? null : null };
    return null;
  } catch (err) {
    console.warn(`[scrape] Google redirect error (${company}/${title}): ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ── Attempt 3: Company careers homepage ───────────────────────────────────────

async function scrapeViaCareersPage(browser, company, title) {
  const page = await browser.newPage();
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(company + ' careers jobs')}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const careersHref = await page.$$eval(
      'div#search a[href]',
      (els, co) => {
        const coLower = co.toLowerCase().replace(/\s+/g, '');
        return (
          els
            .map((a) => a.href)
            .find(
              (h) =>
                !h.includes('google.com') &&
                (h.includes('careers') || h.includes('jobs')) &&
                (h.includes(coLower) || h.includes('greenhouse') || h.includes('lever'))
            ) || null
        );
      },
      company
    ).catch(() => null);

    if (!careersHref) return null;

    console.log(`[scrape] Careers page → ${careersHref}`);
    await page.goto(careersHref, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);

    // Search for the role by title on the careers page
    const titleInput = await page.$('input[type="text"], input[type="search"], input[placeholder*="search"]').catch(() => null);
    if (titleInput) {
      await titleInput.fill(title);
      await titleInput.press('Enter');
      await page.waitForTimeout(2000);
    }

    const text = await extractPageText(page);
    if (looksLikeJobDescription(text)) return { text, applyUrl: page.url() };
    return null;
  } catch (err) {
    console.warn(`[scrape] Careers page error (${company}/${title}): ${err.message}`);
    return null;
  } finally {
    await page.close();
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true });
  }
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

/**
 * Scrape the full job description for a job stub.
 * Tries 3 strategies with self-correction.
 *
 * @param {{ url: string, title: string, company: string }} job
 * @returns {Promise<{ description: string, applyUrl: string|null }|null>}
 *   description = full JD text; applyUrl = direct company apply URL (if found)
 */
export async function scrapeJobDescription(job) {
  const browser = await getBrowser();
  const { url, title = '', company = '' } = job;

  // Attempt 1
  if (url) {
    console.log(`[scrape] Attempt 1 — direct: ${url}`);
    const result = await scrapeDirectly(browser, url);
    if (result) {
      if (result.applyUrl) console.log(`[scrape] Found direct apply URL: ${result.applyUrl}`);
      return { description: result.text, applyUrl: result.applyUrl || null };
    }
  }

  // Attempt 2
  if (company || title) {
    console.log(`[scrape] Attempt 2 — Google redirect: "${company} ${title}"`);
    const result = await scrapeViaGoogle(browser, company, title);
    if (result) return { description: result.text, applyUrl: result.applyUrl || null };
  }

  // Attempt 3
  if (company) {
    console.log(`[scrape] Attempt 3 — careers page: ${company}`);
    const result = await scrapeViaCareersPage(browser, company, title);
    if (result) return { description: result.text, applyUrl: result.applyUrl || null };
  }

  console.warn(`[scrape] All 3 attempts failed for: ${title} @ ${company} (${url})`);
  return null;
}
