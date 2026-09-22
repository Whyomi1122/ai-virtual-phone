"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  ChevronLeft, Play, Pause, Send, Film, Camera, Subtitles,
  FastForward, Rewind, X, Sparkles, ChevronsUp, Maximize2, Minimize2, Timer,
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
  subtitles: SubtitleCue[]; immersive: boolean; autoShot: boolean; savedAt: number;
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
  const [immersive, setImmersive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [resumeHint, setResumeHint] = useState("");
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState(true);
  const [danmakuInput, setDanmakuInput] = useState("");
  const [autoShot, setAutoShot] = useState(false);
  const [heldFrame, setHeldFrame] = useState("");
  const [isGeneratingReply, setIsGeneratingReply] = useState(false);
  const [lastError, setLastError] = useState("");

  const [chatList, setChatList] = useState<ChatMsg[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(CHAT_STORE_KEY);
      return raw ? (JSON.parse(raw) as ChatMsg[]) : [];
    } catch { return []; }
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const videoUrlRef = useRef("");
  const pendingSeekRef = useRef(0);
  const lastSaveRef = useRef(0);
  const lastMetaRef = useRef<SessionMeta | null>(null);
  const persistRef = useRef<() => void>(() => {});
  const titleRef = useRef(""); titleRef.current = videoTitle;
  const subtitlesRef = useRef<SubtitleCue[]>([]); subtitlesRef.current = subtitles;
  const immersiveRef = useRef(false); immersiveRef.current = immersive;
  const autoShotStoreRef = useRef(false); autoShotStoreRef.current = autoShot;

  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    return `${m.toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (!showControls || !isPlaying) return;
    const t = setTimeout(() => setShowControls(false), 2800);
    return () => clearTimeout(t);
  }, [showControls, isPlaying]);

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

  const persistSession = () => {
    if (!videoUrlRef.current) return;
    const v = videoRef.current;
    void idbSet("session", {
      title: titleRef.current,
      currentTime: v?.currentTime ?? 0,
      duration: v?.duration || 0,
      subtitles: subtitlesRef.current,
      immersive: immersiveRef.current,
      autoShot: autoShotStoreRef.current,
      savedAt: Date.now(),
    } satisfies SessionMeta);
  };
  useEffect(() => { persistRef.current = persistSession; });

  useEffect(() => () => {
    try { videoRef.current?.pause(); } catch { /* ignore */ }
    persistRef.current();
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch { /* ignore */ } }
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
      setImmersive(!!meta.immersive);
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
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch { /* ignore */ } }
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
    pendingSeekRef.current = (meta && meta.title === title && meta.currentTime > 0) ? meta.currentTime : 0;
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
    setTimeout(() => persistSession(), 80);
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
      id: Date.now().toString() + offset + Math.random(), sender, text,
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
        setTimeout(() => { pushAssistant(reply); addDanmaku(reply, "char", 1); }, 600);
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      pushAssistant(API_ERR_HINT);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const triggerAutoSpeak = async () => {
    if (isGeneratingReply) return;
    setIsGeneratingReply(true);
    try {
      const prompt = `（自动截屏：你刚刚抬头瞥了一眼屏幕，看到了下面附着的画面，忍不住主动开口）\n\n${buildEvidencePrompt(currentTime, true)}\n像真人一起看片时憋不住冒出来的那句吐槽/感叹/惊呼，1~2 句、30 字内，主动开口。绝对不要出现"截图""你发的"这类词——这画面是你自己看到的。`;
      const reply = await callAI(prompt);
      if (reply) { pushAssistant(reply); addDanmaku(reply, "char", 1); }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const autoSpeakRef = useRef<() => void>(() => {});
  useEffect(() => { autoSpeakRef.current = () => { void triggerAutoSpeak(); }; });

  useEffect(() => {
    if (!autoShot || !isPlaying || videoError) return;
    const t = setInterval(() => {
      if (isGeneratingReply) return;
      if (grabCurrentFrame()) autoSpeakRef.current();
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
        for (let i = 0; i < watched.length && sampled.length < 40; i += step) {
          sampled.push(`[${formatTime(watched[i].start)}] ${watched[i].text}`);
        }
      }
      const prompt = `【共影总结】我们刚一起看《${videoTitle}》（看到 ${formatTime(currentTime)}）。
${sampled.length ? `看过的部分台词节选：\n${sampled.join("\n")}` : "（没有字幕）"}
请以伴侣口吻写 50 字左右温馨观后感，别剧透未看到的部分。`;
      const reply = await callAI(prompt);
      pushAssistant(`🎬 观影纪念：\n${reply}`);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
      pushAssistant(API_ERR_HINT);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const sec = videoRef.current.currentTime;
    setCurrentTime(sec);
    if (subtitles.length) {
      const m = subtitles.find((c) => sec >= c.start && sec <= c.end);
      setCurrentSub(m?.text ?? "");
    }
    if (Date.now() - lastSaveRef.current > 5000) {
      lastSaveRef.current = Date.now();
      persistSession();
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    isPlaying ? videoRef.current.pause() : videoRef.current.play();
    setShowControls(true);
  };

  const seek = (s: number) => {
    if (videoRef.current && duration > 0) {
      videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + s));
    }
  };

  const handleClose = () => {
    persistSession();
    try { videoRef.current?.pause(); } catch { /* ignore */ }
    onClose();
  };

  return (
    <div className="relative flex flex-col h-full w-full bg-[#0d0d11] text-neutral-100 select-none overflow-hidden">
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSelectVideo} />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSelectSrt} />

      {!immersive && (
        <header className="relative z-50 flex items-center justify-between px-4 pt-12 pb-3 bg-[#131318]/90 backdrop-blur-xl border-b border-white/5 shrink-0">
          <button onClick={handleClose} className="flex items-center gap-1 text-[15px] text-rose-400 active:scale-95 transition">
            <ChevronLeft className="w-5 h-5 -ml-1" />返回
          </button>
          <div className="flex flex-col items-center">
            <span className="text-[15px] font-semibold text-white/95 max-w-[150px] truncate">{videoTitle || "共影空间"}</span>
            <span className="text-[10px] text-white/40 tracking-wider">COVE COMPANION</span>
          </div>
          <div className="flex items-center gap-1.5">
            {videoSrc && (
              <button onClick={() => { setImmersive(true); setDrawerOpen(false); }} title="沉浸模式"
                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/70 active:scale-95 transition">
                <Maximize2 className="w-4 h-4" />
              </button>
            )}
            <button onClick={() => fileInputRef.current?.click()}
              className="text-xs px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 active:scale-95 transition">
              {videoSrc ? "换片" : "选片"}
            </button>
          </div>
        </header>
      )}

      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {!videoSrc ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-8 text-center max-w-sm mx-auto">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-rose-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center shadow-2xl">
              <Film className="w-9 h-9 text-rose-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white/90">双人共影与伴聊</h3>
              <p className="text-xs text-white/50 mt-1.5 leading-relaxed">导入视频与字幕，佑会按真实播放进度陪你看剧吐槽。点右上角 ⛶ 进入沉浸模式。</p>
            </div>
            {resumeHint && (
              <p className="text-[11px] leading-relaxed text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2">{resumeHint}</p>
            )}
            <button onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-600 text-white font-medium text-sm shadow-lg shadow-rose-500/25 active:scale-[0.98] transition">
              选择本地视频开始
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-h-0 bg-black" onClick={() => setShowControls(!showControls)}>
              <video
                ref={videoRef}
                src={videoSrc}
                className="absolute inset-0 w-full h-full object-contain"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  setDuration(v.duration || 0);
                  setVideoError("");
                  if (pendingSeekRef.current > 0) {
                    try { v.currentTime = pendingSeekRef.current; } catch { /* ignore */ }
                    setCurrentTime(pendingSeekRef.current);
                    pendingSeekRef.current = 0;
                  }
                }}
                onPlay={() => { setIsPlaying(true); setShowControls(true); }}
                onPause={() => setIsPlaying(false)}
                onError={() => {
                  const code = videoRef.current?.error?.code;
                  setVideoError(code === 4 ? HEVC_ERR : "这段视频加载失败了，可能是编码不兼容或文件损坏，换一段试试。");
                  setIsPlaying(false);
                }}
                preload="metadata"
                playsInline
              />

              {videoError && (
                <div className="absolute inset-0 z-40 flex items-center justify-center p-5 bg-black/90">
                  <div className="max-w-[300px] rounded-2xl border border-rose-500/30 bg-[#18181e] p-4">
                    <h4 className="text-sm font-bold text-rose-300 mb-2">这段视频没法在这里播放</h4>
                    <p className="text-[11px] leading-relaxed text-white/70">{videoError}</p>
                    <button onClick={() => { setVideoError(""); fileInputRef.current?.click(); }}
                      className="mt-3 w-full py-2 rounded-xl bg-rose-500 text-white text-xs font-semibold active:scale-95 transition">
                      好的，换一段
                    </button>
                  </div>
                </div>
              )}

              {showDanmaku && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  {danmakus.filter((d) => Math.abs(d.time - currentTime) < 5).map((dm) => (
                    <div key={dm.id}
                      className={`absolute whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium shadow-xl backdrop-blur-md max-w-[90%] truncate ${
                        dm.sender === "char" ? "bg-rose-500/85 text-white border border-rose-300/30" : "bg-white/85 text-neutral-900"
                      }`}
                      style={{ top: `${12 + dm.lane * 20}%`, right: "-20%", transform: "translateX(-120%)", animation: "danmakuFly 6s linear forwards" }}>
                      {dm.sender === "char" ? `佑: ${dm.text}` : dm.text}
                    </div>
                  ))}
                </div>
              )}

              {showSubtitles && currentSub && (
                <div className={`absolute left-4 right-4 text-center pointer-events-none z-10 ${showControls ? "bottom-24" : "bottom-6"}`}>
                  <span className="inline-block px-3.5 py-1.5 rounded-xl bg-black/75 backdrop-blur-md text-white text-[13px] font-medium border border-white/10">
                    {currentSub}
                  </span>
                </div>
              )}

              {immersive && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleClose(); }}
                  className="absolute z-[60] flex items-center gap-0.5 pl-2 pr-3 py-2 rounded-full bg-black/70 backdrop-blur text-rose-300 active:scale-95"
                  style={{ top: "max(52px, calc(env(safe-area-inset-top, 0px) + 40px))", left: 12 }}
                >
                  <ChevronLeft className="w-5 h-5" /><span className="text-xs pr-0.5">返回</span>
                </button>
              )}

              <div
                className={`absolute inset-0 z-20 transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                onClick={(e) => { e.stopPropagation(); setShowControls(false); }}
              >
                <div className="absolute top-0 inset-x-0 h-16 bg-gradient-to-b from-black/60 to-transparent pointer-events-none" />
                <div className="absolute bottom-0 inset-x-0 h-28 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />
                <div
                  className="absolute bottom-3 inset-x-4 flex flex-col gap-2.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center gap-2.5 text-[11px] text-white/60 font-mono">
                    <span>{formatTime(currentTime)}</span>
                    <input type="range" min={0} max={duration || 1} value={currentTime}
                      onChange={(e) => { if (videoRef.current && duration > 0) videoRef.current.currentTime = +e.target.value; }}
                      className="flex-1 h-1 bg-white/25 rounded-lg appearance-none accent-rose-400 cursor-pointer" />
                    <span>{formatTime(duration)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <button onClick={() => seek(-10)} className="text-white/70 hover:text-white active:scale-95"><Rewind className="w-5 h-5" /></button>
                      <button onClick={togglePlay} className="p-2.5 rounded-full bg-white/15 hover:bg-white/25 backdrop-blur text-rose-300 active:scale-90 transition">
                        {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 translate-x-0.5" />}
                      </button>
                      <button onClick={() => seek(10)} className="text-white/70 hover:text-white active:scale-95"><FastForward className="w-5 h-5" /></button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {immersive && (
                        <button onClick={() => setImmersive(false)}
                          className="p-1.5 rounded-full bg-white/10 text-white/70 active:scale-95" title="退出沉浸">
                          <Minimize2 className="w-4 h-4" />
                        </button>
                      )}
                      <button onClick={() => setAutoShot(!autoShot)}
                        className={`text-[10px] px-2 py-1 rounded-full border flex items-center gap-1 ${autoShot ? "border-rose-400/40 text-rose-300 bg-rose-500/10" : "border-white/10 text-white/60 bg-white/5"}`}>
                        <Timer className="w-3 h-3" />自动
                      </button>
                      <button onClick={() => srtInputRef.current?.click()}
                        className={`text-[10px] px-2 py-1 rounded-full border flex items-center gap-1 ${subtitles.length ? "border-rose-400/40 text-rose-300 bg-rose-500/10" : "border-white/10 text-white/60 bg-white/5"}`}>
                        <Subtitles className="w-3 h-3" />字幕
                      </button>
                      <button onClick={() => setShowDanmaku(!showDanmaku)}
                        className={`text-[10px] px-2 py-1 rounded-full border ${showDanmaku ? "border-rose-400/40 text-rose-300 bg-rose-500/10" : "border-white/10 text-white/40 bg-white/5"}`}>弹幕</button>
                    </div>
                  </div>
                </div>
              </div>
              
            {immersive && (
              <div className="shrink-0 bg-[#131318] border-t border-white/10 flex flex-col overflow-hidden transition-all duration-300"
                style={{ height: drawerOpen ? "42vh" : "28px" }}>
                <button onClick={() => setDrawerOpen(!drawerOpen)}
                  className="w-full h-7 shrink-0 flex items-center justify-center gap-1.5 text-[10px] text-white/50 active:brightness-125 bg-[#18181e]">
                  <ChevronsUp className={`w-3.5 h-3.5 transition-transform ${drawerOpen ? "rotate-180" : "animate-pulse"}`} />
                  <span>{drawerOpen ? "收起伴聊" : `展开伴聊 · ${formatTime(currentTime)}`}</span>
                </button>
                {drawerOpen && (
                  <>
                    <ChatStream chatList={chatList} chatScrollRef={chatScrollRef} isGeneratingReply={isGeneratingReply} lastError={lastError} />
                    <div className="shrink-0 p-3 pb-6 border-t border-white/5">
                      <InputBar value={danmakuInput} setValue={setDanmakuInput} onSend={() => handleSendMessage()}
                        heldFrame={heldFrame} onSnap={() => setHeldFrame(grabCurrentFrame())}
                        onClearSnap={() => setHeldFrame("")} disabled={isGeneratingReply} />
                    </div>
                  </>
                )}
              </div>
            )}

            {!immersive && (
              <>
                <div className="shrink-0 flex items-center justify-between px-3.5 py-2 bg-[#17171e]/90 border-y border-white/5 text-[11px]">
                  <div className="flex items-center gap-2 text-white/60">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-white/80 font-medium">与 佑 同步观影中</span>
                    <span className="text-white/30">|</span>
                    <span className="text-white/40 font-mono">{formatTime(currentTime)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleSendMessage("这一幕好精彩，你怎么看？")} className="text-rose-400 font-medium active:scale-95">问这一幕</button>
                    <span className="text-white/20">·</span>
                    <button onClick={handleWholeFilmChat} className="text-white/60 hover:text-white">整片聊聊</button>
                  </div>
                </div>
                <ChatStream chatList={chatList} chatScrollRef={chatScrollRef} isGeneratingReply={isGeneratingReply} lastError={lastError} />
                <div className="shrink-0 p-3 bg-[#131318]/95 border-t border-white/5 pb-8 z-40">
                  <InputBar value={danmakuInput} setValue={setDanmakuInput} onSend={() => handleSendMessage()}
                    heldFrame={heldFrame} onSnap={() => setHeldFrame(grabCurrentFrame())}
                    onClearSnap={() => setHeldFrame("")} disabled={isGeneratingReply} />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ChatStream({ chatList, chatScrollRef, isGeneratingReply, lastError }: {
  chatList: ChatMsg[]; chatScrollRef: React.RefObject<HTMLDivElement | null>; isGeneratingReply: boolean; lastError: string;
}) {
  return (
    <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3">
      {chatList.map((msg) => (
        <div key={msg.id} className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
          <div className="flex items-center gap-1.5 mb-1 px-1">
            <span className="text-[10px] text-white/30">{msg.role === "user" ? "我" : "佑"}</span>
            <span className="text-[9px] text-white/20 font-mono">@{msg.timeStr}</span>
          </div>
          {msg.frame && <img src={msg.frame} alt="" className="w-32 h-20 object-cover rounded-xl border border-white/10 mb-1.5 shadow-md" />}
          <div className={`max-w-[82%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed whitespace-pre-wrap break-words ${
            msg.role === "user" ? "bg-rose-500 text-white rounded-tr-sm" : "bg-[#1f1f27] text-white/90 border border-white/5 rounded-tl-sm shadow-md"}`}>
            {msg.content}
          </div>
        </div>
      ))}
      {isGeneratingReply && (
        <div className="flex items-center gap-1.5 text-xs text-rose-400/80 px-2 py-1">
          <Sparkles className="w-3.5 h-3.5 animate-spin" /><span>佑正在思考这一幕...</span>
        </div>
      )}
      {lastError && <div className="text-[10px] text-amber-400/80 px-2 break-all">调试信息：{lastError.slice(0, 120)}</div>}
    </div>
  );
}

function InputBar({ value, setValue, onSend, heldFrame, onSnap, onClearSnap, disabled }: {
  value: string; setValue: (v: string) => void; onSend: () => void;
  heldFrame: string; onSnap: () => void; onClearSnap: () => void; disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {heldFrame && (
        <div className="flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-xl border border-white/10 self-start">
          <img src={heldFrame} alt="" className="w-7 h-7 rounded-lg object-cover" />
          <span className="text-[11px] text-rose-300">已夹住此刻画面</span>
          <button onClick={onClearSnap} className="text-white/40 hover:text-white"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={onSnap} title="截屏发给佑"
          className={`p-2.5 rounded-xl border active:scale-95 transition shrink-0 ${heldFrame ? "bg-rose-500 text-white border-rose-400" : "bg-white/5 border-white/10 text-white/60"}`}>
          <Camera className="w-4 h-4" />
        </button>
        <input type="text" value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
          placeholder={disabled ? "佑正在想..." : "和佑随口聊聊这一幕..."}
          className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-rose-400/50" />
        <button onClick={onSend} disabled={(!value.trim() && !heldFrame) || disabled}
          className="p-2.5 bg-rose-500 hover:bg-rose-600 disabled:opacity-30 rounded-xl text-white active:scale-95 transition shrink-0">
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
