#!/usr/bin/env node
/**
 * X API Client - Uses Twitter API v2 for mentions and replies
 *
 * Browser automation is kept for timeline/community posts (more reliable for those)
 * API is used for mentions and mention replies (faster, more reliable for these)
 */

require('dotenv').config();
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

// Initialize Twitter API client with OAuth 1.0a (user context)
const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

// Read-write client
const rwClient = client.readWrite;

// Our user ID (extracted from access token: 2017520782578974720)
const MY_USER_ID = '2017520782578974720';

// State file for tracking last mention ID
const STATE_FILE = path.join(__dirname, '..', 'data', 'x-api-state.json');

// In-memory rate limit tracking (persisted to state file)
let rateLimitUntil = 0;

function loadApiState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Restore rate limit from state
      if (state.rateLimitUntil && state.rateLimitUntil > Date.now()) {
        rateLimitUntil = state.rateLimitUntil;
      }
      return state;
    }
  } catch (err) {
    console.error('[x-api] Failed to load state:', err.message);
  }
  return { lastMentionId: null, processedMentions: [], rateLimitUntil: 0 };
}

/**
 * Check if we're currently rate limited
 */
function isRateLimited() {
  if (rateLimitUntil > Date.now()) {
    const waitMins = Math.ceil((rateLimitUntil - Date.now()) / 60000);
    console.log(`[x-api] Skipping - rate limited for ${waitMins} more minutes`);
    return true;
  }
  return false;
}

/**
 * Set rate limit backoff
 */
function setRateLimitBackoff(resetTime) {
  // If we have a reset time from the API, use it + 1 minute buffer
  if (resetTime) {
    rateLimitUntil = (resetTime * 1000) + 60000;
  } else {
    // Default: back off for 15 minutes
    rateLimitUntil = Date.now() + (15 * 60 * 1000);
  }

  // Save to state
  const state = loadApiState();
  state.rateLimitUntil = rateLimitUntil;
  saveApiState(state);

  const waitMins = Math.ceil((rateLimitUntil - Date.now()) / 60000);
  console.log(`[x-api] Rate limit backoff set for ${waitMins} minutes`);
}

function saveApiState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[x-api] Failed to save state:', err.message);
  }
}

/**
 * Check if an account appears to be spam/low-quality
 * Returns { isSpam: boolean, reason: string }
 */
function checkAccountQuality(user) {
  const reasons = [];

  // Account age check (created within last 30 days = suspicious)
  if (user.created_at) {
    const accountAge = Date.now() - new Date(user.created_at).getTime();
    const daysOld = accountAge / (1000 * 60 * 60 * 24);
    if (daysOld < 30) {
      reasons.push('account < 30 days old');
    }
  }

  // Follower count check (very low = likely spam)
  if (user.public_metrics) {
    const { followers_count, following_count, tweet_count } = user.public_metrics;

    // Less than 10 followers
    if (followers_count < 10) {
      reasons.push(`only ${followers_count} followers`);
    }

    // Following way more than followers (follow-bait pattern)
    if (following_count > 0 && followers_count > 0) {
      const ratio = following_count / followers_count;
      if (ratio > 10 && followers_count < 50) {
        reasons.push(`suspicious follow ratio ${following_count}/${followers_count}`);
      }
    }

    // Very few tweets
    if (tweet_count < 5) {
      reasons.push(`only ${tweet_count} tweets`);
    }
  }

  // Default profile (no pfp, no bio)
  if (user.default_profile && user.default_profile_image) {
    reasons.push('default profile');
  }

  // No bio
  if (!user.description || user.description.trim().length < 5) {
    reasons.push('no bio');
  }

  // Username patterns common in spam
  const username = user.username?.toLowerCase() || '';
  if (/\d{6,}$/.test(username)) {
    reasons.push('numeric username suffix');
  }

  // If 2+ red flags, mark as spam
  const isSpam = reasons.length >= 2;

  return {
    isSpam,
    reason: reasons.join(', '),
    score: reasons.length
  };
}

/**
 * Get mentions using X API v2
 * Returns array of mention objects with user info for quality filtering
 */
async function getMentions() {
  // Check rate limit before making API call
  if (isRateLimited()) {
    return [];
  }

  const state = loadApiState();

  try {
    const options = {
      max_results: 20,
      'tweet.fields': ['created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id', 'text'],
      'user.fields': ['created_at', 'public_metrics', 'description', 'verified', 'username', 'name', 'default_profile', 'default_profile_image'],
      expansions: ['author_id', 'in_reply_to_user_id']
    };

    // Only fetch mentions newer than our last processed one
    if (state.lastMentionId) {
      options.since_id = state.lastMentionId;
    }

    console.log('[x-api] Fetching mentions...');
    const mentions = await rwClient.v2.userMentionTimeline(MY_USER_ID, options);

    if (!mentions.data?.data || mentions.data.data.length === 0) {
      console.log('[x-api] No new mentions');
      return [];
    }

    // Build user lookup from includes
    const users = {};
    if (mentions.data.includes?.users) {
      for (const user of mentions.data.includes.users) {
        users[user.id] = user;
      }
    }

    const results = [];
    const tweets = mentions.data.data;

    // Update last mention ID to newest
    if (tweets.length > 0) {
      state.lastMentionId = tweets[0].id;
      saveApiState(state);
    }

    for (const tweet of tweets) {
      // Skip if already processed
      if (state.processedMentions.includes(tweet.id)) {
        continue;
      }

      const user = users[tweet.author_id] || {};

      // Check account quality
      const qualityCheck = checkAccountQuality(user);

      if (qualityCheck.isSpam) {
        console.log(`[x-api] Skipping spam account @${user.username}: ${qualityCheck.reason}`);
        // Mark as processed so we don't check again
        state.processedMentions.push(tweet.id);
        if (state.processedMentions.length > 200) {
          state.processedMentions = state.processedMentions.slice(-200);
        }
        saveApiState(state);
        continue;
      }

      results.push({
        id: tweet.id,
        text: tweet.text,
        username: user.username,
        name: user.name,
        authorId: tweet.author_id,
        conversationId: tweet.conversation_id,
        inReplyToUserId: tweet.in_reply_to_user_id,
        createdAt: tweet.created_at,
        url: `https://x.com/${user.username}/status/${tweet.id}`,
        userMetrics: user.public_metrics,
        qualityScore: qualityCheck.score,
        verified: user.verified || false
      });
    }

    console.log(`[x-api] Found ${results.length} quality mentions`);
    return results;

  } catch (err) {
    // Handle rate limiting with proper backoff
    if (err.code === 429 || err.rateLimit) {
      setRateLimitBackoff(err.rateLimit?.reset);
      return [];
    }

    console.error('[x-api] Failed to get mentions:', err.message);
    return [];
  }
}

/**
 * Reply to a tweet using X API v2
 */
async function replyToTweet(tweetId, text) {
  // Check rate limit before making API call
  if (isRateLimited()) {
    return { success: false, error: 'Rate limited - backing off' };
  }

  const state = loadApiState();

  try {
    console.log(`[x-api] Replying to tweet ${tweetId}...`);

    const result = await rwClient.v2.reply(text, tweetId);

    // Mark as processed
    state.processedMentions.push(tweetId);
    if (state.processedMentions.length > 200) {
      state.processedMentions = state.processedMentions.slice(-200);
    }
    saveApiState(state);

    console.log(`[x-api] Reply posted: ${result.data.id}`);

    return {
      success: true,
      tweetId: result.data.id,
      text: result.data.text
    };

  } catch (err) {
    // Handle rate limiting with proper backoff
    if (err.code === 429 || err.rateLimit) {
      setRateLimitBackoff(err.rateLimit?.reset);
      return { success: false, error: 'Rate limited - backing off' };
    }

    // Handle duplicate tweet
    if (err.code === 187 || err.message?.includes('duplicate')) {
      console.log('[x-api] Duplicate tweet, marking as processed');
      state.processedMentions.push(tweetId);
      saveApiState(state);
      return { success: false, error: 'Duplicate tweet' };
    }

    console.error('[x-api] Failed to reply:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Mark a mention as processed without replying
 */
function markProcessed(tweetId) {
  const state = loadApiState();
  if (!state.processedMentions.includes(tweetId)) {
    state.processedMentions.push(tweetId);
    if (state.processedMentions.length > 200) {
      state.processedMentions = state.processedMentions.slice(-200);
    }
    saveApiState(state);
  }
}

/**
 * Test API connection
 */
async function testConnection() {
  try {
    const me = await rwClient.v2.me();
    console.log(`[x-api] Connected as @${me.data.username} (ID: ${me.data.id})`);
    return { success: true, user: me.data };
  } catch (err) {
    console.error('[x-api] Connection test failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getMentions,
  replyToTweet,
  markProcessed,
  testConnection,
  checkAccountQuality
};
