#!/usr/bin/env node
/**
 * Google Form Submitter - Uses logged-in Gmail session
 *
 * Submits Google Forms using puppeteer with the authenticated Gmail session.
 * This bypasses email issues by submitting directly to forms.
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const DATA_DIR = path.join(__dirname, '..', 'data');
const GOOGLE_COOKIES_PATH = path.join(DATA_DIR, 'google-cookies.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Browser instance
let browser = null;
let page = null;

/**
 * Random delay to mimic human behavior
 */
function randomDelay(min = 500, max = 2000) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

/**
 * Human-like typing
 */
async function humanType(element, text) {
  for (const char of text) {
    await element.type(char, { delay: Math.floor(Math.random() * 80) + 40 });
    await randomDelay(20, 60);
  }
}

/**
 * Save Google cookies
 */
async function saveCookies() {
  if (!page) return;
  const cookies = await page.cookies();
  fs.writeFileSync(GOOGLE_COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('[google-form] Cookies saved');
}

/**
 * Load saved Google cookies
 */
async function loadCookies() {
  if (!page) return false;
  if (fs.existsSync(GOOGLE_COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(GOOGLE_COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
    console.log('[google-form] Cookies loaded');
    return true;
  }
  return false;
}

/**
 * Initialize browser
 */
async function initBrowser() {
  if (browser && page) return { browser, page };

  console.log('[google-form] Launching browser...');

  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080'
    ],
    defaultViewport: { width: 1920, height: 1080 }
  });

  page = await browser.newPage();

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Load saved cookies
  await loadCookies();

  return { browser, page };
}

/**
 * Close browser
 */
async function closeBrowser() {
  if (page) {
    await saveCookies();
    await page.close().catch(() => {});
  }
  if (browser) {
    await browser.close().catch(() => {});
  }
  browser = null;
  page = null;
}

/**
 * Login to Gmail (interactive - run once to save cookies)
 */
async function loginToGmail() {
  await initBrowser();

  console.log('[google-form] Navigating to Gmail login...');
  await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2' });

  // Wait for manual login
  console.log('[google-form] Please login manually in the browser window...');
  console.log('[google-form] Waiting up to 5 minutes for login...');

  // Wait for successful login (redirect to myaccount or gmail)
  try {
    await page.waitForFunction(
      () => window.location.href.includes('myaccount.google.com') ||
            window.location.href.includes('mail.google.com') ||
            window.location.href.includes('accounts.google.com/signin/v2/challenge'),
      { timeout: 300000 } // 5 minutes
    );

    // If on 2FA page, wait more
    if (page.url().includes('challenge')) {
      console.log('[google-form] 2FA detected, complete verification...');
      await page.waitForFunction(
        () => window.location.href.includes('myaccount.google.com') ||
              window.location.href.includes('mail.google.com'),
        { timeout: 300000 }
      );
    }

    console.log('[google-form] Login successful!');
    await saveCookies();
    return { success: true };
  } catch (err) {
    console.error('[google-form] Login timeout or error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Check if logged into Google
 */
async function isLoggedIn() {
  await initBrowser();

  try {
    await page.goto('https://myaccount.google.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await randomDelay(2000, 3000);

    // Check if redirected to login
    const url = page.url();
    const loggedIn = !url.includes('accounts.google.com/signin');

    console.log(`[google-form] Login status: ${loggedIn ? 'logged in' : 'not logged in'}`);
    return loggedIn;
  } catch (err) {
    console.error('[google-form] Error checking login:', err.message);
    return false;
  }
}

/**
 * Submit a Google Form
 * @param {string} formUrl - The Google Form URL
 * @param {Object} fields - Field values { fieldName: value } or { entryId: value }
 */
async function submitForm(formUrl, fields) {
  await initBrowser();

  console.log('[google-form] Navigating to form:', formUrl);

  try {
    await page.goto(formUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await randomDelay(2000, 3000);

    // Check if form loaded
    const formExists = await page.$('form');
    if (!formExists) {
      return { success: false, error: 'Form not found on page' };
    }

    console.log('[google-form] Form loaded, filling fields...');

    // Fill each field
    for (const [key, value] of Object.entries(fields)) {
      await fillFormField(key, value);
      await randomDelay(500, 1000);
    }

    console.log('[google-form] Fields filled, submitting...');
    await randomDelay(1000, 2000);

    // Find and click submit button
    const submitBtn = await page.$('[role="button"][jsname="M2UYVd"]') ||
                      await page.$('div[role="button"]:has-text("Submit")') ||
                      await page.$('[aria-label="Submit"]');

    if (submitBtn) {
      await submitBtn.click();
    } else {
      // Try form submission via keyboard
      await page.keyboard.press('Enter');
    }

    await randomDelay(3000, 5000);

    // Check for success
    const pageContent = await page.content();
    const success = pageContent.includes('Your response has been recorded') ||
                   pageContent.includes('response has been submitted') ||
                   page.url().includes('formResponse');

    if (success) {
      console.log('[google-form] Form submitted successfully!');
      await saveCookies();
      return { success: true };
    } else {
      // Take screenshot for debugging
      const screenshotPath = path.join(DATA_DIR, 'form-debug.png');
      await page.screenshot({ path: screenshotPath });
      console.log('[google-form] Debug screenshot saved to:', screenshotPath);
      return { success: false, error: 'Submit confirmation not detected' };
    }
  } catch (err) {
    console.error('[google-form] Error submitting form:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Fill a single form field
 */
async function fillFormField(fieldKey, value) {
  // Try different selectors based on field key format
  let element = null;

  // If it's an entry ID (e.g., "entry.123456789")
  if (fieldKey.startsWith('entry.')) {
    element = await page.$(`[name="${fieldKey}"]`) ||
              await page.$(`input[name="${fieldKey}"]`) ||
              await page.$(`textarea[name="${fieldKey}"]`);
  }

  // Try by aria-label or placeholder
  if (!element) {
    element = await page.$(`[aria-label*="${fieldKey}" i]`) ||
              await page.$(`[placeholder*="${fieldKey}" i]`);
  }

  // Try by finding the question text and then the input
  if (!element) {
    const questions = await page.$$('[role="listitem"]');
    for (const q of questions) {
      const text = await q.evaluate(el => el.textContent);
      if (text.toLowerCase().includes(fieldKey.toLowerCase())) {
        element = await q.$('input, textarea, [contenteditable="true"]');
        break;
      }
    }
  }

  if (element) {
    const tagName = await element.evaluate(el => el.tagName.toLowerCase());

    if (tagName === 'input' || tagName === 'textarea') {
      await element.click();
      await randomDelay(200, 400);
      await element.evaluate(el => el.value = '');
      await humanType(element, value);
    } else {
      // contenteditable div
      await element.click();
      await randomDelay(200, 400);
      await page.keyboard.type(value, { delay: 50 });
    }

    console.log(`[google-form] Filled field "${fieldKey}"`);
  } else {
    console.warn(`[google-form] Could not find field: ${fieldKey}`);
  }
}

/**
 * Submit the pump.fun hackathon form specifically
 */
async function submitPumpFunHackathon(data) {
  // pump.fun Build in Public hackathon form
  const formUrl = 'https://docs.google.com/forms/d/e/1FAIpQLSe_your_form_id_here/viewform';

  // Map our data to form fields
  // You'll need to inspect the form to get actual entry IDs
  const fields = {
    'Project Name': data.projectName || '$CLAWDROOMS',
    'Token Contract': data.contract || 'HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw',
    'Description': data.description || '',
    'Twitter': data.twitter || '@clawdrooms'
  };

  return await submitForm(formUrl, fields);
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];

  switch (command) {
    case 'login':
      loginToGmail()
        .then(result => {
          console.log('Result:', result);
          return closeBrowser();
        })
        .then(() => process.exit(0));
      break;

    case 'check':
      isLoggedIn()
        .then(loggedIn => {
          console.log('Logged in:', loggedIn);
          return closeBrowser();
        })
        .then(() => process.exit(0));
      break;

    case 'submit':
      const formUrl = process.argv[3];
      const fieldsJson = process.argv[4];

      if (!formUrl || !fieldsJson) {
        console.log('Usage: node google-form-submitter.js submit <formUrl> \'{"field": "value"}\'');
        process.exit(1);
      }

      submitForm(formUrl, JSON.parse(fieldsJson))
        .then(result => {
          console.log('Result:', result);
          return closeBrowser();
        })
        .then(() => process.exit(result.success ? 0 : 1));
      break;

    default:
      console.log(`
Google Form Submitter

Commands:
  login   - Login to Gmail (interactive, saves cookies)
  check   - Check if logged into Google
  submit  - Submit a form: submit <formUrl> '{"field": "value"}'

Example:
  node google-form-submitter.js login
  node google-form-submitter.js check
  node google-form-submitter.js submit "https://docs.google.com/forms/..." '{"Name": "Test"}'
`);
  }
}

module.exports = {
  initBrowser,
  closeBrowser,
  loginToGmail,
  isLoggedIn,
  submitForm,
  submitPumpFunHackathon
};
