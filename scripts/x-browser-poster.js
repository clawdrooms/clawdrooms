#!/usr/bin/env node
/**
 * X Browser Poster - No API Required
 *
 * Uses Puppeteer with stealth plugin to post to X
 * Mimics human behavior to avoid detection
 */

require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const COOKIES_PATH = path.join(__dirname, '..', 'data', 'x-cookies.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Browser instance (reused)
let browser = null;
let page = null;
let isLoggedIn = false;

/**
 * Mutex lock to prevent concurrent browser operations
 */
let operationLock = false;
let lockQueue = [];

async function acquireLock(operationName) {
  if (!operationLock) {
    operationLock = true;
    console.log(`[x-browser] ${operationName} acquired lock`);
    return;
  }

  // Wait in queue
  console.log(`[x-browser] ${operationName} waiting for lock...`);
  return new Promise(resolve => {
    lockQueue.push(() => {
      console.log(`[x-browser] ${operationName} acquired lock from queue`);
      resolve();
    });
  });
}

function releaseLock() {
  if (lockQueue.length > 0) {
    const next = lockQueue.shift();
    next();
  } else {
    operationLock = false;
  }
}

/**
 * Random delay to mimic human behavior
 */
function randomDelay(min = 500, max = 2000) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
}

/**
 * Track last error time for cooldown
 */
let lastErrorTime = 0;
const ERROR_COOLDOWN_MS = 30000; // 30 second cooldown after errors
let consecutiveErrors = 0;

/**
 * Retry wrapper with exponential backoff and mutex lock
 */
async function withRetry(fn, maxRetries = 3, baseDelay = 5000, operationName = 'operation') {
  await acquireLock(operationName);

  try {
    // Check cooldown
    const timeSinceError = Date.now() - lastErrorTime;
    if (timeSinceError < ERROR_COOLDOWN_MS && consecutiveErrors > 0) {
      const waitTime = ERROR_COOLDOWN_MS - timeSinceError;
      console.log(`[x-browser] Cooling down for ${Math.round(waitTime/1000)}s after ${consecutiveErrors} errors`);
      await new Promise(r => setTimeout(r, waitTime));
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await fn();
        consecutiveErrors = 0; // Reset on success
        return result;
      } catch (err) {
        lastErrorTime = Date.now();
        consecutiveErrors++;
        console.error(`[x-browser] Attempt ${attempt}/${maxRetries} failed:`, err.message);

        if (attempt === maxRetries) {
          throw err;
        }

        // Exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 2000;
        console.log(`[x-browser] Retrying in ${Math.round(delay/1000)}s...`);
        await new Promise(r => setTimeout(r, delay));

        // Full browser reset before retry
        await hardResetBrowser();
      }
    }
  } finally {
    releaseLock();
  }
}

/**
 * Hard reset - completely destroy and recreate browser
 */
async function hardResetBrowser() {
  console.log('[x-browser] Hard reset - destroying browser...');
  try {
    if (page) {
      await page.close().catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  } catch (e) {}
  browser = null;
  page = null;
  isLoggedIn = false;

  // Wait before recreating
  await new Promise(r => setTimeout(r, 2000));
}

/**
 * Human-like typing
 */
async function humanType(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector);
  await randomDelay(500, 800);

  // Type the full text with human-like delays
  for (const char of text) {
    await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 40 });
    await randomDelay(20, 80);
  }
}

/**
 * Save cookies for session persistence
 */
async function saveCookies(page) {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
  console.log('[x-browser] Cookies saved');
}

/**
 * Load saved cookies
 */
async function loadCookies(page) {
  if (fs.existsSync(COOKIES_PATH)) {
    const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
    await page.setCookie(...cookies);
    console.log('[x-browser] Cookies loaded');
    return true;
  }
  return false;
}

/**
 * Initialize browser
 */
async function initBrowser() {
  if (browser) return { browser, page };

  console.log('[x-browser] Launching browser...');

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

  // Set realistic user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  // Navigate to X first to establish domain context for cookies
  await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Load cookies if available - must be done after navigating to domain
  const cookiesLoaded = await loadCookies(page);

  // If cookies loaded, reload page to apply session
  if (cookiesLoaded) {
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    await randomDelay(2000, 3000);
  }

  return { browser, page };
}

/**
 * Login to X
 */
async function login(page) {
  const username = process.env.X_USERNAME;
  const password = process.env.X_PASSWORD;
  const email = process.env.X_EMAIL;

  if (!username || !password) {
    throw new Error('X credentials not configured');
  }

  console.log('[x-browser] Logging in...');

  await page.goto('https://x.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
  await randomDelay(3000, 5000);

  // Take screenshot of login page for debugging
  try {
    await page.screenshot({ path: path.join(DATA_DIR, `x-login-${Date.now()}.png`) });
  } catch (e) {}

  // Enter username
  await humanType(page, 'input[autocomplete="username"]', username);
  await randomDelay(1000, 1500);

  // Click next - try multiple methods
  console.log('[x-browser] Clicking Next button...');
  try {
    await page.click('button[role="button"]:has-text("Next")');
  } catch (e) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const next = buttons.find(b => b.textContent.includes('Next'));
      if (next) next.click();
    });
  }

  await randomDelay(3000, 5000);

  // Take screenshot after clicking Next
  try {
    await page.screenshot({ path: path.join(DATA_DIR, `x-login-after-next-${Date.now()}.png`) });
  } catch (e) {}

  // Check for email verification prompt
  const emailInput = await page.$('input[data-testid="ocfEnterTextTextInput"]');
  if (emailInput && email) {
    console.log('[x-browser] Email verification required');
    await humanType(page, 'input[data-testid="ocfEnterTextTextInput"]', email);
    await randomDelay(500, 1000);
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const next = buttons.find(b => b.textContent.includes('Next'));
      if (next) next.click();
    });
    await randomDelay(3000, 5000);
  }

  // Wait for password field with longer timeout
  console.log('[x-browser] Waiting for password field...');
  try {
    await page.waitForSelector('input[name="password"]', { timeout: 30000 });
  } catch (e) {
    // Take screenshot if password field not found
    console.error('[x-browser] Password field not found, taking screenshot...');
    await page.screenshot({ path: path.join(DATA_DIR, `x-login-no-password-${Date.now()}.png`) });
    throw new Error('Password field not found - X may be showing a challenge');
  }

  // Enter password
  await humanType(page, 'input[name="password"]', password);
  await randomDelay(1000, 1500);

  // Click login
  console.log('[x-browser] Clicking Log in button...');
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const login = buttons.find(b => b.textContent.includes('Log in'));
    if (login) login.click();
  });

  await randomDelay(5000, 8000);

  // Verify login
  const loggedIn = await page.evaluate(() => {
    return !!document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
  });

  if (loggedIn) {
    console.log('[x-browser] Login successful');
    await saveCookies(page);
    isLoggedIn = true;
    return true;
  }

  // Take screenshot of failed login state
  await page.screenshot({ path: path.join(DATA_DIR, `x-login-failed-${Date.now()}.png`) });
  throw new Error('Login failed - could not verify');
}

/**
 * Check if logged in
 */
async function checkLogin(page) {
  await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });
  await randomDelay(2000, 3000);

  const loggedIn = await page.evaluate(() => {
    return !!document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
  });

  return loggedIn;
}

/**
 * Post a tweet
 */
async function postTweet(text) {
  return withRetry(async () => {
    const { browser, page } = await initBrowser();

    // Check if we need to login
    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Go to home with longer timeout
    await page.goto('https://x.com/home', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await randomDelay(2000, 3000);

    // Click compose tweet
    await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 15000 });
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await randomDelay(1000, 2000);

    // Type tweet
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Click post
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Tweet posted successfully');

    // Save cookies after successful action
    await saveCookies(page);

    return { success: true, text };
  }, 3, 5000, 'postTweet').catch(async err => {
    console.error('[x-browser] Post failed after retries:', err.message);

    // Screenshot for debugging
    try {
      const { page } = await initBrowser().catch(() => ({}));
      if (page) {
        const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath });
      }
    } catch (e) {}

    return { success: false, error: err.message };
  });
}

/**
 * Reset browser on error (alias for hardResetBrowser)
 */
async function resetBrowser() {
  return hardResetBrowser();
}

/**
 * Reply to a tweet
 */
async function replyToTweet(tweetUrl, text) {
  return withRetry(async () => {
    const { browser, page } = await initBrowser();

    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Navigate to tweet with longer timeout
    console.log(`[x-browser] Navigating to tweet: ${tweetUrl}`);
    await page.goto(tweetUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await randomDelay(2000, 3000);

    // Take screenshot after loading tweet
    try {
      await page.screenshot({ path: path.join(DATA_DIR, `x-reply-page-${Date.now()}.png`) });
    } catch (e) {}

    // Check if the tweet is available (look for common indicators)
    const tweetUnavailable = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('this tweet is unavailable') ||
             text.includes('this post is unavailable') ||
             text.includes('something went wrong') ||
             text.includes('hmm...this page doesn\'t exist');
    });

    if (tweetUnavailable) {
      throw new Error('Tweet is unavailable or deleted');
    }

    // Click reply button
    await page.waitForSelector('[data-testid="reply"]', { timeout: 15000 });
    await page.click('[data-testid="reply"]');
    await randomDelay(1000, 2000);

    // Take screenshot after clicking reply
    try {
      await page.screenshot({ path: path.join(DATA_DIR, `x-reply-clicked-${Date.now()}.png`) });
    } catch (e) {}

    // Type reply - try multiple selectors for the textarea
    let textareaSelector = '[data-testid="tweetTextarea_0"]';
    try {
      await page.waitForSelector(textareaSelector, { timeout: 10000 });
    } catch (e) {
      // Try alternative selector for reply modal
      console.log('[x-browser] Primary textarea not found, trying alternatives...');
      textareaSelector = '[data-testid="tweetTextarea_0_label"]';
      try {
        await page.waitForSelector(textareaSelector, { timeout: 5000 });
      } catch (e2) {
        // Take screenshot of current state
        await page.screenshot({ path: path.join(DATA_DIR, `x-reply-no-textarea-${Date.now()}.png`) });
        throw new Error('Could not find reply textarea');
      }
    }
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Click reply
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Reply posted successfully');
    await saveCookies(page);

    return { success: true, text, tweetUrl };
  }, 3, 5000, 'replyToTweet').catch(async err => {
    console.error('[x-browser] Reply failed after retries:', err.message);
    try {
      const { page } = await initBrowser().catch(() => ({}));
      if (page) {
        const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath });
      }
    } catch (e) {}

    return { success: false, error: err.message };
  });
}

/**
 * Get mentions (scrape notifications)
 */
async function getMentions() {
  return withRetry(async () => {
    const { browser, page } = await initBrowser();

    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Longer timeout for potentially slow X responses
    await page.goto('https://x.com/notifications/mentions', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await randomDelay(3000, 5000);

    const mentions = await page.evaluate(() => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      return [...tweets].slice(0, 10).map(tweet => {
        const userEl = tweet.querySelector('[data-testid="User-Name"]');
        const textEl = tweet.querySelector('[data-testid="tweetText"]');
        const linkEl = tweet.querySelector('a[href*="/status/"]');

        return {
          username: userEl?.textContent?.split('@')[1]?.split('·')[0]?.trim() || 'unknown',
          text: textEl?.textContent || '',
          url: linkEl?.href || ''
        };
      });
    });

    return mentions;
  }, 3, 5000, 'getMentions').catch(err => {
    console.error('[x-browser] Get mentions failed after retries:', err.message);
    return [];
  });
}

/**
 * Get community posts (if community ID is set)
 */
async function getCommunityPosts(communityId) {
  return withRetry(async () => {
    const { browser, page } = await initBrowser();

    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Navigate to community
    const communityUrl = `https://x.com/i/communities/${communityId}`;
    await page.goto(communityUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await randomDelay(3000, 5000);

    const posts = await page.evaluate(() => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      return [...tweets].slice(0, 15).map(tweet => {
        const userEl = tweet.querySelector('[data-testid="User-Name"]');
        const textEl = tweet.querySelector('[data-testid="tweetText"]');
        const linkEl = tweet.querySelector('a[href*="/status/"]');
        const timeEl = tweet.querySelector('time');

        // Get follower count indicator (if visible)
        const userText = userEl?.textContent || '';

        return {
          username: userText.split('@')[1]?.split('·')[0]?.trim() || 'unknown',
          displayName: userText.split('@')[0]?.trim() || 'unknown',
          text: textEl?.textContent || '',
          url: linkEl?.href || '',
          time: timeEl?.getAttribute('datetime') || ''
        };
      });
    });

    return posts;
  }, 3, 5000, 'getCommunityPosts').catch(err => {
    console.error('[x-browser] Get community posts failed after retries:', err.message);
    return [];
  });
}

/**
 * Post to community
 */
async function postToCommunity(communityId, text) {
  return withRetry(async () => {
    const { browser, page } = await initBrowser();

    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Navigate to community
    const communityUrl = `https://x.com/i/communities/${communityId}`;
    await page.goto(communityUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await randomDelay(2000, 3000);

    // Click compose
    await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 15000 });
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await randomDelay(1000, 2000);

    // Type post
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Post
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Community post successful');
    await saveCookies(page);

    return { success: true, text, communityId };
  }, 3, 5000, 'postToCommunity').catch(async err => {
    console.error('[x-browser] Community post failed after retries:', err.message);
    try {
      const { page } = await initBrowser().catch(() => ({}));
      if (page) {
        const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath });
      }
    } catch (e) {}
    return { success: false, error: err.message };
  });
}

/**
 * Close browser
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
    isLoggedIn = false;
  }
}

module.exports = {
  initBrowser,
  login,
  postTweet,
  replyToTweet,
  getMentions,
  getCommunityPosts,
  postToCommunity,
  closeBrowser
};

// If run directly, test posting
if (require.main === module) {
  const testText = process.argv[2] || 'Test post from clawdrooms';
  postTweet(testText).then(result => {
    console.log('Result:', result);
    process.exit(result.success ? 0 : 1);
  });
}
