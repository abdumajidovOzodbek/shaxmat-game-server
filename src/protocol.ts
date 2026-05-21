// -----------------------------------------------------------------------------
// Wire protocol shared between game-server and the Mini App. Each message is
// JSON serialised and sent over a WebSocket. Messages with `type` discriminate.
// -----------------------------------------------------------------------------

export type Color = "w" | "b";

export interface UserIdentity {
  /** Telegram user id, or "guest:<random>" for users not signed into Telegram. */
  id: string;
  name: string;
  /** Optional Telegram username (without @). */
  username?: string;
  /** Optional Telegram photo URL. */
  photoUrl?: string;
}

export interface TimeControl {
  /** Initial seconds per side. */
  initial: number;
  /** Increment seconds added after each move. */
  increment: number;
}

export type ClientMessage =
  | { type: "hello"; user: UserIdentity; /** Raw Telegram WebApp.initData for server-side verification. */ initData?: string }
  | { type: "seek"; tc: TimeControl }
  | { type: "cancelSeek" }
  | { type: "joinGame"; gameId: string }
  | { type: "move"; gameId: string; uci: string }
  | { type: "resign"; gameId: string }
  | { type: "offerDraw"; gameId: string }
  | { type: "acceptDraw"; gameId: string }
  | { type: "declineDraw"; gameId: string }
  | { type: "ping" };

export interface PlayerSnapshot {
  user: UserIdentity;
  color: Color;
  timeMs: number;
}

export interface GameSnapshot {
  gameId: string;
  fen: string;
  /** UCI history. */
  moves: string[];
  white: PlayerSnapshot;
  black: PlayerSnapshot;
  /** Whose turn it is. */
  turn: Color;
  /** Server epoch ms when the current side's clock started. Null if the game hasn't begun. */
  clockStartedAt: number | null;
  status: "waiting" | "active" | "finished";
  result?:
    | { kind: "checkmate"; winner: Color }
    | { kind: "resign"; winner: Color }
    | { kind: "timeout"; winner: Color }
    | { kind: "stalemate" }
    | { kind: "draw"; reason: "agreement" | "fifty" | "threefold" | "insufficient" }
    | { kind: "abort" };
  drawOffer?: { from: Color } | null;
}

export type ServerMessage =
  | { type: "welcome"; serverTime: number }
  | { type: "seeking"; tc: TimeControl }
  | { type: "seekCancelled" }
  | { type: "gameStart"; game: GameSnapshot; you: Color }
  | { type: "gameState"; game: GameSnapshot }
  | { type: "drawOffered"; from: Color }
  | { type: "drawDeclined" }
  | { type: "gameOver"; game: GameSnapshot }
  | { type: "error"; message: string }
  | { type: "pong"; serverTime: number };
