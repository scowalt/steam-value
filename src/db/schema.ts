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
  isOnWishlist: integer("is_on_wishlist", { mode: "boolean" }).default(false),
  isEarlyAccess: integer("is_early_access", { mode: "boolean" }).default(false),
  controllerSupport: text("controller_support"), // "full" | "partial" | null
  releaseDate: text("release_date"), // ISO date string "YYYY-MM-DD"
  isOwned: integer("is_owned", { mode: "boolean" }).default(false),
  playtimeMinutes: integer("playtime_minutes"), // total playtime in minutes
  isIgnored: integer("is_ignored", { mode: "boolean" }).default(false), // ignored on Steam
  // Game modes
  hasSinglePlayer: integer("has_single_player", { mode: "boolean" }).default(false),
  hasMultiplayer: integer("has_multiplayer", { mode: "boolean" }).default(false),
  hasCoOp: integer("has_co_op", { mode: "boolean" }).default(false),
  hasOnlineCoOp: integer("has_online_co_op", { mode: "boolean" }).default(false),
  hasLocalCoOp: integer("has_local_co_op", { mode: "boolean" }).default(false),
  hasPvP: integer("has_pvp", { mode: "boolean" }).default(false),
  hasOnlinePvP: integer("has_online_pvp", { mode: "boolean" }).default(false),
  hasLocalPvP: integer("has_local_pvp", { mode: "boolean" }).default(false),
  hasCrossplatform: integer("has_crossplatform", { mode: "boolean" }).default(false),
  isMMO: integer("is_mmo", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
