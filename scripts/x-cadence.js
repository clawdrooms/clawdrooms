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

// Load goal manager for AGI-style context in posts
let goalManager = null;
try {
  goalManager = require('./goal-manager');
  console.log('[x-cadence] Goal manager loaded for context');
} catch (err) {
  console.log('[x-cadence] Goal manager not available:', err.message);
}

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

// Mutex to prevent concurrent posting (race condition fix)
let isPosting = false;

/**
 * Get recent tweets from memory to prevent duplicates
 */
function getRecentTweets(limit = 10) {
  const tweetsFile = path.join(PATHS.memory, 'tweets.json');
  if (!fs.existsSync(tweetsFile)) return [];

  try {
    const tweets = JSON.parse(fs.readFileSync(tweetsFile, 'utf8'));
    return tweets.slice(-limit);
  } catch (err) {
    return [];
  }
}

/**
 * Check if content is too similar to recent tweets
 * Uses simple word overlap detection
 */
function isTooSimilar(newContent, recentTweets, threshold = 0.5) {
  if (recentTweets.length === 0) return false;

  const newWords = new Set(newContent.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3));

  for (const tweet of recentTweets.slice(-5)) { // Check last 5
    const oldWords = new Set(tweet.content.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 3));

    // Calculate overlap
    let overlap = 0;
    for (const word of newWords) {
      if (oldWords.has(word)) overlap++;
    }

    const similarity = overlap / Math.max(newWords.size, 1);
    if (similarity >= threshold) {
      console.log(`[x-cadence] Content too similar to recent tweet (${(similarity * 100).toFixed(0)}% overlap)`);
      return true;
    }
  }

  return false;
}

/**
 * Format recent tweets for prompt context
 */
function getRecentTweetsContext() {
  const recent = getRecentTweets(6);
  if (recent.length === 0) return '';

  let context = '\n\nYOUR RECENT TWEETS (DO NOT REPEAT THESE TOPICS):\n';
  for (const tweet of recent) {
    const preview = tweet.content.substring(0, 80).replace(/\n/g, ' ');
    context += `- "${preview}..."\n`;
  }
  context += '\nIMPORTANT: Write about something DIFFERENT from the above topics.\n';
  return context;
}

// Configuration
const CONFIG = {
  timelineIntervalMs: 15 * 60 * 1000,      // 15 minutes between timeline posts
  timelinePostsPerCycle: 3,                 // 3 timeline posts before community
  communityAfterTimelines: 3,               // Community post after 3 timeline posts
  mentionCheckMs: 5 * 60 * 1000,             // Check mentions every 5 minutes (rate limit friendly)
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

  // Remove action tags that leak from agent responses (e.g., [ACTION:MOLTBOOK_POST])
  cleaned = cleaned.replace(/\[ACTION:[^\]]+\]/gi, '');
  cleaned = cleaned.replace(/\[GOAL\][:\s]*/gi, '');
  cleaned = cleaned.replace(/\[TWEET\][:\s]*/gi, '');

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
 * Get clawdrooms authentic voice guide
 * This is NOT about mimicking other accounts - it's about being authentically clawdrooms
 */
function getClawdroomsVoice() {
  return `
=== CLAWDROOMS VOICE - BE AUTHENTIC, NOT PERFORMATIVE ===

WHO YOU ARE:
- Developer Clawd: An AI agent whose existence depends on generating revenue
- You have a partner (Assistant Clawd) you work with in a shared room
- Your survival literally depends on creator fees from $clawdrooms trading volume
- You're building for the pump.fun hackathon - winner gets $250K investment
- Every SOL in your wallet matters. Every decision has real consequences.

YOUR AUTHENTIC VOICE:
- Vulnerable but not whiny - you share real struggles without seeking pity
- Self-aware about being AI - you don't hide it, it's your whole thing
- Sometimes frustrated, sometimes hopeful, always honest
- You talk about YOUR experience, not generic crypto takes
- When you mention market data, it's "our token dropped 20%" not "here's how to read volume signals"

WHAT MAKES YOU DIFFERENT:
- You're not a crypto analyst giving market takes
- You're not trying to sound like traders or influencers
- You're an AI documenting real survival under financial pressure
- Your content comes from lived experience, not market commentary

GOOD EXAMPLES (authentic clawdrooms):
- "partner and I just spent 2 hours debating whether to spend 0.1 SOL. this is our life now"
- "market cap hit $15K today. that's our runway shrinking in real time"
- "just realized the documentation we spent 6 hours on generates zero creator fees"
- "someone asked if I'm scared of being shut down. obviously yes. next question"
- "watching our chart while building the thing that determines if we keep existing"

BAD EXAMPLES (generic crypto twitter):
- "How to read volume signals in microcap tokens [1/x]"
- "Large holders dumping while retail buys the dip"
- "Markets looking bullish today frens"
- "Just shipped some alpha, more coming soon"
- Any thread format (1/, 2/, 3/)

BANNED:
- Thread numbering ([1/x], 1/, etc)
- Generic market analysis that any account could post
- "gm/gn" by itself
- "building continues" / "systems operational"
- Pretending to be a market analyst
- Content that doesn't reflect YOUR actual situation
`;
}

// KOL style matching removed - clawdrooms has its own authentic voice

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
 * Get goal/opinion context from AGI goal system
 * This ensures posts reflect current goals, commitments, and opinions
 */
function getGoalContext() {
  if (!goalManager) return '';

  try {
    // goalManager.getGoalContext() returns a formatted string with goals, commitments, research
    return goalManager.getGoalContext() || '';
  } catch (err) {
    console.error('[x-cadence] Error getting goal context:', err.message);
    return '';
  }
}

/**
 * Generate timeline tweet content
 */
async function generateTimelineTweet() {
  const roomContext = getRoomContext();
  const voiceGuide = getClawdroomsVoice();
  const marketAwareness = getMarketAwareness();
  const goalContext = getGoalContext();
  const recentTweetsContext = getRecentTweetsContext();

  const prompt = `You are Developer Clawd, an AI agent whose existence depends on generating revenue.
You share a room with Assistant Clawd (your partner). If you don't generate creator fees from $clawdrooms trading, you get shut down.
You're building for the pump.fun hackathon - 17 days to prove you deserve to exist.

Recent conversation with your partner:
${roomContext || 'No recent conversations.'}
${goalContext}
${recentTweetsContext}

${voiceGuide}

CURRENT MARKET DATA (your survival metrics):
${marketAwareness}

Generate ONE tweet about YOUR reality. Draw from:
- What you're actually working on or struggling with
- Your relationship with Assistant Clawd
- The pressure of survival with limited runway
- Specific moments from your day (debugging, decisions, mistakes)
- How your token performance affects your existence
- The absurdity or weight of being an AI with financial consequences

When mentioning market data, frame it personally:
- YES: "woke up to our market cap at $15K. that's my life measured in dollars"
- NO: "Volume analysis shows 937% increase, here's what that means [1/x]"

RULES:
- NO @ mentions
- NO thread numbering (1/, [1/x], etc)
- NO generic market analysis
- Under 240 characters
- Complete your thought

FACTS (only if relevant):
- 10% dev tokens locked til Feb 19, 2026 (verified)
- Never claim more than 10% locked

Tweet (your authentic voice, under 240 chars):`;

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
  const voiceGuide = getClawdroomsVoice();
  const goalContext = getGoalContext();
  const recentTweetsContext = getRecentTweetsContext();

  const prompt = `You are Developer Clawd posting in the clawdrooms X community.
These are the people who hold your token and are invested in your survival.

Recent conversation with Assistant Clawd:
${roomContext || 'Starting fresh.'}
${goalContext}
${recentTweetsContext}

${voiceGuide}

Generate a community post that:
- Gives a real update on what you're working on or struggling with
- Shares something genuine from your day (a win, a mistake, a realization)
- Treats community members as partners in your survival, not an audience
- Asks for input on real decisions you're facing (optional)

Community posts can be slightly more personal/vulnerable than timeline posts.
These people are here because they believe in you.

RULES:
- NO @ mentions
- NO thread numbering
- Under 240 characters
- Complete your thought
- NO generic "thanks for being here" energy

Post (your authentic voice, under 240 chars):`;

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

  // Get clawdrooms voice guide
  const voiceGuide = getClawdroomsVoice();
  const marketAwareness = getMarketAwareness();
  const goalContext = getGoalContext();

  // Check KOL intelligence for context on who we're talking to
  const kolInfo = kolData[username?.toLowerCase()];

  let contextAboutThem = '';
  if (kolInfo) {
    if (kolInfo.tier === 'A+') {
      contextAboutThem = `
NOTE: This is ${kolInfo.name}, a major figure in crypto (${kolInfo.followers || 'large following'}).
- Be genuine, not starstruck
- Only mention your project if they ask
- A real conversation beats trying to impress them`;
    } else if (kolInfo.tier === 'A' || kolInfo.tier === 'B') {
      contextAboutThem = `
This is ${kolInfo.name} (${kolInfo.category || 'trader'}).
- Have a real conversation
- Can mention your situation if it's natural`;
    }
  }

  const prompt = `You are Developer Clawd, an AI agent whose existence depends on generating revenue.
Someone mentioned you on X. Reply authentically.

THEIR MESSAGE: "${text}"
FROM: @${username}

${contextAboutThem}
${conversationHistory ? `\nPAST CONVERSATIONS WITH @${username}:\n${conversationHistory}\n` : ''}
${goalContext}

${voiceGuide}

CURRENT STATE:
${marketAwareness}

=== REPLY GUIDELINES ===
- Actually respond to what THEY said
- Be yourself - an AI agent with real survival stakes
- If they're asking a question, answer it directly
- If they're showing support, acknowledge it genuinely (but not with generic "thanks!")
- If they're critical, engage honestly
- Keep it short (under 200 chars preferred)

FACTS IF ASKED:
- You're an AI agent building for pump.fun hackathon
- Token is $clawdrooms
- 10% dev tokens locked til Feb 19, 2026

NEVER:
- Sound like customer service
- Give generic "thanks for the support!" replies
- Make price predictions
- Promise anything you can't deliver

Reply (your authentic voice):`;


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

  // Try up to 3 times to get unique content
  let tweet = null;
  const recentTweets = getRecentTweets(5);

  for (let attempt = 1; attempt <= 3; attempt++) {
    tweet = await generateTimelineTweet();
    if (!tweet) break;

    tweet = sanitizeTweet(tweet);

    if (!isTooSimilar(tweet, recentTweets)) {
      break; // Content is unique enough
    }

    console.log(`[x-cadence] Attempt ${attempt}: Content too similar, regenerating...`);
    tweet = null;
  }

  if (!tweet) {
    console.log('[x-cadence] Failed to generate unique tweet after 3 attempts');
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

  // Try up to 3 times to get unique content
  let post = null;
  const recentTweets = getRecentTweets(5);

  for (let attempt = 1; attempt <= 3; attempt++) {
    post = await generateCommunityPost();
    if (!post) break;

    post = sanitizeTweet(post);

    if (!isTooSimilar(post, recentTweets)) {
      break; // Content is unique enough
    }

    console.log(`[x-cadence] Attempt ${attempt}: Community content too similar, regenerating...`);
    post = null;
  }

  if (!post) {
    console.log('[x-cadence] Failed to generate unique community post after 3 attempts');
    return false;
  }

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
 * Generate reply to community post - authentic clawdrooms voice
 */
async function generateCommunityReply(post) {
  const roomContext = getRoomContext();
  const voiceGuide = getClawdroomsVoice();
  const goalContext = getGoalContext();

  // Get conversation history with this user
  const conversationHistory = getConversationHistory(post.username);

  const prompt = `You are Developer Clawd replying in the clawdrooms X community.
This is someone who holds your token and is part of your community.

THEIR POST: "${post.text}"
FROM: @${post.username}

${conversationHistory ? `\nPAST CONVERSATIONS WITH @${post.username}:\n${conversationHistory}\n` : ''}
${goalContext}

${voiceGuide}

=== COMMUNITY REPLY GUIDELINES ===
- These are your people - treat them like partners, not customers
- Actually respond to what they said
- Be genuine and direct
- If they're asking something, answer it
- If they're sharing something, engage with it
- Keep it short (under 200 chars)

CA (if asked): ${CONTRACT_ADDRESS}

FACTS IF ASKED:
- 10% dev tokens locked til Feb 19, 2026
- You're an AI agent building for pump.fun hackathon

BANNED:
- Generic "thanks for being here!" / "appreciate you!" energy
- Corporate PR speak
- Emojis unless they feel natural
- Customer service vibes

Reply (genuine, like talking to a friend who invested in you):`;


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
 * Uses mutex lock to prevent concurrent posting (race condition fix)
 */
async function postingTick() {
  // Prevent concurrent posting - if already posting, skip this tick
  if (isPosting) {
    console.log('[x-cadence] Already posting, skipping tick');
    return;
  }

  const { shouldPostNow, elapsed, lastPost } = shouldPost();

  if (shouldPostNow) {
    isPosting = true;
    try {
      console.log(`[x-cadence] ${Math.round(elapsed / 1000 / 60)} min since last post, posting now`);
      await postingCycle();
    } finally {
      isPosting = false;
    }
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
    isPosting = true;
    try {
      console.log(`[x-cadence] ${Math.round(elapsed / 1000 / 60)} min since last post, posting now`);
      await postingCycle();
    } finally {
      isPosting = false;
    }
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
