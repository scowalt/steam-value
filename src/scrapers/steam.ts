/**
 * Steam API exports
 *
 * Re-exports from the centralized steam-client for backward compatibility.
 * New code should import directly from "../lib/steam-client".
 */

export {
  steam,
  fetchSteamData,
  isGame,
  getGameModes,
  getControllerSupport,
  SteamClient,
  type SteamData,
  type SteamClientConfig,
  type SteamClientStats,
  type GameModes,
} from "../lib/steam-client";
