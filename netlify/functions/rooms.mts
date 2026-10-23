import type { Config, Context } from "@netlify/functions";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { rooms } from "../../db/schema.js";

const LETTERS = "ABCDEFGHIJKLMNOPRSTWYZ";
const TIME_OPTIONS = ["unlimited", "30", "60"];
const MAX_PLAYERS = 20;

type Room = typeof rooms.$inferSelect;

const error = (message: string, status: number) => Response.json({ error: message }, { status });

const SEP = "\u0001";
const MAX_CATEGORIES = 15;
const ROUND_OPTIONS = [1, 3, 5, 10];

// Answers and votes stay hidden until the voting phase starts.
const toClient = (room: Room) => {
  const reveal = room.status === "voting" || room.status === "results";
  return {
    pin: room.pin,
    host: room.host,
    players: room.players,
    status: room.status,
    letter: room.letter,
    timeSelection: room.timeSelection,
    categories: room.categories,
    totalRounds: room.totalRounds,
    round: room.round,
    submitted: Object.keys(room.answers),
    answers: reveal ? room.answers : {},
    votes: reveal ? room.votes : {},
    scores: room.scores,
    roundScores: room.roundScores,
    version: room.version,
  };
};

const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

type Hints = Record<string, (boolean | null)[]>;

const cap = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const titleVariants = (w: string) => {
  const t = w.replace(/[|#<>\[\]{}_]/g, " ").trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  return [...new Set([cap(t), cap(lower), lower.split(" ").map(cap).join(" ")])].filter(Boolean);
};

// Does a page with one of these titles exist on the given wiki? null = lookup failed.
async function wikiLookup(host: string, titles: string[]): Promise<Set<string> | null> {
  const found = new Set<string>();
  const chunks: string[][] = [];
  for (let i = 0; i < titles.length; i += 50) chunks.push(titles.slice(i, i + 50));
  try {
    await Promise.all(
      chunks.map(async (chunk) => {
        const url = `https://${host}/w/api.php?action=query&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(chunk.join("|"))}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "panstwa-miasta-game/1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data: any = await res.json();
        const toMap = (arr?: { from: string; to: string }[]) => new Map((arr ?? []).map((x) => [x.from, x.to]));
        const normalized = toMap(data.query?.normalized);
        const redirects = toMap(data.query?.redirects);
        const ok = new Set<string>(
          (data.query?.pages ?? []).filter((pg: any) => !pg.missing && !pg.invalid).map((pg: any) => pg.title),
        );
        for (const t of chunk) {
          const n = normalized.get(t) ?? t;
          if (ok.has(redirects.get(n) ?? n)) found.add(t);
        }
      }),
    );
    return found;
  } catch {
    return null;
  }
}

// true = found in Wikipedia/Wiktionary, false = not found, null = unknown (empty answer or lookup failed).
async function checkAnswers(room: Room): Promise<Hints> {
  const words = new Set<string>();
  for (const p of room.players)
    for (const a of room.answers[p] ?? []) if (a.trim()) titleVariants(a).forEach((v) => words.add(v));
  const list = [...words];
  const [wp, wt] = list.length
    ? await Promise.all([wikiLookup("pl.wikipedia.org", list), wikiLookup("pl.wiktionary.org", list)])
    : [new Set<string>(), new Set<string>()];
  const hints: Hints = {};
  for (const p of room.players) {
    hints[p] = (room.answers[p] ?? []).map((a) => {
      if (!a.trim()) return null;
      if (titleVariants(a).some((v) => wp?.has(v) || wt?.has(v))) return true;
      return wp === null || wt === null ? null : false;
    });
  }
  return hints;
}

// Scoring: 15 = unique answer, 10 = shared by 2+ players, 5 = shared by everyone, 0 = empty/rejected.
function scoreRound(room: Room, hints: Hints) {
  const result: Record<string, number> = Object.fromEntries(room.players.map((p) => [p, 0]));
  room.categories.forEach((_, ci) => {
    const valid: { player: string; key: string }[] = [];
    for (const player of room.players) {
      const text = (room.answers[player]?.[ci] ?? "").trim();
      if (!text || text[0].toUpperCase() !== room.letter) continue;
      let ok = 0;
      let bad = 0;
      for (const voter of room.players) {
        if (voter === player) continue;
        const v = room.votes[[player, ci, voter].join(SEP)];
        if (v === true) ok++;
        else if (v === false) bad++;
      }
      if (bad > ok) continue;
      // Not found in any dictionary: rejected unless somebody explicitly confirmed it.
      if (hints[player]?.[ci] === false && ok === 0) continue;
      valid.push({ player, key: norm(text) });
    }
    for (const { player, key } of valid) {
      // 15 = nobody else has the same answer, 5 = every player has it, 10 = two or more (not all).
      const same = valid.filter((x) => x.key === key).length;
      if (same === 1) result[player] += 15;
      else if (same === room.players.length) result[player] += 5;
      else result[player] += 10;
    }
  });
  return result;
}

function cleanCategories(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list = value
    .map((c) => (typeof c === "string" ? c.trim().slice(0, 30) : ""))
    .filter(Boolean)
    .slice(0, MAX_CATEGORIES);
  return list.length ? list : null;
}

function nextLetter(previous: string) {
  let letter = previous;
  while (letter === previous) letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return letter;
}

const cleanName = (value: unknown) =>
  typeof value === "string" ? value.trim().slice(0, 24) : "";

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function createRoom(req: Request) {
  const name = cleanName((await readBody(req)).name);
  if (!name) return error("Podaj pseudonim.", 400);

  // Rooms are short-lived; drop anything idle for more than 12 hours.
  await db.delete(rooms).where(lt(rooms.updatedAt, sql`now() - interval '12 hours'`));

  for (let attempt = 0; attempt < 10; attempt++) {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    const [room] = await db
      .insert(rooms)
      .values({ pin, host: name, players: [name] })
      .onConflictDoNothing()
      .returning();
    if (room) return Response.json(toClient(room), { status: 201 });
  }
  return error("Nie udało się wygenerować wolnego kodu PIN. Spróbuj ponownie.", 503);
}

async function getRoom(pin: string) {
  const [room] = await db.select().from(rooms).where(eq(rooms.pin, pin));
  return room;
}

async function joinRoom(req: Request, pin: string) {
  const name = cleanName((await readBody(req)).name);
  if (!name) return error("Podaj pseudonim.", 400);

  const room = await getRoom(pin);
  if (!room) return error(`Nie znaleziono pokoju o kodzie: ${pin}`, 404);
  if (room.players.includes(name)) return Response.json(toClient(room));
  if (room.players.length >= MAX_PLAYERS) return error("Pokój jest pełny.", 409);

  // Append atomically so simultaneous joins don't overwrite each other.
  const [updated] = await db
    .update(rooms)
    .set({
      players: sql`${rooms.players} || ${JSON.stringify([name])}::jsonb`,
      version: sql`${rooms.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(rooms.pin, pin), sql`NOT (${rooms.players} ? ${name})`))
    .returning();

  return Response.json(toClient(updated ?? (await getRoom(pin))!));
}

async function changeState(req: Request, pin: string) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  const action = body.action;

  const room = await getRoom(pin);
  if (!room) return error(`Nie znaleziono pokoju o kodzie: ${pin}`, 404);
  if (!room.players.includes(name)) return error("Nie jesteś w tym pokoju.", 403);

  const isHost = room.host === name;
  const hostOnly = () => error("Tylko gospodarz może to zrobić.", 403);
  let changes: Partial<Room>;

  if (action === "start") {
    if (!isHost) return hostOnly();
    const timeSelection = TIME_OPTIONS.includes(body.timeSelection as string)
      ? (body.timeSelection as string)
      : "unlimited";
    const totalRounds = ROUND_OPTIONS.includes(Number(body.totalRounds)) ? Number(body.totalRounds) : 1;
    const categories = cleanCategories(body.categories) ?? room.categories;
    changes = {
      status: "playing", letter: nextLetter(""), timeSelection, categories, totalRounds,
      round: 1, answers: {}, votes: {}, scores: {}, roundScores: {},
    };
  } else if (action === "stop") {
    if (room.status !== "playing") return Response.json(toClient(room));
    changes = { status: "stop" };
  } else if (action === "submit") {
    if (room.status !== "playing" && room.status !== "stop") return Response.json(toClient(room));
    const raw = Array.isArray(body.answers) ? body.answers : [];
    const mine = room.categories.map((_, i) => (typeof raw[i] === "string" ? raw[i].trim().slice(0, 40) : ""));
    const [after] = await db
      .update(rooms)
      .set({
        answers: sql`${rooms.answers} || ${JSON.stringify({ [name]: mine })}::jsonb`,
        version: sql`${rooms.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(rooms.pin, pin))
      .returning();
    if (!after || Object.keys(after.answers).length < after.players.length) {
      return Response.json(toClient(after ?? room));
    }
    changes = { status: "voting" };
  } else if (action === "reveal") {
    if (!isHost) return hostOnly();
    if (room.status !== "playing" && room.status !== "stop") return Response.json(toClient(room));
    changes = { status: "voting" };
  } else if (action === "vote") {
    if (room.status !== "voting") return Response.json(toClient(room));
    const target = cleanName(body.target);
    const ci = Number(body.category);
    if (target === name || !room.players.includes(target) || !Number.isInteger(ci) || ci < 0 || ci >= room.categories.length) {
      return error("Nieprawidłowy głos.", 400);
    }
    const key = [target, ci, name].join(SEP);
    const [voted] = await db
      .update(rooms)
      .set({
        votes: sql`${rooms.votes} || ${JSON.stringify({ [key]: body.ok === true })}::jsonb`,
        version: sql`${rooms.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(rooms.pin, pin))
      .returning();
    return Response.json(toClient(voted));
  } else if (action === "score") {
    if (!isHost) return hostOnly();
    if (room.status !== "voting") return Response.json(toClient(room));
    const roundScores = scoreRound(room, await checkAnswers(room));
    const scores = { ...room.scores };
    for (const p of room.players) scores[p] = (scores[p] ?? 0) + (roundScores[p] ?? 0);
    changes = { status: "results", roundScores, scores };
  } else if (action === "next") {
    if (!isHost) return hostOnly();
    if (room.status !== "results" || room.round >= room.totalRounds) return Response.json(toClient(room));
    const categories = cleanCategories(body.categories) ?? room.categories;
    changes = { status: "playing", letter: nextLetter(room.letter), round: room.round + 1, categories, answers: {}, votes: {}, roundScores: {} };
  } else if (action === "lobby") {
    if (!isHost) return hostOnly();
    changes = { status: "lobby", letter: "", round: 0, answers: {}, votes: {}, scores: {}, roundScores: {} };
  } else if (action === "check") {
    if (room.status !== "voting" && room.status !== "results") return Response.json({ hints: {} });
    return Response.json({ hints: await checkAnswers(room) });
  } else if (action === "kick") {
    if (!isHost) return hostOnly();
    const target = cleanName(body.target);
    if (target === room.host || !room.players.includes(target)) return error("Nie można usunąć tego gracza.", 400);
    const players = room.players.filter((p) => p !== target);
    const answers = { ...room.answers };
    delete answers[target];
    const scores = { ...room.scores };
    delete scores[target];
    const votes = Object.fromEntries(
      Object.entries(room.votes).filter(([k]) => {
        const [t, , v] = k.split(SEP);
        return t !== target && v !== target;
      }),
    );
    changes = { players, answers, scores, votes };
    if ((room.status === "playing" || room.status === "stop") && Object.keys(answers).length >= players.length) {
      changes.status = "voting";
    }
  } else if (action === "host") {
    if (!isHost) return hostOnly();
    const target = cleanName(body.target);
    if (!room.players.includes(target)) return error("Nie ma takiego gracza.", 400);
    changes = { host: target };
  } else {
    return error("Nieznana akcja.", 400);
  }

  const [updated] = await db
    .update(rooms)
    .set({ ...changes, version: sql`${rooms.version} + 1`, updatedAt: sql`now()` })
    .where(eq(rooms.pin, pin))
    .returning();
  return Response.json(toClient(updated));
}

export default async (req: Request, context: Context) => {
  const { pin, action } = context.params;

  try {
    if (!pin) {
      return req.method === "POST" ? await createRoom(req) : error("Method not allowed", 405);
    }
    if (!/^\d{4}$/.test(pin)) return error("Nieprawidłowy kod PIN.", 400);

    if (!action && req.method === "GET") {
      const room = await getRoom(pin);
      return room ? Response.json(toClient(room)) : error(`Nie znaleziono pokoju o kodzie: ${pin}`, 404);
    }
    if (action === "join" && req.method === "POST") return await joinRoom(req, pin);
    if (action === "state" && req.method === "POST") return await changeState(req, pin);

    return error("Not found", 404);
  } catch (err) {
    console.error(err);
    return error("Błąd serwera. Spróbuj ponownie.", 500);
  }
};

export const config: Config = {
  path: ["/api/rooms", "/api/rooms/:pin", "/api/rooms/:pin/:action"],
};
