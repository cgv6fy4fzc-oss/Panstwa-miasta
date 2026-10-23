import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// One row per game room, addressed by its 4-digit PIN.
export const rooms = pgTable("rooms", {
  pin: text().primaryKey(),
  host: text().notNull(),
  players: jsonb().$type<string[]>().notNull().default([]),
  // lobby | playing | stop | voting | results
  status: text().notNull().default("lobby"),
  letter: text().notNull().default(""),
  timeSelection: text("time_selection").notNull().default("unlimited"),
  categories: jsonb()
    .$type<string[]>()
    .notNull()
    .default(["Państwo", "Miasto", "Roślina / Zwierzę", "Imię", "Rzecz"]),
  totalRounds: integer("total_rounds").notNull().default(1),
  round: integer().notNull().default(0),
  // answers[player] = one string per category (index-aligned with `categories`)
  answers: jsonb().$type<Record<string, string[]>>().notNull().default({}),
  // votes["target\u0001catIndex\u0001voter"] = true (ok) | false (rejected)
  votes: jsonb().$type<Record<string, boolean>>().notNull().default({}),
  scores: jsonb().$type<Record<string, number>>().notNull().default({}),
  roundScores: jsonb("round_scores").$type<Record<string, number>>().notNull().default({}),
  // Incremented on every change so clients can ignore stale poll responses.
  version: integer().notNull().default(1),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
