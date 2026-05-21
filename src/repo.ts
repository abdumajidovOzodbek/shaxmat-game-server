// -----------------------------------------------------------------------------
// Repository: persistence boundary for users + finished games. Falls back to
// in-memory if no DATABASE_URL is configured, so dev still works.
// -----------------------------------------------------------------------------

import { db, schema } from "./db.js";
import { eq, desc, sql } from "drizzle-orm";
import { update as glickoUpdate, type GameOutcome } from "./glicko2.js";
import type { GameSnapshot, UserIdentity, TimeControl } from "./protocol.js";

interface UserRow {
  id: string;
  name: string;
  username?: string;
  rating: number;
  rd: number;
  vol: number;
  gamesPlayed: number;
}

const memUsers = new Map<string, UserRow>();
const memGames: schema.NewGame[] = [];

function defaultUser(u: UserIdentity): UserRow {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    rating: 1500,
    rd: 350,
    vol: 0.06,
    gamesPlayed: 0,
  };
}

export async function getOrCreateUser(u: UserIdentity): Promise<UserRow> {
  if (db) {
    const existing = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, u.id))
      .limit(1);
    if (existing.length > 0) {
      const row = existing[0];
      // Refresh display name/username if changed.
      if (row.name !== u.name || (u.username && row.username !== u.username)) {
        await db.update(schema.users)
          .set({
            name: u.name,
            username: u.username ?? row.username,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, u.id));
      }
      return {
        id: row.id,
        name: row.name,
        username: row.username ?? undefined,
        rating: row.rating,
        rd: row.rd,
        vol: row.vol,
        gamesPlayed: row.gamesPlayed,
      };
    }
    await db.insert(schema.users).values({
      id: u.id, name: u.name, username: u.username,
    });
    return defaultUser(u);
  }
  // In-memory fallback
  const existing = memUsers.get(u.id);
  if (existing) {
    existing.name = u.name;
    if (u.username) existing.username = u.username;
    return existing;
  }
  const fresh = defaultUser(u);
  memUsers.set(u.id, fresh);
  return fresh;
}

export async function getUser(id: string): Promise<UserRow | null> {
  if (db) {
    const r = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    if (r.length === 0) return null;
    const row = r[0];
    return {
      id: row.id, name: row.name, username: row.username ?? undefined,
      rating: row.rating, rd: row.rd, vol: row.vol, gamesPlayed: row.gamesPlayed,
    };
  }
  return memUsers.get(id) ?? null;
}

export async function topUsers(limit = 10): Promise<UserRow[]> {
  if (db) {
    const rows = await db
      .select()
      .from(schema.users)
      .orderBy(desc(schema.users.rating))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id, name: r.name, username: r.username ?? undefined,
      rating: r.rating, rd: r.rd, vol: r.vol, gamesPlayed: r.gamesPlayed,
    }));
  }
  return [...memUsers.values()].sort((a, b) => b.rating - a.rating).slice(0, limit);
}

export interface RatingChange {
  whiteBefore: number;
  blackBefore: number;
  whiteAfter:  number;
  blackAfter:  number;
}

/**
 * Persist a finished game and update both players' ratings via Glicko-2.
 * Returns the rating changes for use in messaging.
 */
export async function recordFinishedGame(
  snapshot: GameSnapshot,
  tc: TimeControl,
  startedAt: Date,
): Promise<RatingChange | null> {
  if (snapshot.status !== "finished" || !snapshot.result) return null;

  const r = snapshot.result;
  let outcome: "white" | "black" | "draw";
  let whiteScore: GameOutcome;
  let blackScore: GameOutcome;
  switch (r.kind) {
    case "checkmate":
    case "resign":
    case "timeout": {
      outcome = r.winner === "w" ? "white" : "black";
      whiteScore = r.winner === "w" ? 1 : 0;
      blackScore = r.winner === "b" ? 1 : 0;
      break;
    }
    case "stalemate":
    case "draw":
      outcome = "draw"; whiteScore = 0.5; blackScore = 0.5;
      break;
    case "abort":
      // Don't rate aborted games.
      outcome = "draw"; whiteScore = 0.5; blackScore = 0.5;
      break;
  }

  const white = await getOrCreateUser(snapshot.white.user);
  const black = await getOrCreateUser(snapshot.black.user);

  // Skip rating for guest accounts; record game only.
  const ratable = !white.id.startsWith("guest:") && !black.id.startsWith("guest:");

  let newWhite = { rating: white.rating, rd: white.rd, vol: white.vol };
  let newBlack = { rating: black.rating, rd: black.rd, vol: black.vol };
  if (ratable && r.kind !== "abort") {
    newWhite = glickoUpdate({ rating: white.rating, rd: white.rd, vol: white.vol },
                            { rating: black.rating, rd: black.rd, vol: black.vol },
                            whiteScore);
    newBlack = glickoUpdate({ rating: black.rating, rd: black.rd, vol: black.vol },
                            { rating: white.rating, rd: white.rd, vol: white.vol },
                            blackScore);
  }

  const change: RatingChange = {
    whiteBefore: white.rating,
    blackBefore: black.rating,
    whiteAfter:  newWhite.rating,
    blackAfter:  newBlack.rating,
  };

  if (db) {
    if (ratable && r.kind !== "abort") {
      await db.update(schema.users)
        .set({
          rating: newWhite.rating,
          rd: newWhite.rd,
          vol: newWhite.vol,
          gamesPlayed: white.gamesPlayed + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, white.id));
      await db.update(schema.users)
        .set({
          rating: newBlack.rating,
          rd: newBlack.rd,
          vol: newBlack.vol,
          gamesPlayed: black.gamesPlayed + 1,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, black.id));
    }
    await db.insert(schema.games).values({
      id: snapshot.gameId,
      whiteId: white.id,
      blackId: black.id,
      initialSec: tc.initial,
      incrementSec: tc.increment,
      outcome,
      resultKind: r.kind,
      resultDetail: r.kind === "draw" ? r.reason : null,
      moves: snapshot.moves.join(" "),
      whiteRatingBefore: change.whiteBefore,
      blackRatingBefore: change.blackBefore,
      whiteRatingAfter:  change.whiteAfter,
      blackRatingAfter:  change.blackAfter,
      finalFen: snapshot.fen,
      startedAt,
    });
  } else {
    if (ratable && r.kind !== "abort") {
      Object.assign(white, newWhite, { gamesPlayed: white.gamesPlayed + 1 });
      Object.assign(black, newBlack, { gamesPlayed: black.gamesPlayed + 1 });
    }
    memGames.push({
      id: snapshot.gameId,
      whiteId: white.id, blackId: black.id,
      initialSec: tc.initial, incrementSec: tc.increment,
      outcome, resultKind: r.kind,
      resultDetail: r.kind === "draw" ? r.reason : null,
      moves: snapshot.moves.join(" "),
      whiteRatingBefore: change.whiteBefore,
      blackRatingBefore: change.blackBefore,
      whiteRatingAfter:  change.whiteAfter,
      blackRatingAfter:  change.blackAfter,
      finalFen: snapshot.fen,
      startedAt,
    });
  }
  return change;
}

/** Quick stat for /health debugging. */
export async function userCount(): Promise<number> {
  if (db) {
    const r = await db.execute(sql`select count(*)::int as c from ${schema.users}`);
    // postgres-js returns array of rows
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r as unknown as Array<{ c: number }>)[0]?.c ?? 0;
  }
  return memUsers.size;
}
