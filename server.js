"use strict";

// Load .env values when present, without overriding environment variables set by the host.
// Wispbyte's dashboard environment variables take priority over values in a local .env file.
const fs = require("fs");
const path = require("path");
function loadDotEnv(filePath = path.join(__dirname, ".env")) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read .env:", error.message);
  }
}
loadDotEnv();
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 11914;
const defaultOrigins = [
  "https://hassanaliniazi110-cyber.github.io",
  "https://eclipsearena.apexstrikers.workers.dev"
];
const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(v => v.trim()).filter(Boolean);
const allowedOrigins = [...new Set([...defaultOrigins, ...configuredOrigins])];
const players = new Map();
const tokenToPlayer = new Map();
const DATA_FILE = process.env.ECLIPSE_DATA_FILE || path.join(__dirname, "eclipse-data.json");
function hashToken(token) { return crypto.createHash("sha256").update(String(token)).digest("hex"); }
function saveData() {
  const data = [...players.values()].map(p => ({ id: p.id, tokenHash: p.tokenHash, profile: p.profile, friends: [...p.friends] }));
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify({ version: 1, players: data }), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.players)) return;
    for (const p of data.players.slice(0, MAX_PLAYERS)) {
      if (!validPlayerId(p.id) || !/^[a-f0-9]{64}$/i.test(p.tokenHash || "")) continue;
      const player = { id: p.id, tokenHash: p.tokenHash, profile: normalizeProfile(p.profile), friends: new Set(Array.isArray(p.friends) ? p.friends.filter(validPlayerId).slice(0, 100) : []) };
      players.set(player.id, player); tokenToPlayer.set(player.tokenHash, player.id);
    }
  } catch (e) { if (e.code !== "ENOENT") console.error("Could not load player data:", e.message); }
}
const invites = new Map();
const socketsByPlayer = new Map();
const activeMatches = new Map();
const MAX_PLAYERS = Math.max(100, Math.min(50000, Number(process.env.MAX_PLAYERS) || 5000));
// Access is granted only to server-listed player IDs. Never put this list in frontend code.
const youtubeAllowedPlayers = new Set((process.env.YOUTUBE_ALLOWED_PLAYER_IDS || "")
  .split(",").map(value => value.trim().toUpperCase())
  .filter(value => /^EA-[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/.test(value)));
// Accept one or several owner IDs. Commas, semicolons, and newlines are supported
// so Wispbyte environment-variable formatting cannot silently break the owner list.
const youtubeAdminPlayerIdConfig =
  process.env.YOUTUBE_ADMIN_PLAYER_IDS || process.env.YOUTUBE_ADMIN_PLAYER_ID || "EA-4CD88B-8126BD";
const youtubeAdminPlayers = new Set(youtubeAdminPlayerIdConfig
  .split(/[,;\n\r]+/).map(value => value.trim().toUpperCase())
  .filter(value => /^EA-[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/.test(value)));
const YOUTUBE_ACCESS_FILE = process.env.YOUTUBE_ACCESS_FILE || path.join(__dirname, "eclipse-youtube-access.json");
let youtubeAccessData = { requests: [], approved: [] };
function loadYoutubeAccess() {
  try {
    const saved = JSON.parse(fs.readFileSync(YOUTUBE_ACCESS_FILE, "utf8"));
    if (saved && Array.isArray(saved.requests) && Array.isArray(saved.approved)) {
      youtubeAccessData = { requests: saved.requests.filter(r => r && validPlayerId(r.playerId) && typeof r.status === "string").slice(-1000), approved: saved.approved.filter(validPlayerId) };
    }
  } catch (e) { if (e.code !== "ENOENT") console.error("Could not load YouTube access data:", e.message); }
}
function saveYoutubeAccess() {
  const temp = YOUTUBE_ACCESS_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(youtubeAccessData), { mode: 0o600 });
  fs.renameSync(temp, YOUTUBE_ACCESS_FILE);
}
function youtubeIsApproved(id) { return youtubeAccessData.approved.includes(id); }
const MAX_PENDING_INVITES = 10000;

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many registration attempts. Try again later." }
});
const inviteLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many invite attempts. Please wait a moment." }
});
const profileLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many profile updates. Please wait a moment." }
});
function pruneExpiredInvites() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, invite] of invites) if (invite.createdAt < cutoff) invites.delete(id);
}


app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed"));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "12kb", strict: true }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: "draft-7", legacyHeaders: false }));
app.get("/health", (_req, res) => res.json({ ok: true, service: "Eclipse Arena API" }));
// Public, read-only comments endpoint. Keep YOUTUBE_API_KEY on the server, never in frontend files.
app.get("/api/youtube/comments", async (req, res) => {
  const videoId = String(req.query.videoId || "");
  const pageToken = String(req.query.pageToken || "");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "A valid single YouTube video ID is required." });
  }
  if (pageToken && !/^[A-Za-z0-9_-]{1,500}$/.test(pageToken)) {
    return res.status(400).json({ error: "Invalid comments page token." });
  }
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "YouTube comments are not configured yet. The owner must add YOUTUBE_API_KEY to the backend environment." });
  try {
    const params = new URLSearchParams({
      part: "snippet",
      videoId,
      maxResults: "20",
      order: "relevance",
      textFormat: "plainText",
      key: apiKey
    });
    if (pageToken) params.set("pageToken", pageToken);
    const upstream = await fetch("https://www.googleapis.com/youtube/v3/commentThreads?" + params.toString(), {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const reason = payload?.error?.errors?.[0]?.reason || "";
      if (reason === "commentsDisabled" || reason === "disabledComments") {
        return res.json({ comments: [], nextPageToken: "", message: "Comments are disabled for this video." });
      }
      console.error("[YouTube comments API]", upstream.status, reason || "request failed");
      return res.status(upstream.status === 404 ? 404 : 502).json({
        error: reason === "commentsDisabled" || reason === "disabledComments"
          ? "Comments are disabled for this video."
          : "YouTube could not return comments. Check the API key, quota, and video comment settings."
      });
    }
    const comments = (Array.isArray(payload.items) ? payload.items : []).map(item => {
      const snippet = item?.snippet?.topLevelComment?.snippet || {};
      return {
        author: String(snippet.authorDisplayName || "YouTube user").slice(0, 100),
        text: String(snippet.textDisplay || "").slice(0, 5000),
        likeCount: Math.max(0, Number(snippet.likeCount) || 0),
        publishedAt: String(snippet.publishedAt || "")
      };
    });
    return res.json({ comments, nextPageToken: payload.nextPageToken || "" });
  } catch (error) {
    console.error("[YouTube comments request]", error.name || "Error");
    return res.status(504).json({ error: "YouTube comments request timed out. Please try again." });
  }
});

app.get("/api/youtube/access", auth, (req, res) => {
  const playerId = req.player.id;
  const latest = [...youtubeAccessData.requests].reverse().find(r => r.playerId === playerId);
  const isAdmin = youtubeAdminPlayers.has(playerId);
  // Temporary troubleshooting log: reports only the current player ID, admin count, and match result.
  console.log("[YouTube admin check]", {
    currentPlayerId: playerId,
    configuredAdminCount: youtubeAdminPlayers.size,
    isAdmin
  });
  // Owners always have access; other players need a one-entry owner approval.
  const allowed = isAdmin || youtubeIsApproved(playerId);
  // Consume one-entry approvals only for non-owner players.
  if (!isAdmin && allowed && youtubeAccessData.approved.includes(playerId)) {
    youtubeAccessData.approved = youtubeAccessData.approved.filter(id => id !== playerId);
    saveYoutubeAccess();
  }
  return res.json({
    allowed,
    isAdmin,
    requestStatus: latest?.status || "none",
    diagnostics: {
      currentPlayerId: playerId,
      adminIdConfigured: youtubeAdminPlayers.size > 0,
      configuredAdminCount: youtubeAdminPlayers.size,
      currentPlayerIsAdmin: isAdmin
    }
  });
});
app.post("/api/youtube/leave", auth, (req, res) => {
  const playerId = req.player.id;
  const wasApproved = youtubeAccessData.approved.includes(playerId);
  youtubeAccessData.approved = youtubeAccessData.approved.filter(id => id !== playerId);
  if (wasApproved) saveYoutubeAccess();
  res.json({ ok: true, permissionRevoked: wasApproved });
});

app.post("/api/youtube/requests", auth, inviteLimiter, (req, res) => {
  const playerId = req.player.id;
  if (youtubeIsApproved(playerId)) return res.json({ status: "approved", message: "You already have access." });
  const message = cleanText(req.body?.message || "Please approve my access to the YouTube Area.", 240);
  const existing = [...youtubeAccessData.requests].reverse().find(r => r.playerId === playerId && r.status === "pending");
  if (existing) return res.json({ status: "pending", message: "Your request is already waiting for the owner." });
  youtubeAccessData.requests.push({ id: crypto.randomBytes(8).toString("hex"), playerId, name: req.player.profile.name, message, status: "pending", createdAt: new Date().toISOString() });
  youtubeAccessData.requests = youtubeAccessData.requests.slice(-1000);
  saveYoutubeAccess();
  res.status(201).json({ status: "pending", message: "Your request was sent to the owner." });
});
app.get("/api/youtube/requests", auth, (req, res) => {
  if (!youtubeAdminPlayers.has(req.player.id)) return res.status(403).json({ error: "Only the configured Eclipse Arena owner can review requests." });
  res.json({ requests: youtubeAccessData.requests.filter(r => r.status === "pending") });
});
app.post("/api/youtube/requests/:requestId/decision", auth, (req, res) => {
  if (!youtubeAdminPlayers.has(req.player.id)) return res.status(403).json({ error: "Only the configured Eclipse Arena owner can decide requests." });
  const request = youtubeAccessData.requests.find(r => r.id === req.params.requestId && r.status === "pending");
  if (!request) return res.status(404).json({ error: "Request not found or already handled." });
  const decision = req.body?.decision;
  if (decision !== "accept" && decision !== "decline") return res.status(400).json({ error: "Decision must be accept or decline." });
  request.status = decision === "accept" ? "approved" : "declined";
  if (decision === "accept" && !youtubeAccessData.approved.includes(request.playerId)) youtubeAccessData.approved.push(request.playerId);
  if (decision === "decline") youtubeAccessData.approved = youtubeAccessData.approved.filter(id => id !== request.playerId);
  saveYoutubeAccess();
  res.json({ ok: true, status: request.status, playerId: request.playerId });
});

function cleanText(value, max = 24) {
  return String(value ?? "").replace(/[<>\u0000-\u001f]/g, "").trim().slice(0, max);
}
function validPlayerId(id) { return /^EA-[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/.test(String(id || "")); }
function publicProfile(p) {
  return { id: p.id, name: p.profile.name, xp: p.profile.xp, goals: p.profile.goals, saves: p.profile.saves,
    wins: p.profile.wins, best: p.profile.best, player: p.profile.player, goalkeeper: p.profile.goalkeeper,
    ovr: p.profile.ovr, online: Boolean(socketsByPlayer.get(p.id)?.size) };
}
function auth(req, res, next) {
  const match = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.get("authorization") || "");
  const id = match && tokenToPlayer.get(hashToken(match[1]));
  if (!id || !players.has(id)) return res.status(401).json({ error: "Authentication required. Reconnect to the server." });
  req.player = players.get(id);
  next();
}
function normalizeProfile(input = {}) {
  const n = v => Number.isFinite(Number(v)) ? Math.max(0, Math.min(10000000, Math.floor(Number(v))) ) : 0;
  return {
    name: cleanText(input.name || "Eclipse Player", 24) || "Eclipse Player",
    xp: n(input.xp), goals: n(input.goals), saves: n(input.saves), wins: n(input.wins), best: n(input.best),
    player: cleanText(input.player, 40), goalkeeper: cleanText(input.goalkeeper, 40),
    ovr: Math.max(0, Math.min(999, n(input.ovr)))
  };
}
app.post("/api/register", registerLimiter, (req, res) => {
  const profile = normalizeProfile(req.body?.profile);
  const bearer = /^Bearer\s+([a-f0-9]{64})$/i.exec(req.get("authorization") || "");
  const existingId = bearer && tokenToPlayer.get(hashToken(bearer[1]));
  if (existingId && players.has(existingId)) {
    const existing = players.get(existingId);
    existing.profile = profile;
    tokenToPlayer.delete(existing.tokenHash);
    const rotatedToken = crypto.randomBytes(32).toString("hex");
    existing.tokenHash = hashToken(rotatedToken);
    tokenToPlayer.set(existing.tokenHash, existing.id);
    saveData();
    return res.json({ playerId: existing.id, token: rotatedToken });
  }
  if (players.size >= MAX_PLAYERS) return res.status(503).json({ error: "The server is full. Please try again later." });
  let id;
  do { id = "EA-" + crypto.randomBytes(3).toString("hex").toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(); } while (players.has(id));
  const token = crypto.randomBytes(32).toString("hex");
  const player = { id, tokenHash: hashToken(token), profile, friends: new Set() };
  players.set(id, player);
  tokenToPlayer.set(player.tokenHash, id);
  saveData();
  res.status(201).json({ playerId: id, token });
});
app.put("/api/profile", auth, profileLimiter, (req, res) => {
  req.player.profile = normalizeProfile(req.body?.profile);
  saveData();
  res.json({ profile: publicProfile(req.player) });
});
app.get("/api/friends", auth, (req, res) => {
  const friends = [...req.player.friends].map(id => players.get(id)).filter(Boolean).map(publicProfile);
  res.json({ friends });
});
app.post("/api/friends", auth, (req, res) => {
  const id = cleanText(req.body?.friendId, 24).toUpperCase();
  if (!validPlayerId(id)) return res.status(400).json({ error: "Invalid player ID" });
  if (id === req.player.id) return res.status(400).json({ error: "You cannot add yourself" });
  const friend = players.get(id);
  if (!friend) return res.status(404).json({ error: "Player not found on this server" });
  if (req.player.friends.size >= 100) return res.status(429).json({ error: "Friend limit reached" });
  req.player.friends.add(id);
  friend.friends.add(req.player.id);
  saveData();
  res.status(201).json({ friend: publicProfile(friend) });
});
app.post("/api/friends/remove", auth, (req, res) => {
  const id = cleanText(req.body?.friendId, 24).toUpperCase();
  req.player.friends.delete(id);
  players.get(id)?.friends.delete(req.player.id);
  saveData();
  res.json({ ok: true });
});
// Admin can inspect public player profiles only. Authentication tokens and private account secrets are never returned.
app.get("/api/admin/players", auth, (req, res) => {
  if (!youtubeAdminPlayers.has(req.player.id)) {
    return res.status(403).json({ error: "Admin access required." });
  }
  const all = [...players.values()].map(publicProfile)
    .sort((a, b) => Number(b.online) - Number(a.online) || b.xp - a.xp || a.name.localeCompare(b.name));
  res.json({ players: all, total: all.length, online: all.filter(p => p.online).length });
});
app.get("/api/profiles/:id", auth, (req, res) => {
  const id = cleanText(req.params.id, 24).toUpperCase();
  if (!validPlayerId(id)) return res.status(400).json({ error: "Invalid player ID" });
  const p = players.get(id);
  if (!p) return res.status(404).json({ error: "Profile not found" });
  res.json({ profile: publicProfile(p) });
});
app.post("/api/invites", auth, inviteLimiter, (req, res) => {
  pruneExpiredInvites();
  if (invites.size >= MAX_PENDING_INVITES) return res.status(503).json({ error: "Too many pending invites. Try again shortly." });
  const id = cleanText(req.body?.friendId, 24).toUpperCase();
  if (!req.player.friends.has(id)) return res.status(403).json({ error: "Add this player as a friend first" });
  const target = players.get(id);
  if (!target) return res.status(404).json({ error: "Friend is offline or not found" });
  const roomId = crypto.randomBytes(8).toString("hex");
  invites.set(roomId, { from: req.player.id, to: id, createdAt: Date.now() });
  socketsByPlayer.get(id)?.forEach(s => s.emit("friend:invite", { roomId, fromName: req.player.profile.name }));
  res.status(201).json({ roomId });
});
app.use((err, _req, res, _next) => {
  if (res.headersSent) return;
  const status = err.status || (err.type === "entity.too.large" ? 413 : 400);
  res.status(status).json({ error: status === 413 ? "Request body too large" : "Request rejected" });
});

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
  maxHttpBufferSize: 16 * 1024,
  connectTimeout: 10000
});
io.use((socket, next) => {
  const id = cleanText(socket.handshake.auth?.playerId, 24).toUpperCase();
  const token = String(socket.handshake.auth?.token || "");
  const player = players.get(id);
  if (!player || !/^[a-f0-9]{64}$/i.test(token) || player.tokenHash !== hashToken(token)) return next(new Error("Authentication required"));
  socket.data.playerId = id;
  next();
});
io.on("connection", socket => {
  const id = socket.data.playerId;
  if (!socketsByPlayer.has(id)) socketsByPlayer.set(id, new Set());
  socketsByPlayer.get(id).add(socket);
  for (const friendId of players.get(id)?.friends || []) {
    socketsByPlayer.get(friendId)?.forEach(friendSocket => friendSocket.emit("friend:status", { playerId: id, online: true }));
  }
  socket.on("match:accept", payload => {
    pruneExpiredInvites();
    const roomId = cleanText(payload?.roomId, 32);
    const invite = invites.get(roomId);
    if (!invite || invite.to !== id || Date.now() - invite.createdAt > 5 * 60 * 1000) return socket.emit("match:error", { message: "Invite expired or not allowed" });
    const inviterSockets = socketsByPlayer.get(invite.from);
    if (!inviterSockets?.size) {
      invites.delete(roomId);
      return socket.emit("match:error", { message: "The inviting player is no longer online" });
    }
    socket.join(roomId);
    inviterSockets.forEach(s => s.join(roomId));
    activeMatches.set(roomId, { players: new Set([invite.from, invite.to]), createdAt: Date.now() });
    invites.delete(roomId);
    io.to(roomId).emit("match:ready", { roomId });
  });
  socket.on("match:decline", payload => {
    const roomId = cleanText(payload?.roomId, 32), invite = invites.get(roomId);
    if (invite?.to === id) invites.delete(roomId);
  });
  socket.on("match:state", payload => {
    const roomId = cleanText(payload?.roomId, 32);
    const match = activeMatches.get(roomId);
    if (!match || !match.players.has(id) || !socket.rooms.has(roomId)) return;
    if (Date.now() - match.createdAt > 2 * 60 * 60 * 1000) {
      activeMatches.delete(roomId);
      return;
    }
    const state = payload?.state;
    if (!state || !Number.isFinite(Number(state.x)) || !Number.isFinite(Number(state.y))) return;
    const safeState = {
      x: Math.max(0.05, Math.min(0.95, Number(state.x))),
      y: Math.max(0.05, Math.min(0.95, Number(state.y))),
      goals: Math.max(0, Math.min(99, Math.floor(Number(state.goals) || 0))),
      hasBall: Boolean(state.hasBall),
      clock: Math.max(0, Math.min(90, Number(state.clock) || 0))
    };
    socket.to(roomId).emit("match:state", {
      roomId,
      fromName: players.get(id)?.profile.name || "Friend",
      playerId: id,
      state: safeState
    });
  });
  socket.on("disconnect", () => {
    socketsByPlayer.get(id)?.delete(socket);
    if (!socketsByPlayer.get(id)?.size) socketsByPlayer.delete(id);
    for (const [roomId, match] of activeMatches) {
      if (match.players.has(id)) {
        activeMatches.delete(roomId);
        io.to(roomId).emit("match:ended", { message: "A player disconnected" });
      }
    }
    for (const friendId of players.get(id)?.friends || []) {
      socketsByPlayer.get(friendId)?.forEach(s => s.emit("friend:status", { playerId: id, online: false }));
    }
  });
});
loadData();
loadYoutubeAccess();
server.listen(PORT, () => console.log("Eclipse Arena API listening on " + PORT));
