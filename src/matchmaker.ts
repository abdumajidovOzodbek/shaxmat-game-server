// -----------------------------------------------------------------------------
// Matchmaker keeps a queue of seekers, one per (initial, increment) bucket.
// When a second seeker arrives, the two are paired and the resulting game is
// returned to the caller. Side selection is randomised.
// -----------------------------------------------------------------------------

import type { TimeControl, UserIdentity } from "./protocol.js";
import { Game } from "./game.js";

interface Seeker {
  user: UserIdentity;
  tc: TimeControl;
  /** Wall-clock ms when seek started. Used to expire stale seeks. */
  enqueuedAt: number;
}

function tcKey(tc: TimeControl): string {
  return `${tc.initial}+${tc.increment}`;
}

export class Matchmaker {
  /** Queue keyed by tcKey. Each list is FIFO. */
  private queues = new Map<string, Seeker[]>();

  /** Find a player to play with `seeker`. Returns a started Game on success. */
  enqueue(seeker: Seeker): Game | null {
    const key = tcKey(seeker.tc);
    const list = this.queues.get(key) ?? [];

    // Prevent self-pairing if the user re-seeks.
    const idx = list.findIndex((s) => s.user.id !== seeker.user.id);
    if (idx >= 0) {
      const opponent = list[idx];
      list.splice(idx, 1);
      if (list.length === 0) this.queues.delete(key);
      else this.queues.set(key, list);

      const whiteFirst = Math.random() < 0.5;
      const game = whiteFirst
        ? new Game(seeker.tc, seeker.user, opponent.user)
        : new Game(seeker.tc, opponent.user, seeker.user);
      game.start();
      return game;
    }

    // No partner. Add to queue, replacing any existing entry for the same user.
    const filtered = list.filter((s) => s.user.id !== seeker.user.id);
    filtered.push(seeker);
    this.queues.set(key, filtered);
    return null;
  }

  /** Remove a user from any queue they're in. */
  remove(userId: string): boolean {
    let removed = false;
    for (const [key, list] of this.queues) {
      const next = list.filter((s) => {
        if (s.user.id === userId) { removed = true; return false; }
        return true;
      });
      if (next.length === 0) this.queues.delete(key);
      else this.queues.set(key, next);
    }
    return removed;
  }

  /** Currently-queued user ids by bucket. Useful for debugging. */
  describe(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [k, v] of this.queues) out[k] = v.map((s) => s.user.id);
    return out;
  }
}
