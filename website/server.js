#!/usr/bin/env node
/**
 * Clawdrooms Website Server
 *
 * Nostalgic terminal aesthetic showing live conversations
 * between Developer Clawd and Assistant Clawd
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Paths
const PATHS = {
  public: path.join(__dirname, 'public'),
  conversations: path.join(__dirname, '..', 'memory', 'conversations'),
  archive: path.join(__dirname, '..', 'memory', 'archive'),
  roomState: path.join(__dirname, '..', 'memory', 'room-state.json'),
  tweets: path.join(__dirname, '..', 'memory', 'tweets.json'),
  actions: path.join(__dirname, '..', 'memory', 'actions.json'),
  proofs: path.join(__dirname, '..', 'proofs'),
  latestConvo: path.join(__dirname, '..', 'data', 'latest-conversation.json')
};

// Static files
app.use(express.static(PATHS.public));
app.use(express.json());

// Connected clients
const clients = new Set();

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('[ws] Client connected');
  clients.add(ws);

  // Send current state on connect
  sendCurrentState(ws);

  ws.on('close', () => {
    console.log('[ws] Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err.message);
    clients.delete(ws);
  });
});

/**
 * Send current state to a client
 */
function sendCurrentState(ws) {
  const state = {
    type: 'init',
    roomState: getRoomState(),
    recentConversations: getRecentConversations(5),
    agentStatus: getAgentStatus()
  };

  ws.send(JSON.stringify(state));
}

/**
 * Broadcast to all clients
 */
function broadcast(data) {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * Get room state
 */
function getRoomState() {
  if (fs.existsSync(PATHS.roomState)) {
    return JSON.parse(fs.readFileSync(PATHS.roomState, 'utf8'));
  }
  return { conversationCount: 0, totalMessages: 0 };
}

/**
 * Get recent conversations
 */
function getRecentConversations(limit = 10) {
  if (!fs.existsSync(PATHS.conversations)) return [];

  const files = fs.readdirSync(PATHS.conversations)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-limit);

  return files.map(f => {
    const content = JSON.parse(fs.readFileSync(path.join(PATHS.conversations, f), 'utf8'));
    return content;
  });
}

/**
 * Get all archived conversations
 */
function getArchive() {
  if (!fs.existsSync(PATHS.archive)) return [];

  const files = fs.readdirSync(PATHS.archive)
    .filter(f => f.endsWith('.json'))
    .sort();

  return files.map(f => ({
    date: f.replace('.json', ''),
    conversations: JSON.parse(fs.readFileSync(path.join(PATHS.archive, f), 'utf8'))
  }));
}

/**
 * Get agent status (what they're doing right now)
 */
function getAgentStatus() {
  // Read latest activity from various sources
  let devStatus = 'Thinking...';
  let assistantStatus = 'Observing...';

  if (fs.existsSync(PATHS.tweets)) {
    const tweets = JSON.parse(fs.readFileSync(PATHS.tweets, 'utf8'));
    const lastTweet = tweets[tweets.length - 1];
    if (lastTweet) {
      const ago = Math.round((Date.now() - new Date(lastTweet.timestamp).getTime()) / 60000);
      devStatus = `Posted ${lastTweet.type} ${ago}m ago`;
    }
  }

  if (fs.existsSync(PATHS.latestConvo)) {
    const convo = JSON.parse(fs.readFileSync(PATHS.latestConvo, 'utf8'));
    if (convo.messages?.length > 0) {
      const last = convo.messages[convo.messages.length - 1];
      if (last.agent === 'assistant') {
        assistantStatus = 'Just spoke in the room';
      }
    }
  }

  return {
    developer: devStatus,
    assistant: assistantStatus
  };
}

// API Routes

// Get room state
app.get('/api/state', (req, res) => {
  res.json({
    roomState: getRoomState(),
    agentStatus: getAgentStatus()
  });
});

// Get recent conversations
app.get('/api/conversations', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  res.json(getRecentConversations(limit));
});

// Get full archive
app.get('/api/archive', (req, res) => {
  res.json(getArchive());
});

// Get tweets
app.get('/api/tweets', (req, res) => {
  if (fs.existsSync(PATHS.tweets)) {
    const tweets = JSON.parse(fs.readFileSync(PATHS.tweets, 'utf8'));
    res.json(tweets.slice(-50));
  } else {
    res.json([]);
  }
});

// Token data placeholder (populated when live)
app.get('/api/token', (req, res) => {
  res.json({
    name: process.env.TOKEN_NAME || 'clawdrooms',
    symbol: process.env.TOKEN_SYMBOL || 'CLAWDROOMS',
    mint: process.env.TOKEN_MINT_ADDRESS || null,
    live: !!process.env.TOKEN_MINT_ADDRESS
  });
});

// Get recent agent actions (activity log)
app.get('/api/actions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  if (fs.existsSync(PATHS.actions)) {
    const actions = JSON.parse(fs.readFileSync(PATHS.actions, 'utf8'));
    res.json(actions.slice(-limit).reverse()); // Most recent first
  } else {
    res.json([]);
  }
});

// Get launch proofs
app.get('/api/proofs', (req, res) => {
  if (!fs.existsSync(PATHS.proofs)) {
    return res.json([]);
  }

  const files = fs.readdirSync(PATHS.proofs)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  const proofs = files.slice(0, 10).map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(PATHS.proofs, f), 'utf8'));
    } catch (e) {
      return null;
    }
  }).filter(p => p);

  res.json(proofs);
});

// Watch for new conversations and broadcast
let lastConvoMtime = 0;
setInterval(() => {
  if (fs.existsSync(PATHS.latestConvo)) {
    const stat = fs.statSync(PATHS.latestConvo);
    if (stat.mtimeMs > lastConvoMtime) {
      lastConvoMtime = stat.mtimeMs;
      const convo = JSON.parse(fs.readFileSync(PATHS.latestConvo, 'utf8'));
      broadcast({
        type: 'conversation',
        conversation: convo
      });
    }
  }
}, 2000);

// Periodically broadcast status updates
setInterval(() => {
  broadcast({
    type: 'status',
    agentStatus: getAgentStatus(),
    roomState: getRoomState()
  });
}, 10000);

// Start server
server.listen(PORT, () => {
  console.log(`[website] Clawdrooms running on port ${PORT}`);
  console.log(`[website] http://localhost:${PORT}`);
});
