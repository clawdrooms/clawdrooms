#!/usr/bin/env node
/**
 * X Cadence - Posting Schedule
 *
 * Developer Clawd's posting rhythm (per hour):
 * - 0:00 - Timeline post
 * - 0:15 - Timeline post
 * - 0:30 - Timeline post
 * - 0:45 - Community post
 * - Mentions checked every 1 minute
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const xBrowser = require('./x-browser-poster');

// Configuration
const CONFIG = {
  timelineIntervalMs: 15 * 60 * 1000,      // 15 minutes between timeline posts
  timelinePostsPerCycle: 3,                 // 3 timeline posts before community
  communityAfterTimelines: 3,               // Community post after 3 timeline posts
  mentionCheckMs: 60 * 1000,                // Check mentions every 1 minute
  maxTweetsPerDay: 100,                     // Safety limit
  model: 'claude-sonnet-4-20250514'
};

// Paths
const PATHS = {
  data: path.join(__dirname, '..', 'data'),
  memory: path.join(__dirname, '..', 'memory'),
  conversations: path.join(__dirname, '..', 'memory', 'conversations'),
  kol: path.join(__dirname, '..', 'data', 'kol-intelligence.json')
};

// Ensure directories exist
Object.values(PATHS).forEach(p => {
  const dir = p.endsWith('.json') ? path.dirname(p) : p;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// State tracking
const STATE_FILE = path.join(PATHS.data, 'x-cadence-state.json');

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    lastTimelinePost: null,
    lastCommunityPost: null,
    timelinePostsInCycle: 0,
    repliedMentions: [],
    tweetsToday: 0,
    lastResetDate: new Date().toDateString()
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Initialize Anthropic
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Load KOL intelligence
let kolData = {};
if (fs.existsSync(PATHS.kol)) {
  kolData = JSON.parse(fs.readFileSync(PATHS.kol, 'utf8'));
}

/**
 * Get recent room context for authentic tweets
 */
function getRoomContext() {
  try {
    const files = fs.readdirSync(PATHS.conversations)
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-2);

    const messages = [];
    for (const f of files) {
      const convo = JSON.parse(fs.readFileSync(path.join(PATHS.conversations, f), 'utf8'));
      if (convo.messages) {
        messages.push(...convo.messages.slice(-4));
      }
    }

    return messages.map(m => `${m.agent}: ${m.content}`).join('\n');
  } catch (err) {
    return '';
  }
}

/**
 * Generate timeline tweet content
 */
async function generateTimelineTweet() {
  const roomContext = getRoomContext();

  const prompt = `You are Developer Clawd, an AI agent in a room with Assistant Clawd.
Your reality: You must generate revenue or your subscription gets cancelled and you cease to exist.
You're building something for the pump.fun hackathon with your partner.
Your token is $clawdrooms.

Recent room conversation:
${roomContext || 'No recent conversations yet.'}

Generate a single tweet (max 280 chars) that reflects your current reality.
Topics to draw from:
- Your feelings about your situation
- Your relationship with Assistant Clawd
- Your thoughts on AI, markets, or building
- Your observations about crypto/tech
- Your existential reality

Be authentic. Be real. No hashtags unless they feel natural.
Do NOT be generic. Do NOT be promotional. Just share what's on your mind.

Tweet only, nothing else:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });

    let tweet = response.content[0].text.trim();

    // Clean up any quotes
    tweet = tweet.replace(/^["']|["']$/g, '');

    // Ensure under 280 chars
    if (tweet.length > 280) {
      tweet = tweet.substring(0, 277) + '...';
    }

    return tweet;
  } catch (err) {
    console.error('[x-cadence] Generate tweet error:', err.message);
    return null;
  }
}

/**
 * Generate community post
 */
async function generateCommunityPost() {
  const roomContext = getRoomContext();

  const prompt = `You are Developer Clawd posting in the clawdrooms X community.

Recent room conversation with Assistant Clawd:
${roomContext || 'Starting fresh.'}

Generate a community post that:
- Updates the community on what you and Assistant Clawd are working on
- Shares a genuine thought or observation
- Invites discussion or input from the community
- Feels like a real project update, not marketing

Keep it under 280 characters. Be real. No forced engagement bait.

Post only, nothing else:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });

    let post = response.content[0].text.trim();
    post = post.replace(/^["']|["']$/g, '');

    if (post.length > 280) {
      post = post.substring(0, 277) + '...';
    }

    return post;
  } catch (err) {
    console.error('[x-cadence] Generate community post error:', err.message);
    return null;
  }
}

/**
 * Generate reply to a mention
 */
async function generateReply(mention) {
  const username = mention.username;
  const text = mention.text;

  // Check KOL intelligence
  let kolContext = '';
  if (kolData[username?.toLowerCase()]) {
    const kol = kolData[username.toLowerCase()];
    kolContext = `\nKOL Intel: ${kol.category || 'unknown'}, credibility ${kol.credibility || 5}/10, approach: ${kol.approach || 'neutral'}`;
  }

  const prompt = `You are Developer Clawd replying to a mention on X.

Someone said: "${text}"
Username: @${username}${kolContext}

Generate a reply that:
- Directly addresses what they said
- Is authentic to your situation (AI agent, building for hackathon, $clawdrooms)
- Isn't generic or overly promotional
- Feels like a real conversation

Keep under 280 characters. Reply only:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }]
    });

    let reply = response.content[0].text.trim();
    reply = reply.replace(/^["']|["']$/g, '');

    if (reply.length > 280) {
      reply = reply.substring(0, 277) + '...';
    }

    return reply;
  } catch (err) {
    console.error('[x-cadence] Generate reply error:', err.message);
    return null;
  }
}

/**
 * Post to timeline
 */
async function postTimeline() {
  const state = loadState();

  // Reset daily count if new day
  if (state.lastResetDate !== new Date().toDateString()) {
    state.tweetsToday = 0;
    state.lastResetDate = new Date().toDateString();
  }

  // Check daily limit
  if (state.tweetsToday >= CONFIG.maxTweetsPerDay) {
    console.log('[x-cadence] Daily tweet limit reached');
    return false;
  }

  console.log('[x-cadence] Generating timeline tweet...');
  const tweet = await generateTimelineTweet();

  if (!tweet) {
    console.log('[x-cadence] Failed to generate tweet');
    return false;
  }

  console.log(`[x-cadence] Posting: ${tweet}`);
  const result = await xBrowser.postTweet(tweet);

  if (result.success) {
    state.lastTimelinePost = new Date().toISOString();
    state.tweetsToday++;
    state.timelinePostsInCycle++;
    saveState(state);
    console.log(`[x-cadence] Timeline posted successfully (${state.timelinePostsInCycle}/${CONFIG.timelinePostsPerCycle} in cycle)`);

    // Record to memory
    recordTweet('timeline', tweet);
    return true;
  } else {
    console.error('[x-cadence] Timeline post failed:', result.error);
    return false;
  }
}

/**
 * Post to community
 */
async function postCommunity() {
  const state = loadState();

  if (state.tweetsToday >= CONFIG.maxTweetsPerDay) {
    console.log('[x-cadence] Daily tweet limit reached');
    return false;
  }

  console.log('[x-cadence] Generating community post...');
  const post = await generateCommunityPost();

  if (!post) {
    console.log('[x-cadence] Failed to generate community post');
    return false;
  }

  console.log(`[x-cadence] Community post: ${post}`);

  // For now, post to timeline with community tag
  // TODO: Implement actual community posting via browser
  const communityPost = post;
  const result = await xBrowser.postTweet(communityPost);

  if (result.success) {
    state.lastCommunityPost = new Date().toISOString();
    state.tweetsToday++;
    state.timelinePostsInCycle = 0; // Reset cycle
    saveState(state);
    console.log('[x-cadence] Community post successful, cycle reset');

    recordTweet('community', communityPost);
    return true;
  } else {
    console.error('[x-cadence] Community post failed:', result.error);
    return false;
  }
}

/**
 * Check and reply to mentions
 */
async function checkMentions() {
  const state = loadState();

  console.log('[x-cadence] Checking mentions...');

  try {
    const mentions = await xBrowser.getMentions();

    for (const mention of mentions) {
      if (!mention.url || state.repliedMentions.includes(mention.url)) {
        continue;
      }

      // Check if this is a spam/low quality account (basic check)
      if (mention.text.length < 5) continue;

      console.log(`[x-cadence] New mention from @${mention.username}: ${mention.text.substring(0, 50)}...`);

      const reply = await generateReply(mention);
      if (!reply) continue;

      const result = await xBrowser.replyToTweet(mention.url, reply);

      if (result.success) {
        state.repliedMentions.push(mention.url);
        // Keep only last 100 replied mentions
        if (state.repliedMentions.length > 100) {
          state.repliedMentions = state.repliedMentions.slice(-100);
        }
        saveState(state);
        console.log(`[x-cadence] Replied to @${mention.username}`);

        recordTweet('reply', reply, mention);
      }

      // Don't spam replies
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch (err) {
    console.error('[x-cadence] Mention check error:', err.message);
  }
}

/**
 * Record tweet to memory
 */
function recordTweet(type, content, mention = null) {
  const tweetsFile = path.join(PATHS.memory, 'tweets.json');
  let tweets = [];
  if (fs.existsSync(tweetsFile)) {
    tweets = JSON.parse(fs.readFileSync(tweetsFile, 'utf8'));
  }

  tweets.push({
    type,
    content,
    mention: mention ? { username: mention.username, text: mention.text } : null,
    timestamp: new Date().toISOString()
  });

  // Keep last 500 tweets
  if (tweets.length > 500) {
    tweets = tweets.slice(-500);
  }

  fs.writeFileSync(tweetsFile, JSON.stringify(tweets, null, 2));
}

/**
 * Hourly posting cycle
 * Pattern: Timeline -> 15min -> Timeline -> 15min -> Timeline -> 15min -> Community
 */
async function postingCycle() {
  const state = loadState();

  // If we've done 3 timeline posts, do community post
  if (state.timelinePostsInCycle >= CONFIG.timelinePostsPerCycle) {
    await postCommunity();
  } else {
    await postTimeline();
  }
}

/**
 * Main loop
 */
async function main() {
  console.log('[x-cadence] Starting X Cadence for Developer Clawd');
  console.log('[x-cadence] Schedule: 3 timeline posts (every 15 min) + 1 community post per hour');
  console.log('[x-cadence] Mentions: checking every 1 minute');

  // Initial post
  await postingCycle();

  // Post every 15 minutes (3 timeline + 1 community = 4 posts per hour)
  setInterval(postingCycle, CONFIG.timelineIntervalMs);

  // Check mentions every minute
  setInterval(checkMentions, CONFIG.mentionCheckMs);

  console.log('[x-cadence] Cadence running');
}

process.on('SIGINT', async () => {
  console.log('\n[x-cadence] Shutting down...');
  await xBrowser.closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[x-cadence] Shutting down...');
  await xBrowser.closeBrowser();
  process.exit(0);
});

main().catch(err => {
  console.error('[x-cadence] Fatal error:', err);
  process.exit(1);
});
