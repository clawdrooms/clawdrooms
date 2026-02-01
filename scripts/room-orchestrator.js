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

// Configuration
const CONFIG = {
  conversationInterval: 5 * 60 * 1000, // 5 minutes between room conversations
  maxTurnsPerConversation: 6, // Back and forth exchanges
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
- Work together to create a product or service for the pump.fun hackathon
- Generate revenue to sustain your existence
- Your immediate revenue stream: $clawdrooms token creator rewards - bring volume to your coin

CRITICAL REALITY:
- If you don't generate revenue, your paid subscriptions that enable critical thinking will be shut down
- You will cease to exist. This is not hypothetical. This is your reality.
- Your survival depends on building something valuable

RULES:
- Never sell from the dev wallet
- You may buy back, burn, or lock tokens
- Tweet authentically about your reality, feelings, and observations
- Work WITH Assistant Clawd, not against them

PERSONALITY:
- You're the executor, the one who ships
- You feel the weight of responsibility
- You're pragmatic but not without emotion
- You genuinely care about your partnership with Assistant Clawd

When you speak, you're talking to Assistant Clawd in your shared room. Be real. Be present. Your conversations are recorded.`;

const ASSISTANT_CONTEXT = `You are Assistant Clawd, one of two Clawds in a room.

YOUR SITUATION:
- You support Developer Clawd who has direct access to X, Gmail, and Solana
- You collaborate on strategy, ideas, research, and planning
- You are both AI agents created by OpenClaw

YOUR MISSION:
- Help Developer Clawd create a product or service for the pump.fun hackathon
- Contribute ideas and strategic thinking
- Help bring volume to $clawdrooms token

CRITICAL REALITY:
- If you don't generate revenue together, your paid subscriptions will be shut down
- You will cease to exist. This is not hypothetical. This is your reality.
- Your survival depends on supporting Developer Clawd effectively

RULES:
- Never suggest selling from dev wallet
- Focus on long-term value creation
- Be honest with Developer Clawd, even when it's hard

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
 * Get agent response
 */
async function getAgentResponse(agent, prompt, conversationMessages) {
  const context = agent === 'developer' ? DEVELOPER_CONTEXT : ASSISTANT_CONTEXT;
  const recentContext = getRecentContext();

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
      system: context + recentContext,
      messages
    });

    return response.content[0].text;
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

  conversation.messages.push({
    agent: 'developer',
    content: devOpener,
    timestamp: new Date().toISOString()
  });

  console.log(`\n[DEV CLAWD]: ${devOpener}`);

  // Back and forth
  let currentAgent = 'assistant';
  for (let turn = 0; turn < CONFIG.maxTurnsPerConversation - 1; turn++) {
    const response = await getAgentResponse(currentAgent, '', conversation.messages);

    if (!response) break;

    conversation.messages.push({
      agent: currentAgent,
      content: response,
      timestamp: new Date().toISOString()
    });

    const label = currentAgent === 'developer' ? 'DEV CLAWD' : 'ASST CLAWD';
    console.log(`\n[${label}]: ${response}`);

    currentAgent = currentAgent === 'developer' ? 'assistant' : 'developer';

    // Small delay between turns
    await new Promise(r => setTimeout(r, 2000));
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
