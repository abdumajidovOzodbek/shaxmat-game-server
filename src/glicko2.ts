// -----------------------------------------------------------------------------
// Glicko-2 rating system, single-game update.
//
// Reference: Mark E. Glickman, "Example of the Glicko-2 system" (2013).
// http://www.glicko.net/glicko/glicko2.pdf
//
// The system rates on its internal scale (mu, phi) which is offset/scaled from
// the public rating scale by 1500 / 173.7178. We expose update functions that
// operate on the public scale and handle conversion internally.
// -----------------------------------------------------------------------------

const SCALE = 173.7178;
const TAU = 0.5;

export interface RatingState {
  rating: number;
  rd: number;
  vol: number;
}

export type GameOutcome = 1 | 0.5 | 0;

interface MuPhi { mu: number; phi: number; }

function toInternal(s: RatingState): MuPhi {
  return { mu: (s.rating - 1500) / SCALE, phi: s.rd / SCALE };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu: number, muOpp: number, phiOpp: number): number {
  return 1 / (1 + Math.exp(-g(phiOpp) * (mu - muOpp)));
}

/**
 * Update the player's rating after one game vs `opponent` with `score`
 * (1 = win, 0.5 = draw, 0 = loss).
 */
export function update(
  player: RatingState,
  opponent: RatingState,
  score: GameOutcome,
): RatingState {
  const me = toInternal(player);
  const op = toInternal(opponent);

  const gOp = g(op.phi);
  const eOp = E(me.mu, op.mu, op.phi);

  const v = 1 / (gOp * gOp * eOp * (1 - eOp));
  const delta = v * gOp * (score - eOp);

  // Volatility update via Illinois algorithm (Glickman §5).
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    const phi2 = me.phi * me.phi;
    const num = ex * (delta * delta - phi2 - v - ex);
    const den = 2 * (phi2 + v + ex) ** 2;
    return num / den - (x - a) / (TAU * TAU);
  };
  const epsilon = 1e-6;
  let A = a;
  let B: number;
  if (delta * delta > me.phi * me.phi + v) {
    B = Math.log(delta * delta - me.phi * me.phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > epsilon) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; }
    else { fA = fA / 2; }
    B = C; fB = fC;
  }
  const newVol = Math.exp(A / 2);

  const phiStar = Math.sqrt(me.phi * me.phi + newVol * newVol);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = me.mu + newPhi * newPhi * gOp * (score - eOp);

  return {
    rating: 1500 + SCALE * newMu,
    rd: SCALE * newPhi,
    vol: newVol,
  };
}
