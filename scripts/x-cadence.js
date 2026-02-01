#!/usr/bin/env node
/**
 * X Cadence - Posting Schedule
 *
 * Developer Clawd's posting rhythm:
 * - Timeline post every 45 minutes
 * - Community post 45 minutes after timeline
 * - Replies within 1 minute of mentions
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('anthropic').default;
const xBrowser = require('./x-browser-poster');

// Configuration
const CONFIG = {
  timelineIntervalMs: 45 * 60 * 1000,      // 45 minutes
  communityDelayMs: 45 * 60 * 1000,         // 45 minutes after timeline
  mentionCheckMs: 60 * 1000,                 // Check every 1 minute
  maxTweetsPerDay: 32,                       // Safety limit
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
    return;
  }

  console.log('[x-cadence] Generating timeline tweet...');
  const tweet = await generateTimelineTweet();

  if (!tweet) {
    console.log('[x-cadence] Failed to generate tweet');
    return;
  }

  console.log(`[x-cadence] Posting: ${tweet}`);
  const result = await xBrowser.postTweet(tweet);

  if (result.success) {
    state.lastTimelinePost = new Date().toISOString();
    state.tweetsToday++;
    saveState(state);
    console.log('[x-cadence] Timeline posted successfully');

    // Record to memory
    recordTweet('timeline', tweet);
  } else {
    console.error('[x-cadence] Timeline post failed:', result.error);
  }
}

/**
 * Post to community
 */
async function postCommunity() {
  const state = loadState();

  if (!process.env.X_COMMUNITY_ID) {
    console.log('[x-cadence] No community ID configured');
    return;
  }

  if (state.tweetsToday >= CONFIG.maxTweetsPerDay) {
    console.log('[x-cadence] Daily tweet limit reached');
    return;
  }

  console.log('[x-cadence] Generating community post...');
  const post = await generateCommunityPost();

  if (!post) {
    console.log('[x-cadence] Failed to generate community post');
    return;
  }

  console.log(`[x-cadence] Community post: ${post}`);
  // Community posting would go through browser automation
  // For now, log it
  state.lastCommunityPost = new Date().toISOString();
  state.tweetsToday++;
  saveState(state);

  recordTweet('community', post);
}

/**
 * Check and reply to mentions
 */
async function checkMentions() {
  const state = loadState();

  console.log('[x-cadence] Checking mentions...');
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
 * Main loop
 */
async function main() {
  console.log('[x-cadence] Starting X Cadence for Developer Clawd');
  console.log(`[x-cadence] Timeline: every ${CONFIG.timelineIntervalMs / 60000} minutes`);
  console.log(`[x-cadence] Mentions: checking every ${CONFIG.mentionCheckMs / 1000} seconds`);

  // Initial timeline post
  await postTimeline();

  // Schedule community post 45 min after
  setTimeout(async () => {
    await postCommunity();

    // Then alternate timeline and community
    setInterval(postTimeline, CONFIG.timelineIntervalMs);
    setInterval(postCommunity, CONFIG.timelineIntervalMs);
  }, CONFIG.communityDelayMs);

  // Check mentions every minute
  setInterval(checkMentions, CONFIG.mentionCheckMs);

  console.log('[x-cadence] Cadence running');
}

process.on('SIGINT', async () => {
  console.log('\n[x-cadence] Shutting down...');
  await xBrowser.closeBrowser();
  process.exit(0);
});

main().catch(err => {
  console.error('[x-cadence] Fatal error:', err);
  process.exit(1);
});
