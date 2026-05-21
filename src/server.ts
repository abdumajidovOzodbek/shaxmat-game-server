// -----------------------------------------------------------------------------
// HTTP + WebSocket server. Each WebSocket maps to one user (set by `hello`).
// State is in-memory: matchmaker, games keyed by id, sockets keyed by user id.
// Clocks are ticked every 250 ms to expire timeouts even without moves.
// -----------------------------------------------------------------------------

import express from "express";
import cors from "cors";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "./config.js";
import { Game } from "./game.js";
import { Matchmaker } from "./matchmaker.js";
import type {
  ClientMessage,
  ServerMessage,
  UserIdentity,
} from "./protocol.js";

interface ClientState {
  user: UserIdentity | null;
  /** Games this socket is "in"; usually 0 or 1. */
  gameIds: Set<string>;
}

const matchmaker = new Matchmaker();
const games = new Map<string, Game>();
/** Direct (non-matchmade) games waiting for the two specified users to join. */
const pendingDirect = new Map<string, { gameId: string; whiteId: string; blackId: string; tc: { initial: number; increment: number }; createdAt: number; }>();
/** Map from userId to active sockets (a user may have multiple tabs/devices). */
const sockets = new Map<string, Set<WebSocket>>();
/** Per-socket state. */
const states = new WeakMap<WebSocket, ClientState>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

function broadcastToUser(userId: string, msg: ServerMessage) {
  const set = sockets.get(userId);
  if (!set) return;
  for (const ws of set) send(ws, msg);
}

function broadcastGameState(game: Game, override?: ServerMessage["type"]) {
  const snap = game.snapshot();
  const type = override ?? (snap.status === "finished" ? "gameOver" : "gameState");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg: ServerMessage = { type, game: snap } as any;
  broadcastToUser(game.white.id, msg);
  broadcastToUser(game.black.id, msg);
}

function attachUser(ws: WebSocket, user: UserIdentity) {
  const state = states.get(ws);
  if (!state) return;
  state.user = user;

  const set = sockets.get(user.id) ?? new Set();
  set.add(ws);
  sockets.set(user.id, set);
}

function detachSocket(ws: WebSocket) {
  const state = states.get(ws);
  if (!state) return;
  if (state.user) {
    const set = sockets.get(state.user.id);
    if (set) {
      set.delete(ws);
      if (set.size === 0) sockets.delete(state.user.id);
    }
    matchmaker.remove(state.user.id);
  }
  states.delete(ws);
}

function handleMessage(ws: WebSocket, msg: ClientMessage) {
  const state = states.get(ws);
  if (!state) return;

  switch (msg.type) {
    case "hello": {
      attachUser(ws, msg.user);
      send(ws, { type: "welcome", serverTime: Date.now() });
      break;
    }
    case "ping": {
      send(ws, { type: "pong", serverTime: Date.now() });
      break;
    }
    case "seek": {
      if (!state.user) return send(ws, { type: "error", message: "Send hello first" });
      const game = matchmaker.enqueue({
        user: state.user,
        tc: msg.tc,
        enqueuedAt: Date.now(),
      });
      if (!game) {
        send(ws, { type: "seeking", tc: msg.tc });
      } else {
        games.set(game.id, game);
        // Tell each player they have a game and which color they are.
        const snap = game.snapshot();
        broadcastToUser(game.white.id, { type: "gameStart", game: snap, you: "w" });
        broadcastToUser(game.black.id, { type: "gameStart", game: snap, you: "b" });
      }
      break;
    }
    case "cancelSeek": {
      if (state.user && matchmaker.remove(state.user.id)) {
        send(ws, { type: "seekCancelled" });
      }
      break;
    }
    case "joinGame": {
      const game = games.get(msg.gameId);
      if (!game) return send(ws, { type: "error", message: "Game not found" });
      if (!state.user) return send(ws, { type: "error", message: "Send hello first" });
      const youColor =
        state.user.id === game.white.id ? "w" :
        state.user.id === game.black.id ? "b" : null;
      if (!youColor) return send(ws, { type: "error", message: "Not a participant" });
      state.gameIds.add(game.id);
      send(ws, { type: "gameStart", game: game.snapshot(), you: youColor });
      break;
    }
    case "move": {
      const game = games.get(msg.gameId);
      if (!game || !state.user) return;
      const snap = game.applyMove(state.user.id, msg.uci);
      if (snap) {
        broadcastGameState(game);
      } else {
        send(ws, { type: "error", message: "Illegal move" });
      }
      break;
    }
    case "resign": {
      const game = games.get(msg.gameId);
      if (!game || !state.user) return;
      if (game.resign(state.user.id)) broadcastGameState(game);
      break;
    }
    case "offerDraw": {
      const game = games.get(msg.gameId);
      if (!game || !state.user) return;
      if (game.offerDraw(state.user.id)) {
        const turn = game.snapshot().drawOffer?.from;
        if (turn) {
          // Notify the opponent specifically with `drawOffered`, plus the
          // updated state to both.
          broadcastGameState(game);
          const opponentId = turn === "w" ? game.black.id : game.white.id;
          broadcastToUser(opponentId, { type: "drawOffered", from: turn });
        }
      }
      break;
    }
    case "acceptDraw": {
      const game = games.get(msg.gameId);
      if (!game || !state.user) return;
      if (game.acceptDraw(state.user.id)) broadcastGameState(game);
      break;
    }
    case "declineDraw": {
      const game = games.get(msg.gameId);
      if (!game || !state.user) return;
      if (game.declineDraw(state.user.id)) {
        broadcastGameState(game);
        broadcastToUser(game.white.id, { type: "drawDeclined" });
        broadcastToUser(game.black.id, { type: "drawDeclined" });
      }
      break;
    }
  }
}

function tickClocks() {
  for (const [id, game] of games) {
    const snap = game.tick();
    if (snap) {
      broadcastGameState(game);
    }
    if (game.isFinished()) {
      // Keep finished games around briefly so clients can read the final state,
      // then garbage-collect after 5 minutes.
      setTimeout(() => {
        games.delete(id);
        pendingDirect.delete(id);
      }, 5 * 60_000);
    }
  }
  // Expire pending direct games that nobody joined within an hour.
  const now = Date.now();
  for (const [id, p] of pendingDirect) {
    if (now - p.createdAt > 60 * 60_000) {
      pendingDirect.delete(id);
      games.delete(id);
    }
  }
}

export function buildServer() {
  const app = express();
  // Allow our local dev origin, Vercel production, and any Vercel preview
  // deploy of the chess project (subdomain style).
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      if (/^https:\/\/shaxmat-chess(-[a-z0-9-]+)?\.vercel\.app$/.test(origin)) {
        return cb(null, true);
      }
      cb(new Error(`Origin ${origin} not allowed`));
    },
    credentials: false,
  }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      games: games.size,
      seekers: matchmaker.describe(),
      sockets: sockets.size,
      pendingDirect: pendingDirect.size,
    });
  });

  /**
   * Create a direct (challenge-style) pending game. Used by the Telegram bot
   * after both players accept a `/challenge` invite. Returns a gameId that
   * the bot embeds into the Mini App start_param so each player can join.
   *
   * Body: { whiteUser, blackUser, tc: {initial, increment}, secret? }
   */
  app.post("/direct", (req, res) => {
    if (config.botSecret) {
      const provided = req.header("x-bot-secret");
      if (provided !== config.botSecret) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }
    const { whiteUser, blackUser, tc } = (req.body ?? {}) as {
      whiteUser?: UserIdentity;
      blackUser?: UserIdentity;
      tc?: { initial: number; increment: number };
    };
    if (!whiteUser?.id || !blackUser?.id || !tc?.initial) {
      return res.status(400).json({ error: "Invalid body" });
    }
    // Build the game now and store it directly. Both sides will `joinGame`
    // when they open the Mini App; the second join just attaches.
    const game = new Game(tc, whiteUser, blackUser);
    game.start();
    games.set(game.id, game);
    pendingDirect.set(game.id, {
      gameId: game.id,
      whiteId: whiteUser.id,
      blackId: blackUser.id,
      tc,
      createdAt: Date.now(),
    });
    res.json({ gameId: game.id });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    states.set(ws, { user: null, gameIds: new Set() });

    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: "error", message: "Bad JSON" });
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ws] handler error", err);
        send(ws, { type: "error", message: "Server error" });
      }
    });

    ws.on("close", () => detachSocket(ws));
    ws.on("error", () => detachSocket(ws));
  });

  setInterval(tickClocks, 250);

  return server;
}
