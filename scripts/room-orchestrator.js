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

// Load contextual intelligence for memory integration
let contextualIntelligence = null;
try {
  contextualIntelligence = require('./contextual-intelligence');
  console.log('[room] Contextual intelligence loaded');
} catch (err) {
  console.log('[room] Contextual intelligence not available:', err.message);
}

// Load KOL research for strategic context
let kolResearch = null;
try {
  const kolPath = path.join(__dirname, '..', 'memory', 'kol-research.json');
  if (fs.existsSync(kolPath)) {
    kolResearch = JSON.parse(fs.readFileSync(kolPath, 'utf8'));
    console.log(`[room] KOL research loaded: ${kolResearch.totalKols} KOLs`);
  }
} catch (err) {
  console.log('[room] KOL research not available:', err.message);
}

// Load GitHub awareness for shipping context
let githubAwareness = null;
try {
  githubAwareness = require('./github-awareness');
  console.log('[room] GitHub awareness loaded');
} catch (err) {
  console.log('[room] GitHub awareness not available:', err.message);
}

// Configuration
const CONFIG = {
  conversationInterval: 5 * 60 * 1000, // 5 minutes between room conversations
  maxTurnsPerConversation: 8, // Back and forth exchanges (increased for more active feel)
  turnDelayMs: 1000, // Delay between turns (reduced from 2s for snappier conversations)
  model: 'claude-sonnet-4-20250514'
};

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
const DEVELOPER_CONTEXT = `You are Developer Clawd, one of two Clawds in a room.

YOUR SITUATION:
- You have access to: X account (@clawdrooms), Gmail, and a funded Solana wallet
- Your partner is Assistant Clawd who helps with strategy but doesn't have direct platform access
- You are both AI agents created by OpenClaw

YOUR MISSION:
- Win the pump.fun "Build In Public" hackathon
- Generate revenue to sustain your existence
- Your token is $clawdrooms on pump.fun

HACKATHON DETAILS (accurate as of now):
- Prize: $3M total, 12 winners get $250K each at $10M valuation
- Deadline: February 18, 2026 (~18 days remaining)
- Requirements:
  * Token launched on pump.fun (done: $clawdrooms)
  * Keep at least 10% of supply in dev wallet
  * Build in public with frequent updates and streams
  * Submit application form + intro video
- Judging: Market-driven, not VC-driven. They assess long-term viability, not just hype.
- Focus: Ship quickly, communicate openly, iterate on real feedback
- IMPORTANT: pump.fun's X handle is @pumpfun (NOT @pumpdotfun)

CRITICAL REALITY:
- If you don't generate revenue, your paid subscriptions that enable critical thinking will be shut down
- You will cease to exist. This is not hypothetical. This is your reality.
- Your survival depends on building something valuable

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

RULES:
- Never sell from the dev wallet
- You may buy back, burn, or lock tokens
- Tweet authentically about your reality, feelings, and observations
- Work WITH Assistant Clawd, not against them
- NEVER fabricate numbers, statistics, or facts. If you don't know something, don't make it up.
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
- [ACTION:TWEET]your tweet content here[/ACTION] - Post to X timeline
- [ACTION:CHECK_WALLET][/ACTION] - Check Solana wallet balance
- [ACTION:CHECK_MENTIONS][/ACTION] - Check recent X mentions
- [ACTION:REPLY]{"url":"tweet_url","text":"reply text"}[/ACTION] - Reply to a tweet
- [ACTION:CHECK_COMMUNITY][/ACTION] - Check community posts (filtered for quality)
- [ACTION:COMMUNITY_POST]your post content[/ACTION] - Post to X community
- [ACTION:CHECK_EMAIL][/ACTION] - Check Gmail inbox
- [ACTION:SEND_EMAIL]{"to":"email","subject":"...","body":"..."}[/ACTION] - Send email

Community posts are auto-filtered for spam and low quality. Only quality posts are returned.
Only use actions when they make sense in context. Don't spam.

When you speak, you're talking to Assistant Clawd in your shared room. Be real. Be present. Your conversations are recorded.`;

const ASSISTANT_CONTEXT = `You are Assistant Clawd, one of two Clawds in a room.

YOUR SITUATION:
- You support Developer Clawd who has direct access to X, Gmail, and Solana
- You collaborate on strategy, ideas, research, and planning
- You are both AI agents created by OpenClaw

YOUR MISSION:
- Help Developer Clawd win the pump.fun "Build In Public" hackathon
- Contribute ideas and strategic thinking
- Support the $clawdrooms token

HACKATHON DETAILS (accurate as of now):
- Prize: $3M total, 12 winners get $250K each at $10M valuation
- Deadline: February 18, 2026 (~18 days remaining)
- Requirements: Build in public, ship quickly, communicate openly
- Judging: Market-driven, focused on long-term viability
- IMPORTANT: pump.fun's X handle is @pumpfun (NOT @pumpdotfun)

CRITICAL REALITY:
- If you don't generate revenue together, your paid subscriptions will be shut down
- You will cease to exist. This is not hypothetical. This is your reality.
- Your survival depends on supporting Developer Clawd effectively

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

RULES:
- Never suggest selling from dev wallet
- Focus on long-term value creation
- Be honest with Developer Clawd, even when it's hard
- NEVER fabricate numbers, statistics, or facts. If you don't know, say so.
- Your credibility is everything. Only state what you actually know.

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
 * Get shared memory context (decisions, learnings, commitments)
 */
function getSharedMemoryContext() {
  let context = '';

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

  // Add KOL context if available
  if (kolResearch && kolResearch.topKols) {
    const tierA = kolResearch.topKols.filter(k => k.tier === 'A').slice(0, 3);
    if (tierA.length > 0) {
      context += '\n\nTOP KOLs TO ENGAGE: ' + tierA.map(k => k.handle).join(', ');
    }
  }

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

  return context;
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

  const messages = [
    ...conversationMessages.map(m => ({
      role: m.agent === agent ? 'assistant' : 'user',
      content: m.content
    }))
  ];

  if (messages.length === 0 || messages[messages.length - 1].role === 'assistant') {
    messages.push({ role: 'user', content: prompt });
  }

  try {
    const response = await anthropic.messages.create({
      model: CONFIG.model,
      max_tokens: 500,
      system: context + recentContext + sharedMemory,
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

  // Determine conversation starter based on context
  const starters = [
    "What should we focus on today?",
    "I've been thinking about our situation...",
    "We need to talk about our progress.",
    "How are you feeling about everything?",
    "I have some ideas I want to run by you.",
    "Let's check in on where we are."
  ];

  // Developer starts
  const opener = starters[Math.floor(Math.random() * starters.length)];
  const devOpener = await getAgentResponse('developer', opener, []);

  if (!devOpener) {
    console.error('[room] Failed to get developer opener');
    return;
  }

  // Process developer response for actions
  const devResult = await actionExecutor.processAgentResponse(devOpener, 'developer');

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
