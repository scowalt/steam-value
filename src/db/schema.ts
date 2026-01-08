import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  steamAppId: integer("steam_app_id").unique().notNull(),
  name: text("name").notNull(),
  steamReviewScore: integer("steam_review_score"), // 0-100 positive percentage
  steamReviewCount: integer("steam_review_count"),
  hltbId: integer("hltb_id"),
  hltbMain: real("hltb_main"), // hours
  hltbMainExtra: real("hltb_main_extra"), // hours
  hltbCompletionist: real("hltb_completionist"), // hours
  valueScore: real("value_score"),
  isEndless: integer("is_endless", { mode: "boolean" }).default(false), // MMO/survival/multiplayer games
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
