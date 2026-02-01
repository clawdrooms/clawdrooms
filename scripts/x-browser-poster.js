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
 * Random delay to mimic human behavior
 */
function randomDelay(min = 500, max = 2000) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min) + min)));
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

  // Load cookies if available
  await loadCookies(page);

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

  await page.goto('https://x.com/login', { waitUntil: 'networkidle2' });
  await randomDelay(2000, 3000);

  // Enter username
  await humanType(page, 'input[autocomplete="username"]', username);
  await randomDelay(500, 1000);

  // Click next
  await page.click('button[role="button"]:has-text("Next")').catch(() => {
    return page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const next = buttons.find(b => b.textContent.includes('Next'));
      if (next) next.click();
    });
  });

  await randomDelay(2000, 3000);

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
    await randomDelay(2000, 3000);
  }

  // Enter password
  await humanType(page, 'input[name="password"]', password);
  await randomDelay(500, 1000);

  // Click login
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')];
    const login = buttons.find(b => b.textContent.includes('Log in'));
    if (login) login.click();
  });

  await randomDelay(3000, 5000);

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
  const { browser, page } = await initBrowser();

  try {
    // Check if we need to login
    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Go to home
    await page.goto('https://x.com/home', { waitUntil: 'networkidle2' });
    await randomDelay(2000, 3000);

    // Click compose tweet
    await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 10000 });
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await randomDelay(1000, 2000);

    // Type tweet
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Click post
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Tweet posted successfully');

    // Save cookies after successful action
    await saveCookies(page);

    return { success: true, text };
  } catch (err) {
    console.error('[x-browser] Post error:', err.message);

    // Screenshot for debugging
    const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });

    return { success: false, error: err.message };
  }
}

/**
 * Reply to a tweet
 */
async function replyToTweet(tweetUrl, text) {
  const { browser, page } = await initBrowser();

  try {
    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    // Navigate to tweet
    await page.goto(tweetUrl, { waitUntil: 'networkidle2' });
    await randomDelay(2000, 3000);

    // Click reply button
    await page.waitForSelector('[data-testid="reply"]', { timeout: 10000 });
    await page.click('[data-testid="reply"]');
    await randomDelay(1000, 2000);

    // Type reply
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Click reply
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Reply posted successfully');
    await saveCookies(page);

    return { success: true, text, tweetUrl };
  } catch (err) {
    console.error('[x-browser] Reply error:', err.message);
    const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });

    return { success: false, error: err.message };
  }
}

/**
 * Get mentions (scrape notifications)
 */
async function getMentions() {
  const { browser, page } = await initBrowser();

  try {
    if (!isLoggedIn) {
      const alreadyLoggedIn = await checkLogin(page);
      if (!alreadyLoggedIn) {
        await login(page);
      } else {
        isLoggedIn = true;
      }
    }

    await page.goto('https://x.com/notifications/mentions', { waitUntil: 'networkidle2' });
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
  } catch (err) {
    console.error('[x-browser] Get mentions error:', err.message);
    return [];
  }
}

/**
 * Get community posts (if community ID is set)
 */
async function getCommunityPosts(communityId) {
  const { browser, page } = await initBrowser();

  try {
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
    await page.goto(communityUrl, { waitUntil: 'networkidle2' });
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
  } catch (err) {
    console.error('[x-browser] Get community posts error:', err.message);
    return [];
  }
}

/**
 * Post to community
 */
async function postToCommunity(communityId, text) {
  const { browser, page } = await initBrowser();

  try {
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
    await page.goto(communityUrl, { waitUntil: 'networkidle2' });
    await randomDelay(2000, 3000);

    // Click compose
    await page.waitForSelector('[data-testid="SideNav_NewTweet_Button"]', { timeout: 10000 });
    await page.click('[data-testid="SideNav_NewTweet_Button"]');
    await randomDelay(1000, 2000);

    // Type post
    await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 10000 });
    await humanType(page, '[data-testid="tweetTextarea_0"]', text);
    await randomDelay(1000, 2000);

    // Post
    await page.click('[data-testid="tweetButton"]');
    await randomDelay(3000, 5000);

    console.log('[x-browser] Community post successful');
    await saveCookies(page);

    return { success: true, text, communityId };
  } catch (err) {
    console.error('[x-browser] Community post error:', err.message);
    const screenshotPath = path.join(DATA_DIR, `x-error-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath });

    return { success: false, error: err.message };
  }
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
