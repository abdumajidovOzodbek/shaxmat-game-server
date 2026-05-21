// -----------------------------------------------------------------------------
// Server-authoritative chess game with clocks. The board state is owned by
// chess.js; the clock is owned by `Game` itself and ticked by the registry.
// -----------------------------------------------------------------------------

import { Chess } from "chess.js";
import { randomUUID } from "node:crypto";
import type {
  Color,
  GameSnapshot,
  PlayerSnapshot,
  TimeControl,
  UserIdentity,
} from "./protocol.js";

export class Game {
  readonly id: string;
  private chess = new Chess();
  private moves: string[] = [];
  private whiteMs: number;
  private blackMs: number;
  private clockStartedAt: number | null = null;
  private status: GameSnapshot["status"] = "waiting";
  private result: GameSnapshot["result"];
  private drawOffer: GameSnapshot["drawOffer"] = null;
  /** Track whether each side has completed their first move. */
  private whiteMoved = false;
  private blackMoved = false;

  constructor(
    readonly tc: TimeControl,
    readonly white: UserIdentity,
    readonly black: UserIdentity,
  ) {
    this.id = randomUUID();
    this.whiteMs = tc.initial * 1000;
    this.blackMs = tc.initial * 1000;
  }

  /**
   * Transition the game from "waiting" to "active". The clock does NOT start
   * here — it starts on the first move, matching real chess behaviour where
   * white's clock only begins once white plays move 1.
   */
  start(now: number = Date.now()) {
    if (this.status !== "waiting") return;
    this.status = "active";
    // clockStartedAt stays null until the first move is made.
    void now; // unused until first move
  }

  /**
   * Apply a UCI move from the side to move. Returns null if the move is
   * illegal or it's not the requesting player's turn.
   */
  applyMove(playerId: string, uci: string, now: number = Date.now()): GameSnapshot | null {
    if (this.status !== "active") return null;
    const turn = this.chess.turn() as Color;
    const expectedId = turn === "w" ? this.white.id : this.black.id;
    if (playerId !== expectedId) return null;

    // Start the clock only after both sides have made their first move.
    // - Before white's move 1: both clocks frozen.
    // - After white's move 1 (black to move): black's clock still frozen.
    // - After black's move 1 (white to move): both clocks now active.
    if (turn === "w") this.whiteMoved = true;
    else this.blackMoved = true;

    // Deduct elapsed time from the moving side. If they ran out, they lose.
    if (this.clockStartedAt !== null) {
      const elapsed = now - this.clockStartedAt;
      if (turn === "w") this.whiteMs -= elapsed;
      else this.blackMs -= elapsed;

      if ((turn === "w" ? this.whiteMs : this.blackMs) <= 0) {
        this.status = "finished";
        this.result = { kind: "timeout", winner: turn === "w" ? "b" : "w" };
        if (turn === "w") this.whiteMs = 0;
        else this.blackMs = 0;
        this.clockStartedAt = null;
        return this.snapshot();
      }
    }

    // Parse UCI -> { from, to, promotion? }.
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci[4] : undefined;
    let result;
    try {
      result = this.chess.move({ from, to, promotion });
    } catch {
      result = null;
    }
    if (!result) return null;

    this.moves.push(uci);
    // Increment is added AFTER a successful move, like Lichess/Chess.com.
    if (turn === "w") this.whiteMs += this.tc.increment * 1000;
    else this.blackMs += this.tc.increment * 1000;

    // Clear any pending draw offer from the side that just moved (their move
    // implicitly declines). The other side's offer (if any) stays.
    if (this.drawOffer && this.drawOffer.from === turn) this.drawOffer = null;

    // Check terminal conditions on the new position.
    if (this.chess.isCheckmate()) {
      this.status = "finished";
      this.result = { kind: "checkmate", winner: turn };
      this.clockStartedAt = null;
    } else if (this.chess.isStalemate()) {
      this.status = "finished";
      this.result = { kind: "stalemate" };
      this.clockStartedAt = null;
    } else if (this.chess.isInsufficientMaterial()) {
      this.status = "finished";
      this.result = { kind: "draw", reason: "insufficient" };
      this.clockStartedAt = null;
    } else if (this.chess.isThreefoldRepetition()) {
      this.status = "finished";
      this.result = { kind: "draw", reason: "threefold" };
      this.clockStartedAt = null;
    } else if (this.chess.isDraw()) {
      this.status = "finished";
      this.result = { kind: "draw", reason: "fifty" };
      this.clockStartedAt = null;
    } else {
      // Only run the clock if both sides have made their first move.
      this.clockStartedAt = (this.whiteMoved && this.blackMoved) ? now : null;
    }

    return this.snapshot();
  }

  resign(playerId: string): GameSnapshot | null {
    if (this.status !== "active") return null;
    let resignerColor: Color | null = null;
    if (playerId === this.white.id) resignerColor = "w";
    else if (playerId === this.black.id) resignerColor = "b";
    if (!resignerColor) return null;
    this.status = "finished";
    this.result = { kind: "resign", winner: resignerColor === "w" ? "b" : "w" };
    this.clockStartedAt = null;
    return this.snapshot();
  }

  offerDraw(playerId: string): GameSnapshot | null {
    if (this.status !== "active") return null;
    let from: Color | null = null;
    if (playerId === this.white.id) from = "w";
    else if (playerId === this.black.id) from = "b";
    if (!from) return null;
    this.drawOffer = { from };
    return this.snapshot();
  }

  acceptDraw(playerId: string): GameSnapshot | null {
    if (this.status !== "active" || !this.drawOffer) return null;
    let me: Color | null = null;
    if (playerId === this.white.id) me = "w";
    else if (playerId === this.black.id) me = "b";
    if (!me || me === this.drawOffer.from) return null;
    this.status = "finished";
    this.result = { kind: "draw", reason: "agreement" };
    this.drawOffer = null;
    this.clockStartedAt = null;
    return this.snapshot();
  }

  declineDraw(playerId: string): GameSnapshot | null {
    if (!this.drawOffer) return null;
    let me: Color | null = null;
    if (playerId === this.white.id) me = "w";
    else if (playerId === this.black.id) me = "b";
    if (!me || me === this.drawOffer.from) return null;
    this.drawOffer = null;
    return this.snapshot();
  }

  /**
   * Called periodically to expire clocks even when no move is being made.
   * Does nothing before the first move (clockStartedAt is null).
   */
  tick(now: number = Date.now()): GameSnapshot | null {
    if (this.status !== "active" || this.clockStartedAt === null) return null;
    const turn = this.chess.turn() as Color;
    const elapsed = now - this.clockStartedAt;
    const remaining = (turn === "w" ? this.whiteMs : this.blackMs) - elapsed;
    if (remaining <= 0) {
      if (turn === "w") this.whiteMs = 0;
      else this.blackMs = 0;
      this.status = "finished";
      this.result = { kind: "timeout", winner: turn === "w" ? "b" : "w" };
      this.clockStartedAt = null;
      return this.snapshot();
    }
    return null;
  }

  isFinished(): boolean {
    return this.status === "finished";
  }

  /**
   * Build a GameSnapshot. The server includes its current authoritative clock
   * state, so clients can compute the live remaining time (`timeMs - (now - clockStartedAt)`
   * for the side to move).
   */
  snapshot(): GameSnapshot {
    const whitePlayer: PlayerSnapshot = {
      user: this.white,
      color: "w",
      timeMs: Math.max(0, this.whiteMs),
    };
    const blackPlayer: PlayerSnapshot = {
      user: this.black,
      color: "b",
      timeMs: Math.max(0, this.blackMs),
    };
    return {
      gameId: this.id,
      fen: this.chess.fen(),
      moves: this.moves.slice(),
      white: whitePlayer,
      black: blackPlayer,
      turn: this.chess.turn() as Color,
      clockStartedAt: this.clockStartedAt,
      status: this.status,
      result: this.result,
      drawOffer: this.drawOffer,
    };
  }
}
