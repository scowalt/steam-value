import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  steamAppId: integer("steam_app_id").unique().notNull(),
  name: text("name").notNull(),
  steamReviewScore: integer("steam_review_score"),  
  steamReviewCount: integer("steam_review_count"),
  hltbId: integer("hltb_id"),
  hltbMain: real("hltb_main"),  
  hltbMainExtra: real("hltb_main_extra"),  
  hltbCompletionist: real("hltb_completionist"),  
  valueScore: real("value_score"),
  isEndless: integer("is_endless", { mode: "boolean" }).default(false),  
  isOnWishlist: integer("is_on_wishlist", { mode: "boolean" }).default(false),
  isEarlyAccess: integer("is_early_access", { mode: "boolean" }).default(false),
  controllerSupport: text("controller_support"),  
  releaseDate: text("release_date"),  
  isOwned: integer("is_owned", { mode: "boolean" }).default(false),
  playtimeMinutes: integer("playtime_minutes"),  
  isIgnored: integer("is_ignored", { mode: "boolean" }).default(false),  
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
  tags: text("tags"),  
  createdAt: integer("created_at", { mode: "timestamp" })
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  lastAttemptAt: integer("last_attempt_at"),
  lastSuccessAt: integer("last_success_at"),
  lastError: text("last_error"),
  isRunning: integer("is_running", { mode: "boolean" }).notNull().default(false),
  lockExpiresAt: integer("lock_expires_at"),
  ignoredCount: integer("ignored_count").notNull().default(0),
  wishlistCount: integer("wishlist_count").notNull().default(0),
  ownedCount: integer("owned_count").notNull().default(0),
  gamesUpdated: integer("games_updated").notNull().default(0),
  gamesRemoved: integer("games_removed").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
});

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
