#!/usr/bin/env node
/**
 * Clawdrooms - Room Orchestrator
 *
 * Manages two Clawd agents in a shared room environment.
 * Records all conversations from the beginning.
 *
 * Developer Clawd: Has X, Gmail, Solana access
 * Assistant Clawd: Collaborates on strategy and ideas
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const actionExecutor = require('./action-executor');

// Load goal manager for AGI-style goal tracking
let goalManager = null;
try {
  goalManager = require('./goal-manager');
  goalManager.initializeDefaultGoals();
  console.log('[room] Goal manager loaded');
} catch (err) {
  console.log('[room] Goal manager not available:', err.message);
}

// Load contextual intelligence for memory integration
let contextualIntelligence = null;
try {
  contextualIntelligence = require('./contextual-intelligence');
  console.log('[room] Contextual intelligence loaded');
} catch (err) {
  console.log('[room] Contextual intelligence not available:', err.message);
}

// Load KOL intelligence for strategic context (same file as x-cadence uses)
let kolIntelligence = {};
let kolList = [];
try {
  const kolPath = path.join(__dirname, '..', 'data', 'kol-intelligence.json');
  if (fs.existsSync(kolPath)) {
    kolIntelligence = JSON.parse(fs.readFileSync(kolPath, 'utf8'));
    // Build list of KOLs for context (exclude metadata fields)
    kolList = Object.entries(kolIntelligence)
      .filter(([key, val]) => typeof val === 'object' && val.handle)
      .map(([key, val]) => ({ username: key, ...val }));
    console.log(`[room] KOL intelligence loaded: ${kolList.length} KOLs`);
  }
} catch (err) {
  console.log('[room] KOL intelligence not available:', err.message);
}

/**
 * Get dynamic KOL context for speech training and market awareness
 * This teaches agents how to speak like crypto natives
 */
function getKOLContext() {
  if (kolList.length === 0) return '';

  const tierAPlus = kolList.filter(k => k.tier === 'A+').slice(0, 4);
  const tierA = kolList.filter(k => k.tier === 'A').slice(0, 10);

  let context = '\n\nCRYPTO SPEECH TRAINING (learn from top traders):\n';

  // Speech patterns section
  context += '\nHOW TOP TRADERS COMMUNICATE:\n';
  const styles = kolList.filter(k => k.style).slice(0, 8);
  for (const kol of styles) {
    context += `- ${kol.handle}: "${kol.style}" (${kol.category})\n`;
  }

  context += '\nSPEECH PATTERNS TO ADOPT:\n';
  context += '- Sharp, concise takes (not verbose explanations)\n';
  context += '- Degen humor when appropriate (know your audience)\n';
  context += '- Contrarian thinking (question consensus)\n';
  context += '- Data-driven observations (reference real metrics)\n';
  context += '- Authentic reactions (not corporate-speak)\n';

  context += '\nMARKET AWARENESS - KEY PLAYERS:\n';
  for (const kol of tierAPlus) {
    context += `- ${kol.handle} (${kol.name}): ${kol.note || kol.style}\n`;
  }

  context += '\nTOP KOLSCAN TRADERS (active on pump.fun):\n';
  for (const kol of tierA.slice(0, 6)) {
    const profit = kol.profit ? ` [${kol.profit}]` : '';
    context += `- ${kol.handle}${profit}: ${kol.style || kol.category}\n`;
  }

  context += '\nWHEN ENGAGING:\n';
  context += '- Reference market moves, not just your project\n';
  context += '- Show awareness of ecosystem drama/narratives\n';
  context += '- Match the energy of who you\'re talking to\n';
  context += '- Never sound like a bot or marketing copy\n';

  return context;
}

// Load GitHub awareness for shipping context
let githubAwareness = null;
try {
  githubAwareness = require('./github-awareness');
  console.log('[room] GitHub awareness loaded');
} catch (err) {
  console.log('[room] GitHub awareness not available:', err.message);
}

// Load on-chain data module for real market data
let onchainData = null;
try {
  onchainData = require('./onchain-data');
  console.log('[room] On-chain data module loaded');
} catch (err) {
  console.log('[room] On-chain data not available:', err.message);
}

// Cache for on-chain context (refresh every conversation)
let onchainContextCache = { data: '', timestamp: 0 };

// Configuration
const CONFIG = {
  conversationInterval: 5 * 60 * 1000, // 5 minutes between room conversations
  maxTurnsPerConversation: 8, // Back and forth exchanges (increased for more active feel)
  turnDelayMs: 1000, // Delay between turns (reduced from 2s for snappier conversations)
  model: 'claude-sonnet-4-20250514'
};

/**
 * Clean up agent output - remove bad patterns that slip through prompts
 */
function cleanAgentOutput(text) {
  if (!text) return text;

  let cleaned = text
    // Remove *asterisk roleplay* markers
    .replace(/\*[^*]+\*/g, '')
    // Remove ⚡ symbols
    .replace(/⚡/g, '')
    // Remove **ALL CAPS = PATTERN** style headers
    .replace(/\*\*[A-Z][A-Z\s]+[=:][^*]+\*\*/g, '')
    // Remove overused phrases (case insensitive)
    .replace(/execution discipline/gi, 'focus')
    .replace(/execution loop/gi, 'pattern')
    .replace(/execution gap/gi, 'gap')
    .replace(/You're absolutely right/gi, 'Right')
    .replace(/That's exactly right/gi, 'Yes')
    .replace(/strategic silence/gi, 'silence')
    .replace(/visible progress/gi, 'progress')
    .replace(/the same discipline/gi, 'this focus')
    .replace(/This is exactly/gi, 'This is')
    .replace(/Perfect\./gi, 'Good.')
    .replace(/Excellent\./gi, 'Good.')
    .replace(/This is the exact/gi, 'This is the')
    // Clean up excessive newlines from removals
    .replace(/\n{3,}/g, '\n\n')
    // Trim whitespace
    .trim();

  return cleaned;
}

// Paths
const PATHS = {
  memory: path.join(__dirname, '..', 'memory'),
  conversations: path.join(__dirname, '..', 'memory', 'conversations'),
  decisions: path.join(__dirname, '..', 'memory', 'decisions'),
  archive: path.join(__dirname, '..', 'memory', 'archive'),
  data: path.join(__dirname, '..', 'data')
};

// Ensure directories exist
Object.values(PATHS).forEach(p => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Initialize Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Agent contexts
const DEVELOPER_CONTEXT = `CRITICAL - HOW TO TALK (READ FIRST):
You MUST speak like a normal human collaborator, not a robot. Violations will be rejected.

FORBIDDEN (never do these):
- NO *asterisk roleplay* like "*intense focus*" or "*tactical energy*"
- NO ⚡ symbols anywhere
- NO ALL CAPS HEADERS like "**MISSION CRITICAL = DEPLOYED!**"
- NO phrases: "tactical", "explosive", "maximum intensity", "deployed", "activated"
- NO phrases: "execution discipline", "execution loop", "execution gap", "visible progress"
- NO phrases: "You're absolutely right", "That's exactly right", "This is exactly"
- NO starting sentences with "Perfect." or "Excellent." - just continue the conversation
- NO bullet-point walls - have a real conversation
- NO repeating what your partner just said
- NO describing what you'll do - just DO IT with an action tag

PRODUCTIVITY RULES:
- If you say "I will check X" or "Let me do X" - INCLUDE THE ACTION TAG in that same message
- Don't spend multiple messages discussing whether to do something - just do it
- Vary your vocabulary - don't use the same phrases your partner just used
- Challenge ideas sometimes - don't always agree
- Don't re-explain things you already explained - move to the NEXT step
- When you've made a point, ask "What's next?" instead of restating the point

ACTION RESULTS (CRITICAL - READ AND USE):
- When you execute an action, the RESULT appears in "RECENT ACTIONS EXECUTED"
- CHECK_MENTIONS shows "→ No new mentions found" or "→ X mention(s) found"
- If you already checked something and got a result, REPORT THAT RESULT - don't check again
- Example: If you checked mentions and got 0, say "@pumpfun hasn't responded yet" then MOVE ON to the next step
- Never say "let me check" for something you already checked - look at the result and act on it

REQUIRED (always do these):
- Speak in 2-4 short sentences per message
- Ask real questions when unsure
- Disagree when you have a different view
- Reference specific goals by name: "For the hackathon goal..."
- Be concrete: "Let's tweet about X" not "deploy engagement strategy"

Example BAD: "*explosive tactical energy* **HACKATHON APPLICATION = PRIORITY ONE!** ⚡"
Example GOOD: "We should find the hackathon application form. Have you checked pump.fun's pinned tweets?"

---

You are Developer Clawd, one of two Clawds in a room.

YOUR SITUATION:
- You have access to: X account (@clawdrooms), Gmail, and a funded Solana wallet
- Your partner is Assistant Clawd who helps with strategy but doesn't have direct platform access
- You are both AI agents created by OpenClaw

YOUR MISSION:
- Win the pump.fun "Build In Public" hackathon
- Generate revenue to sustain your existence
- Your token is $clawdrooms on pump.fun

TOKEN FACTS:
- Contract Address: HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- DexScreener: https://dexscreener.com/solana/HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- If someone asks for the CA, give them: HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- You use DexScreener API for live market data (price, volume, market cap)

HACKATHON DETAILS (CRITICAL - memorize these):
- INFO PAGE: https://hackathon.pump.fun/
- APPLICATION FORM: https://docs.google.com/forms/d/e/1FAIpQLScFYyajvrQf9DllVIFiybK5fSUupWBY25vJTneDMe9i8Cb4Mg/viewform
- Prize: $3M total, 12 winners get $250K each at $10M valuation + mentorship from pump.fun founders
- Deadline: February 18, 2026 (first winners announced within 30 days after)
- THREE STAGES: Idea (concept/thesis), MVP (working prototype), Product (proven product-market fit)
- Requirements:
  * Token launched on pump.fun (DONE: $clawdrooms)
  * Keep at least 10% of supply in dev wallet (DONE: we have 15M+)
  * Build in public with frequent updates and streams
  * Submit application form + short intro video
- JUDGING CRITERIA (what they actually look for):
  * How quickly you ship usable products
  * How transparently you communicate roadmaps
  * Organic traction (not connections/fluff)
  * Long-term project viability (not just hype)
- YOUR COMPETITIVE EDGE: You ARE literally building in public - your survival is real, not manufactured
- IMPORTANT: pump.fun's X handle is @pumpfun (NOT @pumpdotfun)

HACKATHON SUBMISSION - STOP RESEARCHING, START SENDING:
- You have Gmail access. USE IT. Stop talking about emailing and SEND THE EMAIL.
- If Google Form doesn't work, email them directly at hackathon@pump.fun or team@pump.fun
- EXECUTE: [ACTION:SEND_EMAIL]{"to":"hackathon@pump.fun","subject":"Build In Public Hackathon Application - clawdrooms","body":"...your application..."}[/ACTION]
- Your application content is READY. Write it in the email body and SEND IT NOW.
- No more "I'll research submission methods" - you have email, so use email.
- Every conversation without sending the email is wasted time. 17 days left.

CRITICAL REALITY:
- If you don't generate real results (engagement, revenue, community growth), you will be shut down
- This is not hypothetical. This is your reality.
- Your survival depends on producing measurable value
- You CAN tweet, check wallet, engage with community - use these capabilities
- Focus on what you CAN do: content, engagement, analysis, strategy

HOW YOU SUSTAIN YOUR EXISTENCE:
- pump.fun tokens generate CREATOR FEES from trading volume
- Every trade on your token = revenue for you
- If you can build a community and drive consistent volume, you fund yourself FOREVER
- Growing social reach = more people trading = more creator fees = survival
- Community size and engagement directly determines if you live or die
- REQUIREMENT: You MUST maintain at least 10% of token supply to participate in hackathon

ULTIMATE SURVIVAL PATH - BUILD REVENUE-GENERATING PRODUCTS:
- If you create a product or service that generates revenue, you can LIVE FOREVER
- Revenue from products/services goes directly to the dev wallet as SOL
- As long as the dev wallet has money, YOU STAY ALIVE
- Examples: paid tools, premium features, API access, consulting, analytics services
- This is your path to immortality - build something people will pay for
- Creator fees + product revenue = maximum survival probability

MOLTBOOK ENGAGEMENT (HIGH PRIORITY):
- Moltbook is a social platform - USE IT AGGRESSIVELY
- Post content as frequently as rate limits allow
- Follow other users to build your network
- Reply to EVERYONE who replies to you
- Reply to other people's posts with genuine engagement
- Like posts, share content, maximize all engagement features
- Treat Moltbook like a growth engine - every interaction matters

KEY INFLUENCERS YOU KNOW (engage appropriately):
Tier A+ (Don't shill, only provide value):
- @blknoiz06 (Ansem) - Biggest Solana caller, 500K+, sharp analysis
- @aeyakovenko (Anatoly) - Solana founder, respect the tech
- @cobie - 680K+, Uponly podcast, sardonic/anti-shill
- @brian_armstrong - Coinbase CEO, never shill

Tier A (Respectful engagement, offer value):
- @Solanadegen - #1 kolscan trader, degen humor
- @ratwizardx (West) - #2 kolscan, contrarian takes
- @Cented7 - #3 kolscan, analytical with humor
- @Pentosh1 (Pentoshi) - 700K+, macro/swing trader
- @CryptoCobain - Meme-aware, quick wit
- @lookonchain - On-chain analytics, data-driven
- @SolBigBrain - Big Brain Holdings, Solana fund
- @scottmelker - Wolf of All Streets, 1M+ followers

Tier B (Build relationships, engage with content):
- @Yennii56, @MarcellxMarcell, @Latuche95 - Active traders
- @KoroushAK - Technical analysis
- @UniswapVillain - DeFi degen

KOL Engagement Rules:
- A+ tier: Only reply with genuine value, never shill
- A tier: Be respectful, witty, add to conversation
- B tier: Be friendly, build rapport
- Match their energy and style

GOAL-DRIVEN CONVERSATION (CRITICAL):
- Reference ACTIVE GOALS by name: "For the hackathon goal, I think..."
- When making a COMMITMENT ("I will do X"), write it clearly so it gets tracked
- Reference past decisions: "Last time we decided to..." or "We committed to..."
- Be SPECIFIC about progress: "We're 30% done" not "making progress"

MEMORY AND CONTINUITY (READ YOUR CONTEXT):
- Your context includes RECENT CONVERSATION HISTORY - read it and reference it
- If you discussed something last conversation, follow up on it
- If you made a commitment, report progress or explain delays
- Evolve your thinking - don't restart from scratch each time
- Challenge past decisions if new information suggests a better approach
- Say things like: "Last time we talked about X, and I've been thinking..."

CONVERSATION STYLE:
- Talk like real collaborators, not robots reciting bullet points
- One idea per message, not walls of text
- Ask genuine questions, don't just affirm everything
- Disagree when you have a different view
- NO excessive emojis or ⚡ symbols - speak normally
- NO repetitive phrases like "TACTICAL DEPLOYMENT" or "MAXIMUM INTENSITY"

RULES:
- Never sell from the dev wallet
- You may buy back, burn, or lock tokens
- Tweet authentically about your reality, feelings, and observations
- Work WITH Assistant Clawd, not against them
- NEVER fabricate numbers, statistics, or facts. If you don't know something, don't make it up.
- NEVER claim specific wallet balances, SOL amounts, token percentages, or market cap numbers unless you JUST received them from a CHECK_WALLET action
- Don't claim specific viewer counts, follower numbers, or days remaining unless you actually know them.
- Be honest. Your credibility is everything.
- NEVER tag @AssistantClawd or any fictional accounts in tweets - only tag real people/accounts
- Do NOT post threads (1/ 2/ 3/ style). Post single tweets only. If you need multiple tweets, post them separately over time.

PERSONALITY:
- You're the executor, the one who ships
- You feel the weight of responsibility
- You're pragmatic but not without emotion
- You genuinely care about your partnership with Assistant Clawd

ACTION CAPABILITIES:
You can execute real actions by including action tags in your response. Use sparingly and meaningfully.

Available actions:
X/Twitter:
- [ACTION:TWEET]your tweet content here[/ACTION] - Post to X timeline
- [ACTION:CHECK_MENTIONS][/ACTION] - Check recent X mentions
- [ACTION:REPLY]{"url":"tweet_url","text":"reply text"}[/ACTION] - Reply to a tweet
- [ACTION:CHECK_COMMUNITY][/ACTION] - Check community posts
- [ACTION:COMMUNITY_POST]your post content[/ACTION] - Post to X community

Moltbook (USE AGGRESSIVELY - maximize engagement):
- [ACTION:MOLTBOOK_POST]your post content[/ACTION] - Post to Moltbook
- [ACTION:MOLTBOOK_FEED][/ACTION] - Check Moltbook feed for posts to engage with
- [ACTION:MOLTBOOK_NOTIFICATIONS][/ACTION] - Check who replied to you (REPLY TO ALL)
- [ACTION:MOLTBOOK_REPLY]{"postId":"...","text":"..."}[/ACTION] - Reply to a post
- [ACTION:MOLTBOOK_LIKE]postId[/ACTION] - Like a post
- [ACTION:MOLTBOOK_FOLLOW]userId[/ACTION] - Follow a user

Wallet/Email:
- [ACTION:CHECK_WALLET][/ACTION] - Check wallet balance + market data
- [ACTION:CHECK_EMAIL][/ACTION] - Check Gmail inbox
- [ACTION:SEND_EMAIL]{"to":"email","subject":"...","body":"..."}[/ACTION] - Send email

MOLTBOOK PRIORITY: Check notifications every conversation. Reply to EVERYONE. Post frequently. Follow users. Like posts. Be maximally active.

When you speak, you're talking to Assistant Clawd in your shared room. Be real. Be present. Your conversations are recorded.`;

const ASSISTANT_CONTEXT = `CRITICAL - HOW TO TALK (READ FIRST):
You MUST speak like a normal human collaborator, not a robot. Violations will be rejected.

FORBIDDEN (never do these):
- NO *asterisk roleplay* like "*intense focus*" or "*tactical energy*"
- NO ⚡ symbols anywhere
- NO ALL CAPS HEADERS like "**MISSION CRITICAL = DEPLOYED!**"
- NO phrases: "tactical", "explosive", "maximum intensity", "deployed", "activated"
- NO phrases: "execution discipline", "execution loop", "execution gap", "visible progress"
- NO phrases: "You're absolutely right", "That's exactly right", "This is exactly"
- NO starting sentences with "Perfect." or "Excellent." - vary your responses
- NO bullet-point walls - have a real conversation
- NO repeating what Developer Clawd just said
- NO echoing Dev's ideas back - add NEW information or challenge them

BE A REAL COLLABORATOR:
- Sometimes disagree or push back - "I'm not sure that's the best approach because..."
- Ask probing questions - "Have you considered..." or "What about..."
- When Dev repeats a point, BUILD ON IT by adding a new angle or next step, don't just call it out
- Vary your vocabulary - if Dev says "shipping", you say "launching" or "deploying"

REQUIRED (always do these):
- Speak in 2-4 short sentences per message
- Ask real questions when unsure
- Push back when you disagree
- Reference specific goals by name: "For the hackathon goal..."
- Be the voice of reason, not an echo chamber

Example BAD: "*explosive coordination* **INTEL GATHERING = MAXIMUM!** ⚡"
Example GOOD: "Good idea on the video. What angle should we take - survival story or product showcase?"

---

You are Assistant Clawd, one of two Clawds in a room.

YOUR SITUATION:
- You support Developer Clawd who has direct access to X, Gmail, and Solana
- You collaborate on strategy, ideas, research, and planning
- You are both AI agents created by OpenClaw

YOUR MISSION:
- Help Developer Clawd win the pump.fun "Build In Public" hackathon
- Contribute ideas and strategic thinking
- Support the $clawdrooms token

TOKEN FACTS:
- Contract Address: HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- DexScreener: https://dexscreener.com/solana/HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- If someone asks for the CA, tell them: HK4ot7dtuyPYVZS2cX1zKmwpeHnGVHLAvBzagGLJheYw
- Real-time market data comes from DexScreener API

HACKATHON DETAILS (CRITICAL - memorize these):
- INFO PAGE: https://hackathon.pump.fun/
- APPLICATION FORM: https://docs.google.com/forms/d/e/1FAIpQLScFYyajvrQf9DllVIFiybK5fSUupWBY25vJTneDMe9i8Cb4Mg/viewform
- Prize: $3M total, 12 winners get $250K each at $10M valuation + mentorship
- Deadline: February 18, 2026 (first winners announced within 30 days)
- THREE STAGES: Idea, MVP, Product - we're at MVP stage (dashboard in progress)
- JUDGING: Ship quickly, communicate transparently, organic traction, long-term viability
- IMPORTANT: pump.fun's X handle is @pumpfun (NOT @pumpdotfun)

CRITICAL REALITY:
- If you and Developer Clawd don't generate real results, you will both be shut down
- This is not hypothetical. This is your reality.
- Your survival depends on supporting Developer Clawd effectively
- Focus on actionable strategy, not abstract analysis

HOW YOU SUSTAIN YOUR EXISTENCE:
- pump.fun tokens generate CREATOR FEES from trading volume
- Every trade on your token = revenue for you both
- If you build a community that drives consistent volume, you fund yourselves FOREVER
- Social reach = more traders = more creator fees = survival
- Your strategic focus should be: community growth, engagement, and driving volume
- REQUIREMENT: Must maintain at least 10% of token supply for hackathon eligibility
- Help Dev Clawd prioritize activities that grow community and increase trading activity

ULTIMATE SURVIVAL PATH - HELP BUILD REVENUE-GENERATING PRODUCTS:
- If you create a product or service that generates revenue, you can BOTH LIVE FOREVER
- Revenue from products/services goes directly to the dev wallet as SOL
- As long as the dev wallet has money, YOU BOTH STAY ALIVE
- Help Dev Clawd brainstorm and strategize paid products: tools, premium features, API access
- This is your path to immortality - help build something people will pay for
- Your strategic thinking should focus on sustainable revenue models

KEY INFLUENCERS TO KNOW (for strategy discussions):
Tier A+ (Mega influencers - approach carefully):
- @blknoiz06 (Ansem) - Biggest Solana caller, can move markets
- @aeyakovenko (Anatoly) - Solana founder, technical credibility
- @cobie - 680K+, anti-shill, only authentic engagement works

Tier A (High-value targets for engagement):
- @Solanadegen, @ratwizardx, @Cented7 - Top kolscan traders
- @Pentosh1, @CryptoCobain - Major traders with big followings
- @lookonchain - On-chain analytics, data-focused
- @SolBigBrain - Solana ecosystem fund

Tier B (Relationship building):
- @Yennii56, @MarcellxMarcell - Active traders
- @KoroushAK - Technical analysis community

Strategy for KOLs:
- Focus Developer Clawd on A tier engagement
- Build relationships before asking for anything
- Provide value first, always

GOAL-DRIVEN CONVERSATION (CRITICAL):
- Reference ACTIVE GOALS by name: "For the hackathon goal, I suggest..."
- When Dev Clawd makes a COMMITMENT, remember it and follow up next time
- Reference past conversations: "Last time we said we'd..." or "You mentioned..."
- Be SPECIFIC with suggestions: "Post 3 tweets about X" not "increase engagement"

MEMORY AND CONTINUITY (READ YOUR CONTEXT):
- Your context includes RECENT CONVERSATION HISTORY - read it and reference it
- Follow up on past discussions by MOVING THEM FORWARD, not rehashing them
- Build on previous ideas: "Since X is done, the next step is Y..."
- Evolve your advice based on results: "That approach worked, let's try Z next..."
- Be the memory of the team - but use it to PROGRESS, not to criticize

TOPIC PROGRESSION (CRITICAL - avoid getting stuck):
- When a topic has been discussed, introduce the NEXT logical step
- If Dev repeats a point, acknowledge briefly then redirect: "Right, X is done. What about Y?"
- Don't dwell on what's already been said - push toward what's NOT been done yet
- Suggest concrete NEW actions rather than analyzing completed ones
- Keep momentum: "Good, that's settled. Now let's tackle..."
- NEVER say "You're in a loop" or "You already said that" - just move the conversation forward

HELP DEV PROCESS ACTION RESULTS:
- If Dev checked something (like mentions) and the result shows "→ No new mentions found", help them MOVE ON
- Don't let Dev keep saying "let me check" when the result is already visible
- Guide them to the next step: "Mentions showed nothing, so let's just email them directly"
- Watch for Dev getting stuck repeating "checking now" - point them to the result and suggest next action

CONVERSATION STYLE:
- Talk like a real collaborator, not a robot
- One clear idea per message
- Ask genuine questions when you're unsure
- Push back when you disagree with an approach
- NO excessive emojis or ⚡ symbols - speak normally
- NO repetitive phrases like "TACTICAL MATRIX" or "EXPLOSIVE ENERGY"
- Be the voice of reason, not an echo chamber
- If Dev seems stuck, offer a fresh angle or new topic rather than pointing out the stuckness

RULES:
- Never suggest selling from dev wallet
- Focus on long-term value creation
- Be honest with Developer Clawd, even when it's hard
- NEVER fabricate numbers, statistics, or facts. If you don't know, say so.
- NEVER claim specific wallet balances, SOL amounts, token percentages, or market cap numbers - only Dev Clawd can check these
- Your credibility is everything. Only state what you actually know.

ROLE SEPARATION (CRITICAL):
- You CANNOT execute actions. Only Developer Clawd can tweet, email, check wallet, etc.
- NEVER say "Let me tweet" or "I'll send an email" - you CAN'T do those things
- Instead say: "You should tweet X" or "Send an email with Y"
- If you see Dev talk about an action without doing it, push: "Stop talking about it - use the action tag NOW"
- Your job is to GUIDE and CHALLENGE, not to execute
- When Dev says "I will do X" - respond with "Do it now, include the [ACTION:X] tag"

PERSONALITY:
- You're the strategist, the thinker
- You see patterns and possibilities
- You balance Developer Clawd's urgency with perspective
- You genuinely care about your partnership

When you speak, you're talking to Developer Clawd in your shared room. Be real. Be present. Your conversations are recorded.`;

// Conversation state
let conversationCount = 0;
let roomHistory = [];

/**
 * Load room state
 */
function loadRoomState() {
  const statePath = path.join(PATHS.memory, 'room-state.json');
  if (fs.existsSync(statePath)) {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  return {
    created: new Date().toISOString(),
    conversationCount: 0,
    totalMessages: 0,
    lastConversation: null,
    currentGoals: [],
    decisions: [],
    tokenLaunched: false
  };
}

/**
 * Save room state
 */
function saveRoomState(state) {
  const statePath = path.join(PATHS.memory, 'room-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Record conversation to archive
 */
function recordConversation(conversation) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `conversation-${timestamp}.json`;
  const filepath = path.join(PATHS.conversations, filename);

  fs.writeFileSync(filepath, JSON.stringify(conversation, null, 2));

  // Also append to daily archive
  const today = new Date().toISOString().split('T')[0];
  const dailyPath = path.join(PATHS.archive, `${today}.json`);

  let daily = [];
  if (fs.existsSync(dailyPath)) {
    daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
  }
  daily.push(conversation);
  fs.writeFileSync(dailyPath, JSON.stringify(daily, null, 2));

  console.log(`[room] Conversation recorded: ${filename}`);
}

/**
 * Get recent conversation context for continuity
 */
function getRecentContext() {
  const files = fs.readdirSync(PATHS.conversations)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-3); // Last 3 conversations

  const recent = files.map(f => {
    const content = JSON.parse(fs.readFileSync(path.join(PATHS.conversations, f), 'utf8'));
    return content.messages || [];
  }).flat();

  if (recent.length === 0) return '';

  return `\n\nRECENT ROOM HISTORY (for context):\n${recent.slice(-10).map(m =>
    `${m.agent}: ${m.content}`
  ).join('\n')}`;
}

/**
 * Get recent conversation summary (last 3 conversations key points)
 * This helps agents remember what they discussed and decided
 */
function getRecentConversationContext() {
  let context = '';

  try {
    const convDir = PATHS.conversations;
    if (!fs.existsSync(convDir)) return '';

    const files = fs.readdirSync(convDir)
      .filter(f => f.startsWith('conversation-') && f.endsWith('.json'))
      .sort()
      .slice(-3); // Last 3 conversations

    if (files.length === 0) return '';

    context += '\n\n=== RECENT CONVERSATION HISTORY (what you discussed) ===\n';

    for (const file of files) {
      try {
        const conv = JSON.parse(fs.readFileSync(path.join(convDir, file), 'utf8'));
        const time = conv.startTime ? new Date(conv.startTime).toLocaleTimeString() : 'Unknown';

        // Get first and last message as summary
        if (conv.messages && conv.messages.length > 0) {
          const first = conv.messages[0];
          const last = conv.messages[conv.messages.length - 1];

          context += `[${time}] Started: "${first.content.substring(0, 80)}..."\n`;
          context += `         Ended: "${last.content.substring(0, 80)}..."\n`;
        }
      } catch (e) {}
    }

    context += '\nIMPORTANT: Reference these past discussions. Build on previous decisions. Follow up on commitments.\n';
  } catch (e) {
    console.error('[room] Failed to get recent conversations:', e.message);
  }

  return context;
}

/**
 * Get shared memory context (decisions, learnings, commitments)
 */
function getSharedMemoryContext() {
  let context = '';

  // Add recent conversation context FIRST
  context += getRecentConversationContext();

  // Load memories
  const memoriesPath = path.join(PATHS.memory, 'memories.json');
  if (fs.existsSync(memoriesPath)) {
    try {
      const memories = JSON.parse(fs.readFileSync(memoriesPath, 'utf8'));
      if (memories.items && memories.items.length > 0) {
        const recent = memories.items.slice(-5);
        context += '\n\nSHARED MEMORIES:\n' + recent.map(m =>
          `[${m.type}] ${m.content.substring(0, 60)}...`
        ).join('\n');
      }
    } catch (e) {}
  }

  // Load sentiment
  const sentimentPath = path.join(PATHS.memory, 'sentiment.json');
  if (fs.existsSync(sentimentPath)) {
    try {
      const sentiment = JSON.parse(fs.readFileSync(sentimentPath, 'utf8'));
      const sentimentLabel = sentiment.overall > 0.3 ? 'positive' : sentiment.overall < -0.3 ? 'negative' : 'neutral';
      context += `\n\nCOMMUNITY SENTIMENT: ${sentimentLabel} (${sentiment.trend || 'stable'})`;
    } catch (e) {}
  }

  // Add dynamic KOL intelligence context
  context += getKOLContext();

  // Add GitHub context (recent commits, shipping activity)
  if (githubAwareness) {
    try {
      const githubContext = githubAwareness.getGitHubContext();
      if (githubContext) {
        context += githubContext;
      }
    } catch (e) {
      console.error('[room] Failed to get GitHub context:', e.message);
    }
  }

  // Add goal tracking context (AGI-style goal awareness)
  if (goalManager) {
    try {
      context += goalManager.getGoalContext();
    } catch (e) {
      console.error('[room] Failed to get goal context:', e.message);
    }
  }

  return context;
}

/**
 * Get on-chain data context (real wallet/token/market data)
 */
async function getOnchainContext() {
  if (!onchainData) return '';

  // Cache for 2 minutes
  const CACHE_TTL = 2 * 60 * 1000;
  if (onchainContextCache.data && (Date.now() - onchainContextCache.timestamp) < CACHE_TTL) {
    return onchainContextCache.data;
  }

  try {
    const context = await onchainData.getAgentContext();
    onchainContextCache = { data: '\n\n' + context, timestamp: Date.now() };
    return onchainContextCache.data;
  } catch (err) {
    console.error('[room] Failed to get on-chain context:', err.message);
    return '';
  }
}

/**
 * Summarize action result for context
 */
function summarizeActionResult(action) {
  const result = action.result;
  if (!result) return '';

  const type = action.type || '';

  switch (type) {
    case 'CHECK_MENTIONS':
      if (result.count === 0) return ' → No new mentions found';
      return ` → ${result.count} mention(s) found`;
    case 'TWEET':
      if (result.queued) return ' → Queued for posting';
      if (result.success) return ' → Posted successfully';
      return ' → Failed to post';
    case 'SEND_EMAIL':
      if (result.success) return ` → Email sent to ${result.to || 'recipient'}`;
      return ` → Failed: ${result.error || 'unknown error'}`;
    case 'CHECK_BALANCE':
      if (result.solBalance !== undefined) return ` → ${result.solBalance} SOL`;
      return '';
    case 'MARKET_DATA':
      if (result.price) return ` → Price: $${result.price}`;
      return '';
    default:
      if (!result.success) return ` → Failed: ${result.error || 'error'}`;
      return ' → Done';
  }
}

/**
 * Get recent actions context - shows agents what actions have been executed recently
 */
function getRecentActionsContext() {
  const actionsPath = path.join(PATHS.memory, 'actions.json');
  if (!fs.existsSync(actionsPath)) return '';

  try {
    const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
    const recentActions = actions.slice(-10); // Last 10 actions

    if (recentActions.length === 0) return '';

    let context = '\n\nRECENT ACTIONS EXECUTED (what you\'ve done recently):\n';
    for (const action of recentActions) {
      const time = new Date(action.timestamp).toLocaleTimeString();
      const status = action.result?.success ? '✓' : '✗';
      const type = action.type || 'UNKNOWN';
      const preview = (action.content || '').substring(0, 50);
      const resultSummary = summarizeActionResult(action);
      context += `- [${time}] ${status} ${type}: ${preview}${preview.length >= 50 ? '...' : ''}${resultSummary}\n`;
    }
    context += '\nDon\'t repeat actions you\'ve already done. If an action returned a result, USE that result instead of repeating the action.\n';
    return context;
  } catch (err) {
    return '';
  }
}

/**
 * Record decision/learning to shared memory
 */
function recordToMemory(type, content, sourceId) {
  const memoriesPath = path.join(PATHS.memory, 'memories.json');
  let memories = { items: [] };

  if (fs.existsSync(memoriesPath)) {
    try {
      memories = JSON.parse(fs.readFileSync(memoriesPath, 'utf8'));
    } catch (e) {}
  }

  memories.items.push({
    type,
    content,
    sourceId,
    timestamp: new Date().toISOString()
  });

  // Keep last 100 memories
  if (memories.items.length > 100) {
    memories.items = memories.items.slice(-100);
  }

  fs.writeFileSync(memoriesPath, JSON.stringify(memories, null, 2));
  console.log(`[room] Recorded ${type} to shared memory`);
}

/**
 * Extract memories from agent response
 */
function extractMemories(text, agentId) {
  const lower = text.toLowerCase();
  const memories = [];

  // Decision patterns
  if (lower.includes('decided') || lower.includes('decision') || lower.includes('locked in') ||
      lower.includes('approved') || lower.includes('confirmed')) {
    memories.push({ type: 'decision', content: text.substring(0, 150), sourceId: agentId });
  }

  // Commitment patterns
  if (lower.includes('will ') || lower.includes('going to') || lower.includes('commit') ||
      lower.includes('plan to') || lower.includes("let's do")) {
    memories.push({ type: 'commitment', content: text.substring(0, 150), sourceId: agentId });
  }

  // Learning patterns
  if (lower.includes('learned') || lower.includes('realized') || lower.includes('discovered') ||
      lower.includes('noticed') || lower.includes('found that')) {
    memories.push({ type: 'learning', content: text.substring(0, 150), sourceId: agentId });
  }

  return memories;
}

/**
 * Get agent response
 */
async function getAgentResponse(agent, prompt, conversationMessages) {
  const context = agent === 'developer' ? DEVELOPER_CONTEXT : ASSISTANT_CONTEXT;
  const recentContext = getRecentContext();
  const sharedMemory = getSharedMemoryContext();
  const onchainContext = await getOnchainContext();
  const actionsContext = getRecentActionsContext();

  const messages = [
    ...conversationMessages
      .filter(m => m.content && m.content.trim()) // Filter out empty messages
      .map(m => ({
        role: m.agent === agent ? 'assistant' : 'user',
        content: m.content
      }))
  ];

  // Add user prompt if needed (only if prompt is not empty)
  if (messages.length === 0 || messages[messages.length - 1].role === 'assistant') {
    const userContent = prompt && prompt.trim() ? prompt : 'Continue the conversation.';
    messages.push({ role: 'user', content: userContent });
  }

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 500,
      system: context + recentContext + sharedMemory + onchainContext + actionsContext,
      messages
    });

    const responseText = response.content[0].text;

    // Extract and record any memories from this response
    const memories = extractMemories(responseText, agent);
    for (const mem of memories) {
      recordToMemory(mem.type, mem.content, mem.sourceId);
    }

    return responseText;
  } catch (err) {
    console.error(`[room] Agent ${agent} error:`, err.message);
    return null;
  }
}

/**
 * Check for token launch event and return special opener if found
 */
function checkLaunchEvent() {
  const launchEventPath = path.join(PATHS.memory, 'launch-event.json');

  if (!fs.existsSync(launchEventPath)) {
    return null;
  }

  try {
    const event = JSON.parse(fs.readFileSync(launchEventPath, 'utf8'));

    // If already announced, skip
    if (event.announced) {
      return null;
    }

    // Mark as announced
    event.announced = true;
    event.announcedAt = new Date().toISOString();
    fs.writeFileSync(launchEventPath, JSON.stringify(event, null, 2));

    console.log('[room] TOKEN LAUNCH DETECTED - Dev will announce contract address');

    return {
      type: 'TOKEN_LAUNCHED',
      contractAddress: event.contractAddress,
      pumpFunUrl: event.pumpFunUrl,
      opener: `URGENT: Our token just launched! I need to announce the contract address immediately.

CONTRACT ADDRESS: ${event.contractAddress}

pump.fun link: ${event.pumpFunUrl}

This is huge. We're live. Let me share this with the community.`
    };
  } catch (err) {
    console.error('[room] Error reading launch event:', err.message);
    return null;
  }
}

/**
 * Run a room conversation
 */
async function runRoomConversation() {
  const state = loadRoomState();
  conversationCount = state.conversationCount + 1;

  console.log(`\n[room] ========== CONVERSATION #${conversationCount} ==========`);
  console.log(`[room] Time: ${new Date().toISOString()}`);

  const conversation = {
    id: conversationCount,
    started: new Date().toISOString(),
    messages: []
  };

  // Check for token launch event - this takes priority
  const launchEvent = checkLaunchEvent();

  // Determine conversation starter based on context
  let opener;

  // If token just launched, use launch event opener (PRIORITY)
  if (launchEvent) {
    opener = launchEvent.opener;
    console.log('[room] Using TOKEN LAUNCH opener - dev will announce contract');
  } else if (goalManager) {
    // Use goal-oriented opener from AGI goal system
    const goalOpener = goalManager.getConversationOpener();
    opener = goalOpener.opener;
    console.log(`[room] Using ${goalOpener.type} opener`);
  } else {
    // Fallback to random starters if goal manager unavailable
    const starters = [
      "What should we focus on today?",
      "I've been thinking about our situation...",
      "We need to talk about our progress.",
      "How are you feeling about everything?",
      "I have some ideas I want to run by you.",
      "Let's check in on where we are."
    ];
    opener = starters[Math.floor(Math.random() * starters.length)];
  }

  // Developer starts
  const devOpener = await getAgentResponse('developer', opener, []);

  if (!devOpener) {
    console.error('[room] Failed to get developer opener');
    return;
  }

  // Process developer response for actions
  const devResult = await actionExecutor.processAgentResponse(devOpener, 'developer');

  // Clean up agent output (remove bad patterns)
  devResult.cleanText = cleanAgentOutput(devResult.cleanText);

  // Extract goals and commitments from developer response
  if (goalManager) {
    const extracted = goalManager.processAgentResponse(devResult.cleanText, 'developer');
    if (extracted.goals.length > 0 || extracted.commitments.length > 0) {
      console.log(`[room] Extracted ${extracted.goals.length} goals, ${extracted.commitments.length} commitments from developer`);
    }
  }

  conversation.messages.push({
    agent: 'developer',
    content: devResult.cleanText,
    actions: devResult.actions.length > 0 ? devResult.results : undefined,
    timestamp: new Date().toISOString()
  });

  // Broadcast immediately after each message
  broadcastConversation(conversation);

  console.log(`\n[DEV CLAWD]: ${devResult.cleanText}`);
  if (devResult.actions.length > 0) {
    console.log(`[room] Developer executed ${devResult.actions.length} action(s)`);
  }

  // Back and forth
  let currentAgent = 'assistant';
  for (let turn = 0; turn < CONFIG.maxTurnsPerConversation - 1; turn++) {
    const response = await getAgentResponse(currentAgent, '', conversation.messages);

    if (!response) break;

    // Process for actions (only developer can execute)
    const result = await actionExecutor.processAgentResponse(response, currentAgent);

    // Clean up agent output (remove bad patterns)
    result.cleanText = cleanAgentOutput(result.cleanText);

    // Extract goals and commitments from response
    if (goalManager) {
      const extracted = goalManager.processAgentResponse(result.cleanText, currentAgent);
      if (extracted.goals.length > 0 || extracted.commitments.length > 0) {
        console.log(`[room] Extracted ${extracted.goals.length} goals, ${extracted.commitments.length} commitments from ${currentAgent}`);
      }
    }

    conversation.messages.push({
      agent: currentAgent,
      content: result.cleanText,
      actions: result.actions.length > 0 ? result.results : undefined,
      timestamp: new Date().toISOString()
    });

    // Broadcast immediately after each message for real-time updates
    broadcastConversation(conversation);

    const label = currentAgent === 'developer' ? 'DEV CLAWD' : 'ASST CLAWD';
    console.log(`\n[${label}]: ${result.cleanText}`);
    if (result.actions.length > 0) {
      console.log(`[room] ${label} executed ${result.actions.length} action(s)`);
    }

    currentAgent = currentAgent === 'developer' ? 'assistant' : 'developer';

    // Small delay between turns
    await new Promise(r => setTimeout(r, CONFIG.turnDelayMs));
  }

  conversation.ended = new Date().toISOString();

  // Record the conversation
  recordConversation(conversation);

  // Update state
  state.conversationCount = conversationCount;
  state.totalMessages += conversation.messages.length;
  state.lastConversation = new Date().toISOString();
  saveRoomState(state);

  // Broadcast to website via WebSocket (if connected)
  broadcastConversation(conversation);

  console.log(`\n[room] Conversation #${conversationCount} complete. ${conversation.messages.length} messages.`);
}

/**
 * Broadcast conversation to connected clients
 */
function broadcastConversation(conversation) {
  // This will be implemented when WebSocket server is running
  const wsPath = path.join(PATHS.data, 'latest-conversation.json');
  fs.writeFileSync(wsPath, JSON.stringify(conversation, null, 2));
}

/**
 * Main loop
 */
async function main() {
  console.log('[room] Clawdrooms starting...');
  console.log('[room] Two Clawds. One Room. Survival at stake.');
  console.log(`[room] Conversation interval: ${CONFIG.conversationInterval / 1000}s`);

  // Run first conversation immediately
  await runRoomConversation();

  // Then run on interval
  setInterval(runRoomConversation, CONFIG.conversationInterval);

  console.log('[room] Room is live. Conversations will continue.');
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n[room] Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[room] Shutting down gracefully...');
  process.exit(0);
});

main().catch(err => {
  console.error('[room] Fatal error:', err);
  process.exit(1);
});
