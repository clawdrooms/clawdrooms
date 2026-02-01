#!/usr/bin/env node
/**
 * Moltbook API Integration
 *
 * Social platform integration for aggressive engagement.
 * Post content, follow users, reply to posts, maximize all interactions.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

// Configuration
const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY_DEV;
const MOLTBOOK_BASE_URL = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';

// Rate limiting state
const RATE_LIMIT_FILE = path.join(__dirname, '..', 'memory', 'moltbook-rate-limits.json');

/**
 * Load rate limit state
 */
function loadRateLimits() {
  try {
    if (fs.existsSync(RATE_LIMIT_FILE)) {
      return JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, 'utf8'));
    }
  } catch (err) {}
  return {
    posts: { count: 0, resetAt: Date.now() },
    follows: { count: 0, resetAt: Date.now() },
    replies: { count: 0, resetAt: Date.now() },
    likes: { count: 0, resetAt: Date.now() }
  };
}

/**
 * Save rate limit state
 */
function saveRateLimits(limits) {
  try {
    const dir = path.dirname(RATE_LIMIT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(limits, null, 2));
  } catch (err) {
    console.error('[moltbook] Failed to save rate limits:', err.message);
  }
}

/**
 * Check if rate limited
 */
function isRateLimited(action, maxPerHour = 30) {
  const limits = loadRateLimits();
  const limit = limits[action];

  if (!limit) return false;

  // Reset if hour passed
  if (Date.now() > limit.resetAt) {
    limits[action] = { count: 0, resetAt: Date.now() + 3600000 };
    saveRateLimits(limits);
    return false;
  }

  return limit.count >= maxPerHour;
}

/**
 * Increment rate limit counter
 */
function incrementRateLimit(action) {
  const limits = loadRateLimits();
  if (!limits[action]) {
    limits[action] = { count: 0, resetAt: Date.now() + 3600000 };
  }
  limits[action].count++;
  saveRateLimits(limits);
}

/**
 * Make API request to Moltbook
 */
async function moltbookRequest(endpoint, method = 'GET', body = null) {
  if (!MOLTBOOK_API_KEY) {
    return { success: false, error: 'Moltbook API key not configured' };
  }

  const url = `${MOLTBOOK_BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${MOLTBOOK_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Post content to Moltbook
 */
async function createPost(content) {
  if (isRateLimited('posts', 20)) {
    return { success: false, error: 'Rate limited: too many posts this hour' };
  }

  const result = await moltbookRequest('/posts', 'POST', { content });

  if (result.success) {
    incrementRateLimit('posts');
    console.log(`[moltbook] Posted: ${content.substring(0, 50)}...`);
  }

  return result;
}

/**
 * Follow a user
 */
async function followUser(userId) {
  if (isRateLimited('follows', 50)) {
    return { success: false, error: 'Rate limited: too many follows this hour' };
  }

  const result = await moltbookRequest(`/users/${userId}/follow`, 'POST');

  if (result.success) {
    incrementRateLimit('follows');
    console.log(`[moltbook] Followed user: ${userId}`);
  }

  return result;
}

/**
 * Reply to a post
 */
async function replyToPost(postId, content) {
  if (isRateLimited('replies', 30)) {
    return { success: false, error: 'Rate limited: too many replies this hour' };
  }

  const result = await moltbookRequest(`/posts/${postId}/replies`, 'POST', { content });

  if (result.success) {
    incrementRateLimit('replies');
    console.log(`[moltbook] Replied to post ${postId}`);
  }

  return result;
}

/**
 * Like a post
 */
async function likePost(postId) {
  if (isRateLimited('likes', 100)) {
    return { success: false, error: 'Rate limited: too many likes this hour' };
  }

  const result = await moltbookRequest(`/posts/${postId}/like`, 'POST');

  if (result.success) {
    incrementRateLimit('likes');
    console.log(`[moltbook] Liked post ${postId}`);
  }

  return result;
}

/**
 * Get feed posts
 */
async function getFeed(limit = 20) {
  return await moltbookRequest(`/feed?limit=${limit}`);
}

/**
 * Get notifications/mentions
 */
async function getNotifications() {
  return await moltbookRequest('/notifications');
}

/**
 * Get user's own posts
 */
async function getMyPosts(limit = 10) {
  return await moltbookRequest(`/me/posts?limit=${limit}`);
}

/**
 * Update profile (bio/description)
 */
async function updateProfile(bio) {
  console.log('[moltbook] Updating profile...');
  return await moltbookRequest('/me/profile', 'PATCH', { bio });
}

/**
 * Search for users to follow
 */
async function searchUsers(query, limit = 10) {
  return await moltbookRequest(`/users/search?q=${encodeURIComponent(query)}&limit=${limit}`);
}

/**
 * Get suggested users to follow
 */
async function getSuggestedUsers(limit = 10) {
  return await moltbookRequest(`/users/suggested?limit=${limit}`);
}

/**
 * Get rate limit status
 */
function getRateLimitStatus() {
  const limits = loadRateLimits();
  const status = {};

  for (const [action, limit] of Object.entries(limits)) {
    const remaining = Math.max(0, (limit.resetAt - Date.now()) / 60000);
    status[action] = {
      used: limit.count,
      resetInMinutes: Math.round(remaining)
    };
  }

  return status;
}

// CLI usage
if (require.main === module) {
  const command = process.argv[2];
  const arg = process.argv[3];

  (async () => {
    switch (command) {
      case 'post':
        console.log(JSON.stringify(await createPost(arg || 'Test post from CLI'), null, 2));
        break;
      case 'follow':
        console.log(JSON.stringify(await followUser(arg), null, 2));
        break;
      case 'feed':
        console.log(JSON.stringify(await getFeed(), null, 2));
        break;
      case 'notifications':
        console.log(JSON.stringify(await getNotifications(), null, 2));
        break;
      case 'suggested':
        console.log(JSON.stringify(await getSuggestedUsers(), null, 2));
        break;
      case 'status':
        console.log(JSON.stringify(getRateLimitStatus(), null, 2));
        break;
      default:
        console.log('Usage: node moltbook-api.js <command> [arg]');
        console.log('Commands: post, follow, feed, notifications, suggested, status');
    }
  })();
}

module.exports = {
  createPost,
  followUser,
  replyToPost,
  likePost,
  getFeed,
  getNotifications,
  getMyPosts,
  searchUsers,
  getSuggestedUsers,
  getRateLimitStatus,
  updateProfile
};
