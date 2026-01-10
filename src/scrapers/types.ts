export interface SteamData {
  appId: number;
  name: string;
  reviewScore: number; // 0-100 positive percentage
  reviewCount: number;
}

export interface HltbData {
  hltbId: number;
  name: string;
  main: number | null; // hours
  mainExtra: number | null; // hours
  completionist: number | null; // hours
  profileSteam: number | null; // Steam App ID from HLTB (for verification)
}

export interface GameData {
  steam: SteamData;
  hltb: HltbData | null;
}
