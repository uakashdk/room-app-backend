// NEW FILE. PrimeArcade games (HTML5 games played in a WebView).
//
// HOW THE COINS WORK (so no coin is ever lost or made up):
//   1. start:   the stake (for example 500 coins) is taken from the wallet and put into a "game session" (arcade_sessions/<id>).
//               Only then PrimeArcade is asked for the launch URL. If PrimeArcade fails, the stake is given back at once.
//   2. rounds:  PrimeArcade tells our server every round (bet, win) on the callback URL. We only add them up on the session.
//   3. end:     when the player closes the game (or the session expires) the session is settled ONCE:
//               payout = what is left in the game (never more than the stake x the maximum multiplier) is put back in the wallet.
// The API key and the callback secret exist ONLY in this server's .env.
import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { env } from '../config/env';
import { db } from '../config/firebase';
import type { AuthedUser } from '../middleware/authenticate';
import { AppError } from '../middleware/error-handler';

export type ArcadeGame = { id: string; name: string; image: string | null };
export type ArcadeSettings = { enabled: boolean; stakes: number[]; maxStake: number; maxPayoutMultiplier: number; games: ArcadeGame[] | null };

const base = () => env.PRIMEARCADE_BASE_URL.replace(/\/+$/, '');

// ---------------------------------------------------------------- settings (app_settings/arcade, edited by the super admin)
let settingsCache: { at: number; value: ArcadeSettings } | null = null;

/** The games are OFF until the super admin sets  app_settings/arcade.enabled = true. */
export async function getArcadeSettings(): Promise<ArcadeSettings> {
  if (settingsCache && Date.now() - settingsCache.at < 30_000) return settingsCache.value;
  const x = (await db.doc('app_settings/arcade').get()).data() ?? {};
  const maxStake = Number.isFinite(Number(x.maxStake)) && Number(x.maxStake) > 0 ? Math.floor(Number(x.maxStake)) : 5000;
  const rawStakes: number[] = Array.isArray(x.stakes) ? x.stakes.map(Number) : [100, 500, 1000, 5000];
  const value: ArcadeSettings = {
    enabled: x.enabled === true,
    stakes: rawStakes.filter((n) => Number.isInteger(n) && n > 0 && n <= maxStake).sort((a, b) => a - b),
    maxStake,
    maxPayoutMultiplier: Number.isFinite(Number(x.maxPayoutMultiplier)) && Number(x.maxPayoutMultiplier) >= 1 ? Number(x.maxPayoutMultiplier) : 20,
    games: Array.isArray(x.games)
      ? x.games
          .map((g: any) => ({ id: String(g.id ?? ''), name: String(g.name ?? g.id ?? ''), image: g.image ? String(g.image) : null }))
          .filter((g: ArcadeGame) => /^[a-z0-9_-]{1,40}$/i.test(g.id))
      : null,
  };
  settingsCache = { at: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- PrimeArcade REST
async function arcadeFetch(path: string, init: { method?: string; body?: object } = {}): Promise<any> {
  if (!env.PRIMEARCADE_API_KEY) throw new AppError(503, 'arcade-not-set-up', 'Games are not set up yet.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${base()}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env.PRIMEARCADE_API_KEY },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
      console.error('PrimeArcade error', path, res.status, JSON.stringify(json)?.slice(0, 300));
      throw new AppError(502, 'arcade-error', 'The game service did not accept the request. Please try again.');
    }
    return json.data ?? json;
  } catch (e: any) {
    if (e instanceof AppError) throw e;
    console.error('PrimeArcade unreachable', path, e?.message);
    throw new AppError(502, 'arcade-unreachable', 'The game service is not reachable right now. Please try again.');
  } finally {
    clearTimeout(timer);
  }
}

let gamesCache: { at: number; list: ArcadeGame[] } | null = null;

/** The games the player can choose: the list the super admin typed (app_settings/arcade.games), else the list from PrimeArcade. */
export async function listGames(): Promise<ArcadeGame[]> {
  const settings = await getArcadeSettings();
  if (settings.games?.length) return settings.games;
  if (gamesCache && Date.now() - gamesCache.at < 5 * 60_000) return gamesCache.list;
  const data = await arcadeFetch('/games');
  const arr: any[] = Array.isArray(data) ? data : Array.isArray(data?.games) ? data.games : [];
  const list: ArcadeGame[] = arr
    .map((g) => ({ id: String(g.id ?? g.gameId ?? g.slug ?? ''), name: String(g.name ?? g.title ?? g.id ?? ''), image: (g.thumbnail ?? g.image ?? g.icon ?? null) as string | null }))
    .filter((g) => /^[a-z0-9_-]{1,40}$/i.test(g.id));
  gamesCache = { at: Date.now(), list };
  return list;
}

// ---------------------------------------------------------------- start
export type StartResult = { sessionId: string; launchUrl: string; stake: number; balance: number; gameId: string };

export async function startGame(user: AuthedUser, input: { gameId: string; stake: number; roomId?: string }): Promise<StartResult> {
  const settings = await getArcadeSettings();
  if (!settings.enabled) throw new AppError(403, 'games-off', 'Games are not open right now.');
  const { gameId, stake } = input;
  if (!Number.isInteger(stake) || stake <= 0 || stake > settings.maxStake || !settings.stakes.includes(stake)) {
    throw new AppError(400, 'bad-stake', 'Choose one of the amounts shown.');
  }
  const games = await listGames();
  if (!games.some((g) => g.id === gameId)) throw new AppError(400, 'bad-game', 'This game is not available.');

  // a person plays one game at a time: a game left open (app closed, phone died) is settled first
  const open = await db.collection('arcade_sessions').where('uid', '==', user.uid).where('status', '==', 'active').limit(5).get();
  for (const d of open.docs) await settleSession(d.id, 'new-game').catch(() => {});

  // ---- step 1: take the stake out of the wallet and open the session (one transaction) ----
  const userRef = db.doc(`users/${user.uid}`);
  const sessionRef = db.collection('arcade_sessions').doc();
  const reserved = await db.runTransaction(async (t) => {
    const u = (await t.get(userRef)).data();
    if (!u) throw new AppError(404, 'user-not-found', 'Your account was not found.');
    if (u.status !== 'active') throw new AppError(403, 'account-blocked', 'Your account cannot play now.');
    const coins = Number(u.coins ?? 0);
    if (coins < stake) throw new AppError(402, 'insufficient-coins', 'You do not have enough coins.');
    const balance = coins - stake;
    t.update(userRef, { coins: balance });
    t.create(sessionRef, {
      uid: user.uid, userId: String(u.userId ?? ''), name: String(u.name ?? ''), gameId, roomId: input.roomId ?? null,
      stake, status: 'starting', totalBet: 0, totalWin: 0, rounds: 0, lastBalance: stake, suspicious: false,
      createdAt: Timestamp.now(), createdAtMs: Date.now(),
    });
    t.create(db.doc(`wallet_transactions/arcade_${sessionRef.id}_stake`), {
      uid: user.uid, type: 'arcade_stake', currency: 'coins', amount: -stake, balanceAfter: balance,
      note: `Game ${gameId}`, refId: sessionRef.id, createdAt: Timestamp.now(),
    });
    return { balance, username: `dv${String(u.userId ?? user.uid.slice(0, 8))}` };
  });

  // ---- step 2: ask PrimeArcade for the launch URL. If it fails, the stake goes back at once. ----
  try {
    const data = await arcadeFetch('/session', { method: 'POST', body: { username: reserved.username, balance: stake, gameId } });
    const token = String(data.token ?? '');
    if (!token || !data.launchUrl) throw new AppError(502, 'arcade-error', 'The game service sent a wrong answer.');
    const url = new URL(String(data.launchUrl), `${base()}/`);
    if (url.host !== new URL(base()).host) throw new AppError(502, 'arcade-error', 'The game service sent a wrong address.');
    await sessionRef.update({
      status: 'active', token, launchUrl: url.toString(), rtp: data.rtp ?? null,
      expiresAtMs: Number(data.expiresAt) || Date.now() + 3 * 60 * 60_000, startedAt: Timestamp.now(),
    });
    return { sessionId: sessionRef.id, launchUrl: url.toString(), stake, balance: reserved.balance, gameId };
  } catch (e: any) {
    await refundStart(sessionRef.id).catch((err) => console.error('Arcade refund failed', sessionRef.id, err?.message));
    throw e;
  }
}

/** The stake of a game that never started goes back to the wallet (once). */
async function refundStart(sessionId: string): Promise<void> {
  const ref = db.doc(`arcade_sessions/${sessionId}`);
  await db.runTransaction(async (t) => {
    const s = (await t.get(ref)).data();
    if (!s || s.status !== 'starting') return;
    const userRef = db.doc(`users/${s.uid}`);
    const coins = Number((await t.get(userRef)).data()?.coins ?? 0);
    t.update(userRef, { coins: coins + s.stake });
    t.update(ref, { status: 'failed', settledAt: Timestamp.now(), payout: s.stake });
    t.create(db.doc(`wallet_transactions/arcade_${sessionId}_refund`), {
      uid: s.uid, type: 'arcade_refund', currency: 'coins', amount: s.stake, balanceAfter: coins + s.stake,
      note: 'Game did not start', refId: sessionId, createdAt: Timestamp.now(),
    });
  });
}

// ---------------------------------------------------------------- rounds (the callback from PrimeArcade)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9 ? Math.floor(v) : null);

/** round.completed: add the round to its session. The same round sent twice is counted once. */
export async function handleRound(data: any): Promise<void> {
  const token = String(data?.token ?? '');
  const bet = num(data?.bet);
  const win = num(data?.win);
  const balance = num(data?.balance);
  if (!token || bet === null || win === null) return;
  const found = await db.collection('arcade_sessions').where('token', '==', token).limit(1).get();
  if (found.empty) return;
  const ref = found.docs[0].ref;
  const key = crypto.createHash('sha1').update(`${token}|${data?.at ?? ''}|${bet}|${win}|${balance ?? ''}`).digest('hex');
  await db.runTransaction(async (t) => {
    const [snap, dup] = await Promise.all([t.get(ref), t.get(ref.collection('rounds').doc(key))]);
    const s = snap.data();
    if (!s || s.status !== 'active' || dup.exists) return; // a late or repeated round is ignored
    const available = s.stake - s.totalBet + s.totalWin;
    t.create(ref.collection('rounds').doc(key), { bet, win, balance, at: Number(data?.at) || Date.now(), receivedAt: Timestamp.now() });
    t.update(ref, {
      totalBet: FieldValue.increment(bet), totalWin: FieldValue.increment(win), rounds: FieldValue.increment(1),
      lastBalance: balance ?? s.lastBalance, lastRoundAt: Timestamp.now(),
      ...(bet > available ? { suspicious: true } : {}), // a bet bigger than what the player had in the game
    });
  });
}

// ---------------------------------------------------------------- end / settle
export type SettleResult = { payout: number; stake: number; balance: number };

/** Puts what is left in the game back into the wallet, ONCE. Used when the player closes the game, and by the sweeper. */
export async function settleSession(sessionId: string, reason: string, onlyUid?: string): Promise<SettleResult> {
  const ref = db.doc(`arcade_sessions/${sessionId}`);
  const settings = await getArcadeSettings();
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const s = snap.data();
    if (!s) throw new AppError(404, 'session-not-found', 'This game was not found.');
    if (onlyUid && s.uid !== onlyUid) throw new AppError(403, 'not-yours', 'This game is not yours.');
    const userRef = db.doc(`users/${s.uid}`);
    const coins = Number((await t.get(userRef)).data()?.coins ?? 0);
    if (s.status !== 'active') return { payout: Number(s.payout ?? 0), stake: s.stake, balance: coins }; // already settled: same answer, no second payment

    // what the player has left: the safer of "stake - bets + wins" (our own sum) and the balance PrimeArcade reported
    const computed = s.stake - s.totalBet + s.totalWin;
    const reported = Number(s.lastBalance ?? s.stake);
    const suspicious = !!s.suspicious || Math.abs(computed - reported) > 1;
    const payout = Math.max(0, Math.min(Math.floor(computed), Math.floor(reported), Math.floor(s.stake * settings.maxPayoutMultiplier)));
    t.update(userRef, { coins: coins + payout });
    t.update(ref, { status: 'settled', payout, settledAt: Timestamp.now(), settledReason: reason, suspicious });
    if (payout > 0) {
      t.create(db.doc(`wallet_transactions/arcade_${sessionId}_payout`), {
        uid: s.uid, type: payout >= s.stake ? 'arcade_win' : 'arcade_return', currency: 'coins', amount: payout, balanceAfter: coins + payout,
        note: `Game ${s.gameId}: bet ${s.totalBet}, won ${s.totalWin}`, refId: sessionId, createdAt: Timestamp.now(),
      });
    }
    return { payout, stake: s.stake, balance: coins + payout };
  });
}

/** Every 5 minutes: settle games that were left open, and give back the stake of games that never started. */
export function startArcadeSweep(): void {
  const run = async () => {
    const now = Date.now();
    const active = await db.collection('arcade_sessions').where('status', '==', 'active').limit(200).get();
    for (const d of active.docs) {
      const x = d.data();
      if ((x.expiresAtMs ?? 0) < now - 2 * 60_000 || (x.createdAtMs ?? now) < now - 6 * 60 * 60_000) await settleSession(d.id, 'expired').catch(() => {});
    }
    const starting = await db.collection('arcade_sessions').where('status', '==', 'starting').limit(100).get();
    for (const d of starting.docs) if ((d.data().createdAtMs ?? now) < now - 5 * 60_000) await refundStart(d.id).catch(() => {});
  };
  const tick = () => run().catch((e) => console.error('Arcade sweep failed:', e?.message ?? e));
  tick();
  setInterval(tick, 5 * 60_000).unref();
}


// ---------------------------------------------------------------- admin (super admin): switch the games on, stakes and the game list
export type ArcadeAdminPatch = { enabled?: boolean; stakes?: number[]; maxStake?: number; maxPayoutMultiplier?: number; games?: ArcadeGame[] | null };

/** What the admin panel shows: the saved settings + whether this server has the PrimeArcade key / callback secret in its .env. */
export async function getArcadeAdminView(): Promise<Record<string, unknown>> {
  settingsCache = null;
  const x = (await db.doc('app_settings/arcade').get()).data() ?? {};
  return {
    enabled: x.enabled === true,
    stakes: Array.isArray(x.stakes) ? x.stakes.map(Number) : [100, 500, 1000, 5000],
    maxStake: Number(x.maxStake ?? 5000),
    maxPayoutMultiplier: Number(x.maxPayoutMultiplier ?? 20),
    games: Array.isArray(x.games) ? x.games : [],
    serverReady: { apiKey: !!env.PRIMEARCADE_API_KEY, webhookSecret: !!env.ARCADE_WEBHOOK_SECRET, baseUrl: base() },
  };
}

export async function saveArcadeSettings(actor: AuthedUser, patch: ArcadeAdminPatch): Promise<void> {
  const data: Record<string, unknown> = {};
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.stakes !== undefined) data.stakes = [...new Set(patch.stakes)].sort((a, b) => a - b);
  if (patch.maxStake !== undefined) data.maxStake = patch.maxStake;
  if (patch.maxPayoutMultiplier !== undefined) data.maxPayoutMultiplier = patch.maxPayoutMultiplier;
  if (patch.games !== undefined) data.games = patch.games ?? [];
  if (data.enabled === true && !env.PRIMEARCADE_API_KEY) {
    throw new AppError(409, 'arcade-not-set-up', 'Put PRIMEARCADE_API_KEY (and ARCADE_WEBHOOK_SECRET) in the backend .env first, then switch the games on.');
  }
  await db.doc('app_settings/arcade').set({ ...data, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: true });
  await db.collection('admin_logs').add({
    actorUid: actor.uid, actorName: actor.name, action: 'update_arcade', collection: 'app_settings', targetId: 'arcade', details: data, at: FieldValue.serverTimestamp(),
  });
  settingsCache = null; // the app sees the change at once
  gamesCache = null;
}
