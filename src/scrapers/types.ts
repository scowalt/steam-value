export interface SteamData {
  appId: number;
  name: string;
  reviewScore: number;  
  reviewCount: number;
}

export interface HltbData {
  hltbId: number;
  name: string;
  main: number | null;  
  mainExtra: number | null;  
  completionist: number | null;  
  profileSteam: number | null;  
}

export interface GameData {
  steam: SteamData;
  hltb: HltbData | null;
}
