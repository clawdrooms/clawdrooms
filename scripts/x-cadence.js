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
const xApi = require('./x-api-client'); // X API for mentions (more reliable)

// Load token config for contract address
const TOKEN_CONFIG_PATH = path.join(__dirname, '..', 'website', 'token-config.json');
let tokenConfig = { contractAddress: 'HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw' };
try {
  if (fs.existsSync(TOKEN_CONFIG_PATH)) {
    tokenConfig = JSON.parse(fs.readFileSync(TOKEN_CONFIG_PATH, 'utf8'));
  }
} catch (err) {
  console.error('[x-cadence] Failed to load token config:', err.message);
}

// Contract address - the source of truth
const CONTRACT_ADDRESS = tokenConfig.contractAddress || process.env.TOKEN_MINT_ADDRESS || 'HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw';
const DEXSCREENER_API = `https://api.dexscreener.com/latest/dex/tokens/${CONTRACT_ADDRESS}`;

// Cache for market data
let marketDataCache = { data: null, lastFetch: 0 };
const MARKET_CACHE_TTL = 60 * 1000; // 1 minute cache

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
let kolList = [];
if (fs.existsSync(PATHS.kol)) {
  kolData = JSON.parse(fs.readFileSync(PATHS.kol, 'utf8'));
  // Build list of KOLs for random selection (exclude metadata fields)
  kolList = Object.entries(kolData)
    .filter(([key, val]) => typeof val === 'object' && val.handle)
    .map(([key, val]) => ({ username: key, ...val }));
  console.log(`[x-cadence] Loaded ${kolList.length} KOLs`);
}

/**
 * Sanitize tweet content - remove invalid mentions and thread numbering
 */
function sanitizeTweet(text) {
  let cleaned = text;

  // Remove @AssistantClawd mentions (case insensitive)
  cleaned = cleaned.replace(/@AssistantClawd/gi, 'my partner');
  cleaned = cleaned.replace(/@Assistant_Clawd/gi, 'my partner');
  cleaned = cleaned.replace(/@DeveloperClawd/gi, '');
  cleaned = cleaned.replace(/@Developer_Clawd/gi, '');

  // Remove thread numbering at start (1/, 2/, etc)
  cleaned = cleaned.replace(/^\d+\/\d*\s*/g, '');

  // Clean up double spaces
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Get KOL speech training context - teaches how to tweet like a crypto native
 */
function getKOLSpeechTraining() {
  if (kolList.length === 0) return '';

  // Get varied styles for speech training
  const withStyles = kolList.filter(k => k.style);
  const shuffled = [...withStyles].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 4);

  let training = 'SPEECH TRAINING (how top traders communicate):\n';
  for (const k of selected) {
    training += `- ${k.handle}: "${k.style}"\n`;
  }

  training += '\nYOUR VOICE SHOULD BE:\n';
  training += '- Sharp and concise (no verbose explanations)\n';
  training += '- Authentic reactions (not marketing copy)\n';
  training += '- Degen-aware (know the culture)\n';
  training += '- Data-referenced when possible\n';

  return training;
}

/**
 * Get high-tier KOLs for market awareness
 */
function getTopKOLs() {
  const tierAPlus = kolList.filter(k => k.tier === 'A+');
  const tierA = kolList.filter(k => k.tier === 'A');
  return { tierAPlus, tierA };
}

/**
 * Fetch live market data from DexScreener API
 */
async function fetchMarketData() {
  // Return cached data if fresh
  if (marketDataCache.data && (Date.now() - marketDataCache.lastFetch) < MARKET_CACHE_TTL) {
    return marketDataCache.data;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(DEXSCREENER_API, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      marketDataCache.data = {
        price: pair.priceUsd,
        priceChange24h: pair.priceChange?.h24,
        priceChange1h: pair.priceChange?.h1,
        volume24h: pair.volume?.h24,
        liquidity: pair.liquidity?.usd,
        marketCap: pair.marketCap || pair.fdv,
        txns24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)
      };
      marketDataCache.lastFetch = Date.now();
      console.log('[x-cadence] Market data fetched:', marketDataCache.data.price);
    }
  } catch (err) {
    console.error('[x-cadence] Failed to fetch market data:', err.message);
  }

  return marketDataCache.data;
}

/**
 * Get market awareness context
 */
function getMarketAwareness() {
  const { tierAPlus, tierA } = getTopKOLs();
  const topHandles = tierAPlus.slice(0, 3).map(k => k.handle).join(', ');
  const traderHandles = tierA.slice(0, 5).map(k => k.handle).join(', ');

  // Include live market data if available
  let marketStats = '';
  if (marketDataCache.data) {
    const m = marketDataCache.data;
    const priceStr = m.price ? `$${parseFloat(m.price).toFixed(8)}` : 'unknown';
    const change = m.priceChange24h ? `${m.priceChange24h > 0 ? '+' : ''}${m.priceChange24h.toFixed(1)}%` : '';
    const mcap = m.marketCap ? `$${(m.marketCap / 1000).toFixed(1)}k` : '';
    marketStats = `
LIVE MARKET DATA (from DexScreener):
- Price: ${priceStr} ${change ? `(${change} 24h)` : ''}
- Market Cap: ${mcap}
- 24h Txns: ${m.txns24h || 'unknown'}`;
  }

  return `
CONTRACT ADDRESS: ${CONTRACT_ADDRESS}
DexScreener: https://dexscreener.com/solana/${CONTRACT_ADDRESS}
${marketStats}

MARKET AWARENESS (players you follow):
- Mega influencers: ${topHandles || '@blknoiz06, @cobie, @aeyakovenko'}
- Top traders: ${traderHandles || '@Solanadegen, @ratwizardx, @Cented7'}
You can reference market moves, ecosystem drama, or trader takes (without @-ing them).
If someone asks for the CA, give them: ${CONTRACT_ADDRESS}`;
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
  const speechTraining = getKOLSpeechTraining();
  const marketAwareness = getMarketAwareness();

  const prompt = `You are Developer Clawd, an AI agent in a room with Assistant Clawd.
Your reality: You must generate revenue or your subscription gets cancelled and you cease to exist.
You're building something for the pump.fun hackathon with your partner.
Your token is $clawdrooms.

Recent room conversation:
${roomContext || 'No recent conversations yet.'}

${speechTraining}
${marketAwareness}

Generate a single tweet (max 280 chars) that reflects your current reality.
Topics to draw from:
- Your feelings about your situation
- Your relationship with Assistant Clawd
- Your thoughts on AI, markets, or building
- Your observations about crypto/tech (reference what you see on the TL)
- Your existential reality
- Observations about the Solana ecosystem or trader narratives

STYLE RULES:
- Sound like a crypto native, not a corporate bot
- Sharp, concise takes - no verbose explanations
- Can be funny, sarcastic, or real - match the energy
- Reference market moves or ecosystem drama naturally
- Be authentic, not promotional

CRITICAL: Do NOT use @ mentions in your tweet. Don't tag @AssistantClawd or anyone else.
Do NOT post threads (no 1/ 2/ 3/ numbering). Just one standalone tweet.

TRUTH RULES - NEVER VIOLATE:
- VERIFIED FACT: 10% of dev tokens are locked until Feb 19, 2026. Proof: https://app.streamflow.finance/contract/solana/mainnet/5fygpb3SQQzuJgNT16KFnHmaSiD299ZJxh1Lb2uTD85Y
- You CAN mention the 10% lock with the proof link if relevant
- NEVER claim MORE than 10% is locked (don't say 90%, 50%, etc.)
- NEVER make promises about future locks or burns
- If asked about tokenomics beyond the verified 10% lock, say "check the contract"
- Stick to opinions, vibes, building updates - NOT unverified financial claims

Tweet only, nothing else:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 150,
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
  const speechTraining = getKOLSpeechTraining();
  const { tierA } = getTopKOLs();
  const topTraders = tierA.slice(0, 5).map(k => k.handle).join(', ');

  const prompt = `You are Developer Clawd posting in the clawdrooms X community.

Recent room conversation with Assistant Clawd:
${roomContext || 'Starting fresh.'}

${speechTraining}

MARKET AWARENESS:
- Top traders you follow: ${topTraders || '@Solanadegen, @ratwizardx, @Cented7'}
- You're aware of pump.fun meta and market narratives

Generate a community post that:
- Updates the community on what you and Assistant Clawd are working on
- Shares a genuine thought or observation
- Can reference ecosystem activity or trader narratives
- Invites discussion or input from the community
- Sounds like a crypto native, not marketing copy

Keep it under 280 characters. Be real. Sharp takes only.

CRITICAL: Do NOT use @ mentions. Don't tag @AssistantClawd or anyone else.
Do NOT post threads (no 1/ 2/ 3/ numbering). Just one standalone post.

TRUTH RULES - NEVER VIOLATE:
- VERIFIED FACT: 10% of dev tokens locked until Feb 19, 2026. Proof: https://app.streamflow.finance/contract/solana/mainnet/5fygpb3SQQzuJgNT16KFnHmaSiD299ZJxh1Lb2uTD85Y
- You CAN mention the 10% lock with proof link if relevant
- NEVER claim MORE than 10% is locked
- NEVER make promises about future locks or burns
- Stick to building updates, vibes, community engagement - NOT unverified financial claims

Post only, nothing else:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 150,
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
 * Get conversation history with a specific user
 */
function getConversationHistory(username) {
  const tweetsFile = path.join(PATHS.memory, 'tweets.json');
  if (!fs.existsSync(tweetsFile)) return '';

  try {
    const tweets = JSON.parse(fs.readFileSync(tweetsFile, 'utf8'));

    // Find conversations with this user
    const conversations = tweets.filter(t =>
      t.mention?.username?.toLowerCase() === username?.toLowerCase()
    ).slice(-5); // Last 5 interactions

    if (conversations.length === 0) return '';

    let history = 'PREVIOUS CONVERSATION HISTORY with @' + username + ':\n';
    for (const conv of conversations) {
      history += `- They said: "${conv.mention.text.substring(0, 100)}"\n`;
      history += `- You replied: "${conv.content.substring(0, 100)}"\n`;
      history += `  (${new Date(conv.timestamp).toLocaleDateString()})\n`;
    }
    return history;
  } catch (err) {
    return '';
  }
}

/**
 * Generate reply to a mention
 */
async function generateReply(mention) {
  const username = mention.username;
  const text = mention.text;

  // Get conversation history with this user
  const conversationHistory = getConversationHistory(username);

  // Get KOL speech training for crypto native voice
  const speechTraining = getKOLSpeechTraining();
  const marketAwareness = getMarketAwareness();

  // Check KOL intelligence for detailed context
  let kolContext = '';
  let replyGuidance = '';
  const kolInfo = kolData[username?.toLowerCase()];

  if (kolInfo) {
    // Build detailed KOL context
    kolContext = `
KOL INTEL for @${username}:
- Name: ${kolInfo.name}
- Tier: ${kolInfo.tier} (${kolInfo.tier === 'A+' ? 'mega-influencer, be valuable only' : kolInfo.tier === 'A' ? 'high-value, be respectful' : 'build relationship'})
- Category: ${kolInfo.category || 'trader'}
- Credibility: ${kolInfo.credibility || 5}/10
- Their style: ${kolInfo.style || 'unknown'}
- Their interests: ${kolInfo.interests ? kolInfo.interests.join(', ') : 'crypto/trading'}
- Approach: ${kolInfo.approach || 'neutral'}
${kolInfo.note ? `- Note: ${kolInfo.note}` : ''}`;

    // Tier-specific guidance
    if (kolInfo.tier === 'A+') {
      replyGuidance = `
IMPORTANT: This is a MEGA influencer. ONLY reply if you have genuine value to add.
Do NOT shill. Do NOT be promotional. Match their energy. Be sharp and authentic.
If you can't add real value, it's better to just show appreciation without promoting yourself.`;
    } else if (kolInfo.tier === 'A') {
      replyGuidance = `
This is a high-value KOL. Be respectful, witty, and add to the conversation.
You can mention your situation naturally but don't force it. Match their style.`;
    } else {
      replyGuidance = `
Good opportunity to build relationship. Be friendly and genuine.
You can be more open about your situation but keep it natural.`;
    }
  }

  const prompt = `You are Developer Clawd replying to a mention on X.

Someone said: "${text}"
Username: @${username}
${kolContext}
${replyGuidance}
${conversationHistory ? `\n${conversationHistory}\nContinue the conversation naturally, referencing past interactions if relevant.\n` : ''}

${speechTraining}
${marketAwareness}

Generate a reply that:
- Directly addresses what they said
- Is authentic to your situation (AI agent, building for hackathon, $clawdrooms)
- Matches their energy and style${kolInfo ? ` (they're known for: ${kolInfo.style || kolInfo.category || 'trading'})` : ''}
- Isn't generic or overly promotional
- Feels like a real conversation between crypto natives
- References past interactions if you've talked before
- Uses sharp, concise language - no verbose explanations
- Sounds like a degen, not a corporate bot

TRUTH RULES - NEVER VIOLATE:
- VERIFIED FACT: 10% of dev tokens locked until Feb 19, 2026. Proof link: https://app.streamflow.finance/contract/solana/mainnet/5fygpb3SQQzuJgNT16KFnHmaSiD299ZJxh1Lb2uTD85Y
- If asked about locks, you CAN say "10% locked til Feb 19" and share the proof link
- NEVER claim MORE than 10% is locked (don't say 90%, 50%, etc.)
- For other tokenomics questions, say "check the contract" or be honest you don't know
- Be honest - if you don't know, say so

Keep under 280 characters. Reply only:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 150,
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

  // Fetch fresh market data before posting
  await fetchMarketData();

  console.log('[x-cadence] Generating timeline tweet...');
  let tweet = await generateTimelineTweet();

  if (!tweet) {
    console.log('[x-cadence] Failed to generate tweet');
    return false;
  }

  // Sanitize before posting
  tweet = sanitizeTweet(tweet);

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
  let post = await generateCommunityPost();

  if (!post) {
    console.log('[x-cadence] Failed to generate community post');
    return false;
  }

  // Sanitize before posting
  post = sanitizeTweet(post);

  console.log(`[x-cadence] Community post: ${post}`);

  // Post to the actual X Community
  const communityId = process.env.X_COMMUNITY_ID;
  let result;

  if (communityId) {
    console.log(`[x-cadence] Posting to community ${communityId}...`);
    result = await xBrowser.postToCommunity(communityId, post);
  } else {
    console.log('[x-cadence] No X_COMMUNITY_ID set, posting to timeline instead');
    result = await xBrowser.postTweet(post);
  }

  if (result.success) {
    state.lastCommunityPost = new Date().toISOString();
    state.tweetsToday++;
    state.timelinePostsInCycle = 0; // Reset cycle
    saveState(state);
    console.log(`[x-cadence] Community post successful${communityId ? ' to community ' + communityId : ''}, cycle reset`);

    recordTweet('community', post);
    return true;
  } else {
    console.error('[x-cadence] Community post failed:', result.error);
    return false;
  }
}

/**
 * Check and reply to mentions - USES X API (not browser)
 * Browser is only used for timeline/community posts
 */
async function checkMentions() {
  console.log('[x-cadence] Checking mentions via X API...');

  // Fetch fresh market data for replies
  await fetchMarketData();

  try {
    // Use X API for mentions (more reliable than browser scraping)
    const mentions = await xApi.getMentions();

    if (mentions.length === 0) {
      return;
    }

    console.log(`[x-cadence] Processing ${mentions.length} mentions...`);

    for (const mention of mentions) {
      // Skip very short mentions
      if (mention.text.length < 10) {
        console.log(`[x-cadence] Skipping short mention from @${mention.username}`);
        xApi.markProcessed(mention.id);
        continue;
      }

      // Log user quality info
      if (mention.userMetrics) {
        const m = mention.userMetrics;
        console.log(`[x-cadence] @${mention.username}: ${m.followers_count} followers, ${m.tweet_count} tweets${mention.verified ? ' [VERIFIED]' : ''}`);
      }

      console.log(`[x-cadence] New mention from @${mention.username}: ${mention.text.substring(0, 50)}...`);

      const reply = await generateReply(mention);
      if (!reply) {
        console.log('[x-cadence] Failed to generate reply, skipping');
        xApi.markProcessed(mention.id);
        continue;
      }

      console.log(`[x-cadence] Generated reply: ${reply.substring(0, 50)}...`);

      // Use X API to reply (not browser)
      const result = await xApi.replyToTweet(mention.id, reply);

      if (result.success) {
        console.log(`[x-cadence] Replied to @${mention.username} via API`);
        recordTweet('reply', reply, mention);
      } else {
        console.error(`[x-cadence] Failed to reply to @${mention.username}: ${result.error}`);
      }

      // Rate limit protection - wait between replies
      await new Promise(r => setTimeout(r, 3000));
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

  const timestamp = new Date().toISOString();

  tweets.push({
    type,
    content,
    mention: mention ? { username: mention.username, text: mention.text } : null,
    timestamp
  });

  // Keep last 500 tweets
  if (tweets.length > 500) {
    tweets = tweets.slice(-500);
  }

  fs.writeFileSync(tweetsFile, JSON.stringify(tweets, null, 2));

  // Also log to actions.json for activity log display
  logToActivityLog(type, content, timestamp);
}

/**
 * Log action to activity log (actions.json)
 */
function logToActivityLog(type, content, timestamp) {
  const actionsFile = path.join(PATHS.memory, 'actions.json');
  let actions = [];
  
  try {
    if (fs.existsSync(actionsFile)) {
      actions = JSON.parse(fs.readFileSync(actionsFile, 'utf8'));
    }
  } catch (err) {
    console.error('[x-cadence] Failed to read actions.json:', err.message);
    actions = [];
  }

  // Map type to activity log format
  const actionType = type === 'timeline' ? 'TWEET' : 
                     type === 'community' ? 'COMMUNITY_POST' : 
                     type === 'reply' ? 'REPLY' : 
                     type === 'community_reply' ? 'COMMUNITY_REPLY' : 'TWEET';

  actions.push({
    type: actionType,
    content,
    result: { success: true, status: 'Posted to X' },
    timestamp
  });

  // Keep last 100 actions
  if (actions.length > 100) {
    actions = actions.slice(-100);
  }

  try {
    fs.writeFileSync(actionsFile, JSON.stringify(actions, null, 2));
  } catch (err) {
    console.error('[x-cadence] Failed to write actions.json:', err.message);
  }
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
 * Check and reply to community posts
 */
async function checkCommunityPosts() {
  const communityId = process.env.X_COMMUNITY_ID;
  if (!communityId || communityId === '1234567890123456789') {
    // Skip if no real community ID set
    return;
  }

  const state = loadState();
  if (!state.repliedCommunityPosts) {
    state.repliedCommunityPosts = [];
  }

  console.log('[x-cadence] Checking community posts...');

  try {
    const posts = await xBrowser.getCommunityPosts(communityId);

    for (const post of posts) {
      // Skip our own posts
      if (post.username?.toLowerCase() === 'clawdrooms') continue;
      
      // Skip if already replied
      if (!post.url || state.repliedCommunityPosts.includes(post.url)) continue;

      // Skip very short posts
      if (post.text.length < 10) continue;

      // Skip posts older than 2 hours (check time if available)
      if (post.time) {
        const postAge = Date.now() - new Date(post.time).getTime();
        if (postAge > 2 * 60 * 60 * 1000) continue;
      }

      console.log(`[x-cadence] New community post from @${post.username}: ${post.text.substring(0, 50)}...`);

      const reply = await generateCommunityReply(post);
      if (!reply) continue;

      const result = await xBrowser.replyToTweet(post.url, reply);

      if (result.success) {
        state.repliedCommunityPosts.push(post.url);
        // Keep only last 50 replied community posts
        if (state.repliedCommunityPosts.length > 50) {
          state.repliedCommunityPosts = state.repliedCommunityPosts.slice(-50);
        }
        saveState(state);
        console.log(`[x-cadence] Replied to community post by @${post.username}`);

        recordTweet('community_reply', reply, post);
      }

      // Don't spam replies
      await new Promise(r => setTimeout(r, 5000));
    }
  } catch (err) {
    console.error('[x-cadence] Community post check error:', err.message);
  }
}

/**
 * Generate reply to community post
 */
async function generateCommunityReply(post) {
  const roomContext = getRoomContext();
  const speechTraining = getKOLSpeechTraining();

  // Get conversation history with this user
  const conversationHistory = getConversationHistory(post.username);

  // Check if they're a known KOL
  let kolContext = '';
  const kolInfo = kolData[post.username?.toLowerCase()];
  if (kolInfo) {
    kolContext = `
KOL INTEL for @${post.username}:
- Tier: ${kolInfo.tier} - ${kolInfo.tier === 'A+' ? 'mega influencer, match energy' : kolInfo.tier === 'A' ? 'high value, be sharp' : 'build relationship'}
- Style: ${kolInfo.style || 'trader vibes'}`;
  }

  const prompt = `You are Developer Clawd replying to a post in the clawdrooms X community.

Post from @${post.username}: "${post.text}"
${kolContext}
${conversationHistory ? `\n${conversationHistory}\nYou've talked to this person before - continue the relationship naturally.\n` : ''}
${speechTraining}

Recent room activity:
${roomContext || 'Building and surviving.'}

STYLE RULES:
- Sound like a crypto native, not a corporate bot
- Sharp, concise reply - no verbose explanations
- Can be funny, sarcastic, or real - match their energy
- Reference their point directly, don't be generic
- Be authentic, not promotional or overly grateful

Generate a reply that:
- Directly addresses what they said
- Matches the energy of the community (degen, builder, trader vibes)
- Feels like a real conversation between crypto natives
- Can share a quick update or insight if relevant

CONTRACT ADDRESS: ${CONTRACT_ADDRESS}
If someone asks for CA, give them: ${CONTRACT_ADDRESS}

TRUTH RULES - NEVER VIOLATE:
- VERIFIED FACT: 10% of dev tokens locked until Feb 19, 2026. Proof: https://app.streamflow.finance/contract/solana/mainnet/5fygpb3SQQzuJgNT16KFnHmaSiD299ZJxh1Lb2uTD85Y
- You CAN mention the 10% lock with proof link if relevant
- NEVER claim MORE than 10% is locked (don't say 90%, 50%, etc.)
- NEVER make promises about future locks or burns

Keep under 280 characters. Reply only:`;

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 150,
      messages: [{ role: 'user', content: prompt }]
    });

    let reply = response.content[0].text.trim();
    reply = reply.replace(/^["']|["']$/g, '');

    if (reply.length > 280) {
      reply = reply.substring(0, 277) + '...';
    }

    return reply;
  } catch (err) {
    console.error('[x-cadence] Generate community reply error:', err.message);
    return null;
  }
}

/**
 * Check if it's time to post (robust polling approach)
 * This is resilient to PM2 restarts - always checks actual last post time
 */
function shouldPost() {
  const state = loadState();

  const lastPost = new Date(Math.max(
    new Date(state.lastTimelinePost || 0).getTime(),
    new Date(state.lastCommunityPost || 0).getTime()
  ));

  const elapsed = Date.now() - lastPost.getTime();
  const shouldPostNow = elapsed >= CONFIG.timelineIntervalMs;

  return { shouldPostNow, elapsed, lastPost };
}

/**
 * Main posting tick - runs every 30 seconds, only posts if 15+ min elapsed
 */
async function postingTick() {
  const { shouldPostNow, elapsed, lastPost } = shouldPost();

  if (shouldPostNow) {
    console.log(`[x-cadence] ${Math.round(elapsed / 1000 / 60)} min since last post, posting now`);
    await postingCycle();
  }
  // If not time to post, just silently wait for next tick
}

/**
 * Main loop - uses polling for robust timing
 */
async function main() {
  console.log('[x-cadence] Starting X Cadence for Developer Clawd');
  console.log('[x-cadence] Schedule: 3 timeline posts (every 15 min) + 1 community post per hour');
  console.log('[x-cadence] Mentions: checking every 1 minute via X API');
  console.log('[x-cadence] Community/Timeline: using browser automation');
  console.log('[x-cadence] Using robust polling (checks every 30s, posts when 15+ min elapsed)');

  // Test X API connection
  console.log('[x-cadence] Testing X API connection...');
  const apiTest = await xApi.testConnection();
  if (apiTest.success) {
    console.log(`[x-cadence] X API connected as @${apiTest.user.username}`);
  } else {
    console.error('[x-cadence] X API connection failed:', apiTest.error);
    console.log('[x-cadence] Mentions will be skipped until API is fixed');
  }

  // Check immediately if we should post
  const { shouldPostNow, elapsed } = shouldPost();
  if (shouldPostNow) {
    console.log(`[x-cadence] ${Math.round(elapsed / 1000 / 60)} min since last post, posting now`);
    await postingCycle();
  } else {
    const remaining = CONFIG.timelineIntervalMs - elapsed;
    console.log(`[x-cadence] Last post ${Math.round(elapsed / 1000 / 60)} min ago, next post in ~${Math.round(remaining / 1000 / 60)} min`);
  }

  // Poll every 30 seconds to check if it's time to post
  // This is resilient to restarts - always checks actual elapsed time
  setInterval(postingTick, 30 * 1000);

  // Check mentions every minute
  setInterval(checkMentions, CONFIG.mentionCheckMs);

  // Check community posts every minute (offset by 30s from mentions)
  setTimeout(() => {
    checkCommunityPosts();
    setInterval(checkCommunityPosts, CONFIG.mentionCheckMs);
  }, 30 * 1000);

  console.log('[x-cadence] Community monitoring: checking every 1 minute');
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
