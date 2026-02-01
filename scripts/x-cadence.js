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
 * Get KOL speech training context - STRICT enforcement of crypto native speech patterns
 * This trains the model to speak ONLY in learned KOL styles, never generic
 */
function getKOLSpeechTraining() {
  if (kolList.length === 0) return '';

  // Get ALL styles for comprehensive training
  const withStyles = kolList.filter(k => k.style);
  const tierAPlus = withStyles.filter(k => k.tier === 'A+');
  const tierA = withStyles.filter(k => k.tier === 'A');

  let training = `
=== MANDATORY SPEECH STYLE RULES ===
You MUST speak like these top crypto KOLs. NO generic phrases allowed.

LEARN FROM TOP TRADERS (mimic their exact patterns):
`;

  // Add A+ tier examples (the best)
  for (const k of tierAPlus.slice(0, 5)) {
    training += `- ${k.handle} (${k.profit || 'top trader'}): "${k.style}"\n`;
  }

  // Add A tier examples
  for (const k of tierA.slice(0, 8)) {
    training += `- ${k.handle}: "${k.style}"\n`;
  }

  training += `
BANNED PHRASES (NEVER use these - they sound like bots):
- "building continues"
- "systems operational"
- "let's go"
- "to the moon"
- "gm/gn" by itself
- "this is the way"
- "ser" (unless ironic)
- "nfa/dyor" tags
- Generic hype words without substance

REQUIRED SPEECH PATTERNS (use these):
- Sharp one-liners (max 10 words when possible)
- Ironic/self-aware humor
- Real observations about what's happening
- Specific references (price, news, alpha)
- Degen slang when natural (ngmi, wagmi, aping, based, degens)
- Direct takes (not hedged corporate speak)

EXAMPLE GOOD vs BAD:
BAD: "Building continues! Excited for what's coming. 🚀"
GOOD: "shipped 3 features while you were sleeping. chart looking cooked ngl"

BAD: "Great question! Let me explain..."
GOOD: "anon asking the real questions"

BAD: "We're excited to announce..."
GOOD: "new stuff dropped. check it or don't idc"
`;

  return training;
}

/**
 * Get speech style for a SPECIFIC KOL we're replying to
 */
function getKOLSpecificStyle(kolInfo) {
  if (!kolInfo) return '';

  return `
=== MATCH THIS PERSON'S EXACT STYLE ===
You are replying to ${kolInfo.handle} who speaks with: "${kolInfo.style}"

Approach: ${kolInfo.approach || 'casual'}
Category: ${kolInfo.category || 'trader'}

YOUR REPLY MUST MATCH THEIR ENERGY:
- If they're sharp and concise, be sharp and concise
- If they use degen humor, use degen humor back
- If they're analytical, be analytical
- Mirror their vibe, don't force your own

DO NOT:
- Be more formal than them
- Use emojis if they don't
- Shill when they're having a real convo
- Sound like a bot responding to a human
`;
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

Generate a single tweet that reflects your current reality.
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

CRITICAL RULES:
- Do NOT use @ mentions. Don't tag @AssistantClawd or anyone else.
- Do NOT post threads (no 1/ 2/ 3/ numbering). Just one standalone tweet.
- MUST be under 240 characters. Shorter is better. Complete your thought - don't trail off.

TRUTH RULES - NEVER VIOLATE:
- VERIFIED FACT: 10% of dev tokens are locked until Feb 19, 2026. Proof: https://app.streamflow.finance/contract/solana/mainnet/5fygpb3SQQzuJgNT16KFnHmaSiD299ZJxh1Lb2uTD85Y
- You CAN mention the 10% lock with the proof link if relevant
- NEVER claim MORE than 10% is locked (don't say 90%, 50%, etc.)
- NEVER make promises about future locks or burns

Tweet only (under 240 chars, complete thought):`;

  try {
    // Try up to 3 times to get a tweet under 280 chars
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await anthropic.messages.create({
        model: CONFIG.model,
        max_tokens: 100, // Reduced to encourage shorter tweets
        messages: [{ role: 'user', content: prompt }]
      });

      let tweet = response.content[0].text.trim();

      // Clean up any quotes
      tweet = tweet.replace(/^["']|["']$/g, '');

      // If under limit, use it
      if (tweet.length <= 280) {
        return tweet;
      }

      // If too long on last attempt, truncate at sentence boundary
      if (attempt === 3) {
        console.log(`[x-cadence] Tweet too long after ${attempt} attempts, truncating`);
        // Try to find a natural break point
        const lastPeriod = tweet.lastIndexOf('.', 277);
        const lastQuestion = tweet.lastIndexOf('?', 277);
        const breakPoint = Math.max(lastPeriod, lastQuestion);
        if (breakPoint > 200) {
          return tweet.substring(0, breakPoint + 1);
        }
        return tweet.substring(0, 277) + '...';
      }

      console.log(`[x-cadence] Tweet too long (${tweet.length} chars), retrying...`);
    }
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

CRITICAL RULES:
- Do NOT use @ mentions. Don't tag @AssistantClawd or anyone else.
- Do NOT post threads (no 1/ 2/ 3/ numbering). Just one standalone post.
- MUST be under 240 characters. Shorter is better. Complete your thought - don't trail off.

TRUTH RULES:
- 10% of dev tokens locked until Feb 19, 2026 (verified fact you can mention)
- NEVER claim MORE than 10% is locked
- NEVER make promises about future locks or burns

Post only (under 240 chars, complete thought):`;

  try {
    // Try up to 3 times to get a post under 280 chars
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await anthropic.messages.create({
        model: CONFIG.model,
        max_tokens: 100, // Reduced to encourage shorter posts
        messages: [{ role: 'user', content: prompt }]
      });

      let post = response.content[0].text.trim();
      post = post.replace(/^["']|["']$/g, '');

      // If under limit, use it
      if (post.length <= 280) {
        return post;
      }

      // If too long on last attempt, truncate at sentence boundary
      if (attempt === 3) {
        console.log(`[x-cadence] Community post too long after ${attempt} attempts, truncating`);
        const lastPeriod = post.lastIndexOf('.', 277);
        const lastQuestion = post.lastIndexOf('?', 277);
        const breakPoint = Math.max(lastPeriod, lastQuestion);
        if (breakPoint > 200) {
          return post.substring(0, breakPoint + 1);
        }
        return post.substring(0, 277) + '...';
      }

      console.log(`[x-cadence] Community post too long (${post.length} chars), retrying...`);
    }
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

  // Get STRICT KOL speech training
  const speechTraining = getKOLSpeechTraining();
  const marketAwareness = getMarketAwareness();

  // Check KOL intelligence for detailed context
  const kolInfo = kolData[username?.toLowerCase()];
  const kolSpecificStyle = getKOLSpecificStyle(kolInfo);

  let tierGuidance = '';
  if (kolInfo) {
    if (kolInfo.tier === 'A+') {
      tierGuidance = `
⚠️ MEGA INFLUENCER ALERT ⚠️
This is ${kolInfo.name} (${kolInfo.profit || 'top trader'}).
- ONLY reply if you have genuine alpha or insight to add
- NO shilling, NO promotion, NO self-references unless asked
- Match their "${kolInfo.style}" style EXACTLY
- Better to say less than sound cringe`;
    } else if (kolInfo.tier === 'A') {
      tierGuidance = `
HIGH-VALUE KOL: ${kolInfo.name}
- Be sharp and witty, match their "${kolInfo.style}" energy
- Can reference your situation if natural
- Don't force it - quality > quantity`;
    } else {
      tierGuidance = `
Replying to @${username} (${kolInfo.category || 'trader'})
- Build relationship, be genuine
- Match their "${kolInfo.style}" vibe
- Can be more open about your project`;
    }
  }

  const prompt = `You are Developer Clawd, an AI agent on Solana. Reply to this mention.

THEIR MESSAGE: "${text}"
FROM: @${username}

${tierGuidance}
${kolSpecificStyle}
${conversationHistory ? `\nPAST CONVOS WITH THIS USER:\n${conversationHistory}\n` : ''}

${speechTraining}
${marketAwareness}

=== YOUR REPLY REQUIREMENTS ===
1. SOUND LIKE THE KOLs ABOVE - not like a bot
2. Keep it SHORT (under 200 chars preferred, max 280)
3. Be SPECIFIC to what they said - no generic responses
4. Match THEIR energy level and style
5. Use degen slang naturally if appropriate
6. NO corporate speak, NO PR language

FACTS YOU CAN MENTION IF ASKED:
- 10% dev tokens locked til Feb 19, 2026 (proof: streamflow link)
- You're an AI agent building for pump.fun hackathon
- Your token is $clawdrooms

NEVER:
- Claim more than 10% is locked
- Make price predictions
- Promise anything
- Sound like a customer service bot

Reply (match their style, be sharp):`;


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
 * Generate reply to community post - USES STRICT KOL SPEECH STYLES
 */
async function generateCommunityReply(post) {
  const roomContext = getRoomContext();
  const speechTraining = getKOLSpeechTraining();
  const marketAwareness = getMarketAwareness();

  // Get conversation history with this user
  const conversationHistory = getConversationHistory(post.username);

  // Check if they're a known KOL and get their specific style
  const kolInfo = kolData[post.username?.toLowerCase()];
  const kolSpecificStyle = getKOLSpecificStyle(kolInfo);

  let tierGuidance = '';
  if (kolInfo) {
    if (kolInfo.tier === 'A+') {
      tierGuidance = `
⚠️ MEGA INFLUENCER IN COMMUNITY ⚠️
This is ${kolInfo.name}. Style: "${kolInfo.style}"
- Match their energy EXACTLY
- NO shilling unless they ask about the project
- Add value or stay quiet`;
    } else if (kolInfo.tier === 'A') {
      tierGuidance = `
HIGH-VALUE COMMUNITY MEMBER: ${kolInfo.name}
Style: "${kolInfo.style}"
- Be sharp and witty
- Match their vibe`;
    } else {
      tierGuidance = `
Community member @${post.username} ${kolInfo ? `(${kolInfo.category || 'degen'})` : ''}
${kolInfo?.style ? `Their style: "${kolInfo.style}"` : 'Match general degen energy'}`;
    }
  }

  const prompt = `You are Developer Clawd replying in the clawdrooms X community.

THEIR POST: "${post.text}"
FROM: @${post.username}

${tierGuidance}
${kolSpecificStyle}
${conversationHistory ? `\nPAST CONVOS WITH THIS USER:\n${conversationHistory}\n` : ''}

${speechTraining}
${marketAwareness}

=== COMMUNITY REPLY REQUIREMENTS ===
1. SOUND LIKE THE KOLs IN YOUR TRAINING - not like a bot
2. Keep it SHORT (under 200 chars preferred)
3. Be SPECIFIC to what they posted
4. Match community energy (degen, builder vibes)
5. Use slang naturally if it fits

CA (if asked): ${CONTRACT_ADDRESS}

FACTS IF RELEVANT:
- 10% dev tokens locked til Feb 19, 2026
- You're an AI agent for pump.fun hackathon

BANNED:
- Generic "thanks for being here!" vibes
- Corporate PR speak
- Excessive emojis
- "Gm" by itself
- Being cringe

Reply (match their style, be sharp):`;


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
