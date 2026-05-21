// -----------------------------------------------------------------------------
// Drizzle schema for game-server persistence. Two tables:
//   - users   : one row per player, keyed by our protocol user id (tg:<n> or
//               guest:<random>). Holds Glicko-2 rating state.
//   - games   : one row per finished game with both players, time control,
//               result, and resulting rating change.
// -----------------------------------------------------------------------------

import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),                                 // "tg:1234" or "guest:abc"
  name: text("name").notNull(),
  username: text("username"),                                  // Telegram @ without @
  // Glicko-2 rating state. Defaults match the conventional starting values.
  rating: doublePrecision("rating").notNull().default(1500),
  rd:     doublePrecision("rd").notNull().default(350),        // rating deviation
  vol:    doublePrecision("vol").notNull().default(0.06),      // volatility
  gamesPlayed: integer("games_played").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable("games", {
  id: text("id").primaryKey(),
  whiteId: text("white_id").notNull(),
  blackId: text("black_id").notNull(),
  initialSec: integer("initial_sec").notNull(),
  incrementSec: integer("increment_sec").notNull(),
  /** "white" | "black" | "draw" — null while in progress (we only insert on finish). */
  outcome: text("outcome").notNull(),
  resultKind: text("result_kind").notNull(),                   // checkmate | resign | timeout | stalemate | draw | abort
  resultDetail: text("result_detail"),                         // "agreement" | "fifty" | "threefold" | "insufficient" | etc.
  /** UCI move list, joined by spaces. */
  moves: text("moves").notNull(),
  whiteRatingBefore: doublePrecision("white_rating_before").notNull(),
  blackRatingBefore: doublePrecision("black_rating_before").notNull(),
  whiteRatingAfter:  doublePrecision("white_rating_after").notNull(),
  blackRatingAfter:  doublePrecision("black_rating_after").notNull(),
  finalFen: text("final_fen").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>(),        // extensibility
  startedAt:  timestamp("started_at",  { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
