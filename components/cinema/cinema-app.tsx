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
const MAX_FILE_BYTES = 300 * 1024 * 1024;

const HEVC_ERR = "这段视频大概率是 H.265 (HEVC) 编码，浏览器播不了（华为录屏默认就是这个格式）。解决办法：① 换 H.264 编码的 mp4（微信传过/B站抖音下载的一般都是）；② 用剪映/格式工厂转码成 H.264 再来。";

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
  } catch { /* ignore */ }
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
  const [landscape, setLandscape] = useState(false);
  const [resumeHint, setResumeHint] = useState("");

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
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch { return []; }
  });

  const [heldFrame, setHeldFrame] = useState("");
  const [isGeneratingReply, setIsGeneratingReply] = useState(false);
  const [lastError, setLastError] = useState("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef<string>("");
  const pendingSeekRef = useRef(0);
  const wasPlayingRef = useRef(false);
  const lastSaveRef = useRef(0);
  const lastMetaRef = useRef<SessionMeta | null>(null);
  const persistRef = useRef<() => void>(() => {});
  const rootRef = useRef<HTMLDivElement>(null);
  const [rot, setRot] = useState({ w: 0, h: 0 });

  const titleRef = useRef(""); titleRef.current = videoTitle;
  const subtitlesRef = useRef<SubtitleCue[]>([]); subtitlesRef.current = subtitles;
  const landscapeRef = useRef(false); landscapeRef.current = landscape;
  const autoShotRef = useRef(false); autoShotRef.current = autoShot;

  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m.toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!showControls || !isPlaying) return;
    const t = setTimeout(() => setShowControls(false), 3500);
    return () => clearTimeout(t);
  }, [showControls, isPlaying, currentTime]);

  useEffect(() => {
    if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatList, isGeneratingReply]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const slim = chatList.slice(-40).map((m, i, arr) =>
          i < arr.length - 10 && m.frame ? { ...m, frame: undefined } : m
        );
        localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(slim));
      } catch { /* ignore */ }
    }, 500);
    return () => clearTimeout(t);
  }, [chatList]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setRot({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const persistSession = () => {
    if (!videoUrlRef.current) return;
    const v = videoRef.current;
    const meta: SessionMeta = {
      title: titleRef.current,
      currentTime: v?.currentTime ?? 0,
      duration: v?.duration || 0,
      subtitles: subtitlesRef.current,
      landscape: landscapeRef.current,
      autoShot: autoShotRef.current,
      savedAt: Date.now(),
    };
    void idbSet("session", meta);
  };
  useEffect(() => { persistRef.current = persistSession; });

  useEffect(() => () => {
    try { videoRef.current?.pause(); } catch {}
    persistRef.current();
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch {} }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await idbGet<SessionMeta>("session");
      if (!meta || cancelled) return;
      lastMetaRef.current = meta;
      const blob = await idbGet<Blob>("videoFile");
      if (cancelled) return;
      if (!blob) {
        if (meta.title) {
          setResumeHint(`上次看到《${meta.title}》${formatTime(meta.currentTime)}。视频文件没能保存下来，重新选同一部片会自动跳回进度。`);
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      if (cancelled) { URL.revokeObjectURL(url); return; }
      videoUrlRef.current = url;
      pendingSeekRef.current = meta.currentTime || 0;
      setVideoSrc(url);
      setVideoTitle(meta.title || "");
      setDuration(meta.duration || 0);
      setSubtitles(meta.subtitles || []);
      setLandscape(!!meta.landscape);
      setAutoShot(!!meta.autoShot);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!videoSrc || videoError) return;
    const t = setTimeout(() => {
      if (videoRef.current && !videoRef.current.videoWidth) {
        setVideoError(HEVC_ERR);
        setIsPlaying(false);
      }
    }, 8000);
    return () => clearTimeout(t);
  }, [videoSrc, videoError]);

  const cleanReply = (s: string) =>
    s.replace(/[\[［(（【]\s*[^()（）\[\]［］【】]{0,8}\s*[\]］)）】]/g, "")
      .replace(/ {2,}/g, " ")
      .trim();

  const detectHevc = (file: File) => {
    const name = (file.name || "").toLowerCase();
    const mime = (file.type || "").toLowerCase();
    return name.endsWith(".hevc") || name.endsWith(".h265") || /hevc|h265/.test(mime);
  };

  const handleSelectVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (detectHevc(file)) { setVideoError(HEVC_ERR); return; }
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch {} }
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setVideoSrc(url);
    setVideoError("");
    setResumeHint("");
    const title = file.name.replace(/\.[a-z0-9]+$/i, "");
    setVideoTitle(title);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setLastError("");
    const meta = lastMetaRef.current;
    if (meta && meta.title === title && meta.currentTime > 0) {
      pendingSeekRef.current = meta.currentTime;
    } else {
      pendingSeekRef.current = 0;
    }
    if (file.size <= MAX_FILE_BYTES) void idbSet("videoFile", file);
    else void idbDel("videoFile");
    setChatList((prev) => [...prev, {
      id: "sys-" + Date.now(), role: "assistant", timeStr: "00:00",
      content: (meta && meta.title === title)
        ? `继续看《${title}》～我从上次的进度接着陪你看。`
        : `我们开始看《${title}》啦！看到想吐槽的地方随时和我说~`,
    }]);
  };

  const handleSelectSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => parseSubtitles(ev.target?.result as string);
    reader.readAsText(file);
  };

  const parseSubtitles = (srtText: string) => {
    const cues: SubtitleCue[] = [];
    const normalized = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const block of normalized.split(/\n\n+/)) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;
      const timeLine = lines[0].includes("-->") ? lines[0] : lines[1];
      const textLines = lines[0].includes("-->") ? lines.slice(1) : lines.slice(2);
      if (timeLine?.includes("-->")) {
        const [s, e] = timeLine.split("-->").map((x) => x.trim());
        const pt = (t: string) => {
          const p = t.replace(",", ".").split(":");
          return p.length === 3 ? +p[0] * 3600 + +p[1] * 60 + +p[2] : 0;
        };
        const text = textLines.join(" ").replace(/<[^>]+>/g, "").trim();
        if (text) cues.push({ start: pt(s), end: pt(e), text });
      }
    }
    setSubtitles(cues);
    setTimeout(() => persistSession(), 100);
  };

  const grabCurrentFrame = (): string => {
    if (!videoRef.current?.videoWidth) return "";
    try {
      const v = videoRef.current;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 480 / v.videoWidth);
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.65);
    } catch { return ""; }
  };

  const buildEvidencePrompt = (sec: number, hasFrame: boolean) => {
    const recent = subtitles.filter((c) => c.start <= sec && sec - c.start < 60).slice(-6);
    let p = `———— 以下是系统随消息附上的共影证据，不是对方说的话；对方真正说的话在最上方 ————\n`;
    p += `【共影室】《${videoTitle || "视频"}》· 进度 ${formatTime(sec)} / ${formatTime(duration)}\n`;
    p += recent.length
      ? `[播放点之前最近台词]\n` + recent.map((c) => `[${formatTime(c.start)}] ${c.text}`).join("\n") + "\n"
      : `[台词证据]（当前片段暂无字幕）\n`;
    if (hasFrame) p += `[画面证据] 随附了 ${formatTime(sec)} 的截图；画面有文字先读文字。\n`;
    p += `[严格边界] 后面的剧情你不知道，严禁剧透与编造。像坐在身边一样随口接话，一两句（30字内），自然有陪伴感。`;
    return p;
  };

  const callAI = async (prompt: string): Promise<string> => {
    try { await hydrateChatStorage(); } catch { /* ignore */ }
    const sessions = loadChatSessions();
    const session = sessions && sessions.length > 0 ? sessions[0] : null;
    if (!session) throw new Error("找不到和佑的聊天会话——请先回到微信里和佑说过话，再来观影室");
    const history = chatList.slice(-8).map((m) => ({
      id: "h" + m.id, role: m.role, content: m.content.slice(0, 300), createdAt: Date.now(),
    }));
    const result = await generateChatCompletion(
      session,
      [...history, { id: "n" + Date.now().toString(), role: "user", content: prompt, createdAt: Date.now() } as never],
      { appTags: ["cinema"] }
    );
    return cleanReply(flattenCompletionResult(result));
  };

  const pushAssistant = (content: string) => {
    setChatList((prev) => [...prev, {
      id: (Date.now() + 2).toString(), role: "assistant", content, timeStr: formatTime(currentTime),
    }]);
  };

  const addDanmaku = (text: string, sender: "user" | "char", offset = 0) => {
    if (!text) return;
    setDanmakus((prev) => [...prev, {
      id: (Date.now() + offset + Math.random()).toString(), sender, text,
      time: currentTime + offset, lane: Math.floor(Math.random() * 4),
    }]);
  };

  const handleSendMessage = async (customText?: string) => {
    const text = (customText || danmakuInput).trim();
    if (!text && !heldFrame) return;
    setDanmakuInput("");
    setLastError("");

    const frameToSend = heldFrame || grabCurrentFrame();
    setHeldFrame("");

    setChatList((prev) => [...prev, {
      id: Date.now().toString(), role: "user", content: text, frame: frameToSend || undefined, timeStr: formatTime(currentTime),
    }]);
    if (text) addDanmaku(text, "user");

    setIsGeneratingReply(true);
    try {
      const reply = await callAI(`${text || "（用户没打字，只发了这张此刻的画面）"}\n\n${buildEvidencePrompt(currentTime, Boolean(frameToSend))}`);
      if (reply) {
        setTimeout(() => {
          pushAssistant(reply);
          addDanmaku(reply, "char", 1);
        }, 600);
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      pushAssistant(API_ERR_HINT);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const triggerAutoSpeak = async (frame: string) => {
    if (isGeneratingReply) return;
    setIsGeneratingReply(true);
    try {
      const prompt = `（自动截屏：你刚刚抬头瞥了一眼屏幕，看到了下面附着的画面，忍不住主动开口）\n\n${buildEvidencePrompt(currentTime, true)}\n像真人一起看片时憋不住冒出来的那句吐槽/感叹/惊呼，1~2 句、30 字内，主动开口。绝对不要出现"截图""你发的"这类词——这画面是你自己看到的。`;
      const reply = await callAI(prompt);
      if (reply) {
        pushAssistant(reply);
        addDanmaku(reply, "char", 1);
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const autoSpeakRef = useRef<(frame: string) => void>(() => {});
  useEffect(() => { autoSpeakRef.current = (frame) => { void triggerAutoSpeak(frame); }; });

  useEffect(() => {
    if (!autoShot || !isPlaying || videoError) return;
    const t = setInterval(() => {
      if (isGeneratingReply) return;
      const frame = grabCurrentFrame();
      if (frame) autoSpeakRef.current(frame);
    }, AUTO_SHOT_INTERVAL * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoShot, isPlaying, videoError]);

  const handleWholeFilmChat = async () => {
    if (!videoTitle || isGeneratingReply) return;
    setIsGeneratingReply(true);
    setLastError("");
    try {
      const watched = subtitles.filter((c) => c.start <= currentTime);
      const sampled: string[] = [];
      if (watched.length) {
        const step = Math.max(1, Math.ceil(watched.length / 40));
        for (let i = 0; i < watched
