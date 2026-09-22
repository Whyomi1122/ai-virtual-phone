import type { CustomAppIconId } from "@/lib/custom-app-types";

export type IconId =
  | "chat"
  | "cinema"
  | "reading"
  | "music"
  | "diary"
  | "moments"
  | "settings"
  | "theme"
  | "characters"
  | "resources"
  | "resource_hub"
  | "calendar"
  | "cocreate"
  | "story"
  | "game"
  | "appmarket"
  | "xiaohongshu"
  | "dwelling"
  | "checkphone"
  | "shopping"
  | "interview_magazine"
  | "vnmode"
  | "mapmode"
  | "vnplay"
  | "vnchapters"
  | "group_chat"
  | "realitybridge"
  | "worldbuilder"
  | "qa"
  | "mixology";

// 桌面文件夹定义
export type FolderIconId = `folder:${string}`;

export function isFolderIconId(id: string): id is FolderIconId {
  return id.startsWith("folder:");
}

export function createFolderIconId(): FolderIconId {
  return `folder:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export type DesktopIconId = IconId | CustomAppIconId | FolderIconId;

export type IconPosition = { id: DesktopIconId; row: number; col: number };

export type IconMeta = {
  id: IconId;
  label: string;
  tone: string;
  placeholder: boolean;
  path?: string;
};

// 【主屏第 1 页】：极致精简的核心陪伴 App（2×3 或 2×4 排列）
export const PAGE_1_DEFAULT: IconId[] = [
  "chat",
  "cinema",
  "reading",
  "music",
  "diary",
  "moments"
];

// 第 2 页：社区与系统工具（资源集市 + 工坊）
export const PAGE_2_DEFAULT: IconId[] = [
  "resource_hub",
  "qa"
];
export const PAGE_3_DEFAULT: IconId[] = [];

// 【底部 Dock 栏】：核心系统与人设设置
export const DOCK_DEFAULT: IconId[] = [
  "characters",
  "theme",
  "settings"
];

export const ICONS: Record<IconId, IconMeta> = {
  chat: { id: "chat", label: "信息", tone: "var(--c-icon-green, #34c759)", placeholder: false },
  cinema: { id: "cinema", label: "观影室", tone: "var(--c-icon-rose, #ff2d55)", placeholder: false },
  reading: { id: "reading", label: "共读间", tone: "var(--c-icon-amber, #ff9500)", placeholder: false },
  music: { id: "music", label: "音乐", tone: "var(--c-icon-coral, #ff3b30)", placeholder: false },
  diary: { id: "diary", label: "备忘录", tone: "var(--c-icon-violet, #af52de)", placeholder: false },
  moments: { id: "moments", label: "朋友圈", tone: "var(--c-icon-lilac, #5856d6)", placeholder: false },
  settings: { id: "settings", label: "设置", tone: "var(--c-icon-slate, #8e8e93)", placeholder: false },
  theme: { id: "theme", label: "美化", tone: "var(--c-icon-violet, #af52de)", placeholder: false },
  characters: { id: "characters", label: "佑", tone: "var(--c-icon-lilac, #5856d6)", placeholder: false, path: "/characters" },
  
  // 保留以下备用定义，防止类型系统报错
  resources: { id: "resources", label: "资源库", tone: "var(--c-icon-teal)", placeholder: false },
  resource_hub: { id: "resource_hub", label: "资源集市", tone: "var(--c-icon-amber)", placeholder: false },
  calendar: { id: "calendar", label: "日历", tone: "var(--c-icon-rose)", placeholder: true },
  cocreate: { id: "cocreate", label: "共创", tone: "var(--c-icon-cocreate)", placeholder: false },
  story: { id: "story", label: "剧情", tone: "var(--c-icon-story)", placeholder: false },
  game: { id: "game", label: "游戏", tone: "var(--c-icon-blue)", placeholder: false },
  appmarket: { id: "appmarket", label: "应用市场", tone: "var(--c-icon-teal)", placeholder: false },
  xiaohongshu: { id: "xiaohongshu", label: "小红书", tone: "var(--c-icon-rose)", placeholder: false },
  checkphone: { id: "checkphone", label: "查手机", tone: "var(--c-icon-slate)", placeholder: false },
  dwelling: { id: "dwelling", label: "栖所", tone: "var(--c-icon-rose)", placeholder: false },
  shopping: { id: "shopping", label: "购物", tone: "var(--c-icon-amber)", placeholder: false },
  interview_magazine: { id: "interview_magazine", label: "在场", tone: "var(--c-icon-lilac)", placeholder: false },
  vnmode: { id: "vnmode", label: "漫卷", tone: "var(--c-icon-rose)", placeholder: false },
  mapmode: { id: "mapmode", label: "冒险", tone: "var(--c-icon-amber)", placeholder: false },
  vnplay: { id: "vnplay", label: "漫卷播放", tone: "var(--c-icon-rose)", placeholder: true },
  vnchapters: { id: "vnchapters", label: "章节", tone: "var(--c-icon-rose)", placeholder: true },
  group_chat: { id: "group_chat", label: "群聊", tone: "var(--c-icon-teal)", placeholder: false },
  realitybridge: { id: "realitybridge", label: "iOS现实桥", tone: "var(--c-icon-teal)", placeholder: false },
  worldbuilder: { id: "worldbuilder", label: "筑境", tone: "var(--c-icon-amber)", placeholder: false, path: "/world-builder" },
  qa: { id: "qa", label: "工坊", tone: "var(--c-icon-qa)", placeholder: false },
  mixology: { id: "mixology", label: "独家特调", tone: "var(--c-icon-violet)", placeholder: false },
};
