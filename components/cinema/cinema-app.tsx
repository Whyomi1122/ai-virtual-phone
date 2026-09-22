"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ChevronLeft, Play, Pause, Send, Film, Camera, Subtitles,
  FastForward, Rewind, X, Sparkles, Maximize2, Timer,
} from "lucide-react";
import { loadChatSessions, hydrateChatStorage } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";

interface DanmakuItem {
  id: string; sender: "user" | "char"; text: string; time: number; lane: number;
}
interface SubtitleCue { start: number; end: number; text: string; }
interface ChatMsg {
  id: string; role: "user" | "assistant"; content: string;
  frame?: string; timeStr: string;
}
interface SessionMeta {
  title: string; currentTime: number; duration: number;
  subtitles: SubtitleCue[]; landscape: boolean; autoShot: boolean; savedAt: number;
}

const API_ERR_HINT = "（我这边 API 还没连接好，暂时听不到画面和台词…先检查一下设置里的模型绑定哦）";
const CHAT_STORE_KEY = "cove-cinema-chat-v1";
const AUTO_SHOT_INTERVAL = 60;
const MAX_FILE_BYTES = 300 * 1024 * 1024; // 超过 300MB 的视频不做持久化（重进需重选，但会自动跳回进度）

const HEVC_ERR = "这段视频大概率是 H.265 (HEVC) 编码，浏览器播不了（华为录屏默认就是这个格式）。解决办法：① 换 H.264 编码的 mp4（微信传过/B站抖音下载的一般都是）；② 用剪映/格式工厂转码成 H.264 再来。";

/* ── IndexedDB 迷你封装：存视频文件 Blob + 会话元数据 ── */
function openCinemaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("cove-cinema", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("kv"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key: string, val: unknown) {
  try {
    const db = await openCinemaDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch { /* 存储失败不阻塞使用 */ }
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openCinemaDb();
    const val = await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const rq = tx.objectStore("kv").get(key);
      rq.onsuccess = () => resolve(rq.result as T | undefined);
      rq.onerror = () => reject(rq.error);
    });
    db.close();
    return val;
  } catch { return undefined; }
}
async function idbDel(key: string) {
  try {
    const db = await openCinemaDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch { /* ignore */ }
}

export default function CinemaApp({ onClose }: { onClose: () => void }) {
  const [videoSrc, setVideoSrc] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [videoError, setVideoError] = useState("");
  const [landscape, setLandscape] = useState(false); // ★ 横屏（旋转 90°）替代旧沉浸模式
  const [resumeHint, setResumeHint] = useState("");  // 视频太大没持久化时的提示

  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState(true);
  const [danmakuInput, setDanmakuInput] = useState("");
  const [autoShot, setAutoShot] = useState(false);

  const [chatList, setChatList] = useState<ChatMsg[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(CHAT_STORE_KEY);
      return raw
