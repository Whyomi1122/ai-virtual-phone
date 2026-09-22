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

const API_ERR_HINT = "（我这边 API 还没连接好，暂时听不到画面和台词…先检查一下设置里的模型绑定哦）";
const CHAT_STORE_KEY = "cove-cinema-chat-v1";
const AUTO_SHOT_INTERVAL = 60; // 自动截屏间隔（秒）

const HEVC_ERR = "这段视频大概率是 H.265 (HEVC) 编码，浏览器播不了（华为录屏默认就是这个格式）。解决办法：① 换 H.264 编码的 mp4（微信传过/B站抖音下载的一般都是）；② 用剪映/格式工厂转码成 H.264 再来。";

export default function CinemaApp({ onClose }: { onClose: () => void }) {
  const [videoSrc, setVideoSrc] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [videoError, setVideoError] = useState(""); // ★ 新增：编码/加载友好报错

  const [immersive, setImmersive] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSub, setCurrentSub] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState(true);
  const [danmakuInput, setDanmakuInput] = useState("");
  const [autoShot, setAutoShot] = useState(false); // ★ 新增：自动截屏开关

  // ★ 修复：聊天记录持久化——高频使用不再一关就没
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
  const videoUrlRef = useRef<string>(""); // ★ 新增：objectURL 生命周期管理

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

  // ★ 修复：聊天记录落盘（裁剪到最近 40 条，老消息的截图丢弃防超 localStorage）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const slim = chatList.slice(-40).map((m, i, arr) =>
          i < arr.length - 10 && m.frame ? { ...m, frame: undefined } : m
        );
        localStorage.setItem(CHAT_STORE_KEY, JSON.stringify(slim));
      } catch { /* 存储满了就放弃，不影响使用 */ }
    }, 500);
    return () => clearTimeout(t);
  }, [chatList]);

  // ★ 修复：卸载时释放 objectURL
  useEffect(() => () => {
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch {} }
  }, []);

  // ★ 修复（黑屏主因）：加载超时兜底——HEVC 之类 loadedmetadata 永不触发时给出人话报错
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

  // ★ 修复（截断主因）：只删短动作标记（[笑]（捂脸）这类 ≤8 字），不再吞正文
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
    // ★ 修复：选片即预检 HEVC，别等黑屏
    if (detectHevc(file)) { setVideoError(HEVC_ERR); return; }
    if (videoUrlRef.current) { try { URL.revokeObjectURL(videoUrlRef.current); } catch {} }
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setVideoSrc(url);
    setVideoError("");
    const title = file.name.replace(/\.[a-z0-9]+$/i, "");
    setVideoTitle(title);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setLastError("");
    setChatList((prev) => [...prev, {
      id: "sys-" + Date.now(), role: "assistant", timeStr: "00:00",
      content: prev.length === 0
        ? `我们开始看《${title}》啦！看到想吐槽的地方随时和我说~`
        : `换片咯！这次看《${title}》，走起~`,
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

  const callAI = async (prompt: string, historyOverride?: ChatMsg[]): Promise<string> => {
    try { await hydrateChatStorage(); } catch { /* 已水合过会抛错，忽略 */ }
    const sessions = loadChatSessions();
    const session = sessions && sessions.length > 0 ? sessions[0] : null;
    if (!session) throw new Error("找不到和佑的聊天会话——请先回到微信里和佑说过话，再来观影室");
    // ★ 修复：带上本轮观影对话最近 8 条，佑终于记得你们刚才聊了什么
    const history = (historyOverride ?? chatList).slice(-8).map((m) => ({
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
      id: (Date.now() + offset).toString(), sender, text,
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

  // ★ 新增（融合土豆放映室）：自动截屏——佑定期主动抬头看屏幕、忍不住开口
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

  // 用 ref 装最新的 trigger，避免定时器闭包过期
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
      // ★ 修复：不再 slice(0,30) 只看开头——改为把"已经看过的部分"均匀采样 40 句
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

  return (
    <div className="relative flex flex-col h-full w-full bg-[#0d0d11] text-neutral-100 select-none overflow-hidden">
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSelectVideo} />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSelectSrt} />

      {/* 顶栏 */}
      {!immersive && (
        <header className="relative z-50 flex items-center justify-between px-4 pt-12 pb-3 bg-[#131318]/90 backdrop-blur-xl border-b border-white/5 shrink-0">
          <button onClick={onClose} className="flex items-center gap-1 text-[15px] text-rose-400 active:scale-95 transition">
            <ChevronLeft className="w-5 h-5 -ml-1" />返回
          </button>
          <div className="flex flex-col items-center">
            <span className="text-[15px] font-semibold text-white/95 max-w-[150px] truncate">{videoTitle || "共影空间"}</span>
            <span className="text-[10px] text-white/40 tracking-wider">COVE COMPANION</span>
          </div>
          <div className="flex items-center gap-1.5">
            {videoSrc && (
              <button onClick={() => setImmersive(true)} title="沉浸模式"
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
            <button onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-600 text-white font-medium text-sm shadow-lg shadow-rose-500/25 active:scale-[0.98] transition">
              选择本地视频开始
            </button>
          </div>
        ) : (
          <>
            <div className="relative flex-1 min-h-0 bg-black"
              onClick={() => setShowControls(!showControls)}>
              <video
                ref={videoRef}
                src={videoSrc}
                className="absolute inset-0 w-full h-full object-contain"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => { setDuration(videoRef.current?.duration || 0); setVideoError(""); }}
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

              {/* ★ 新增：编码/加载友好报错层 */}
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

              {/* 弹幕 */}
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

              {/* 字幕 */}
              {showSubtitles && currentSub && (
                <div className="absolute bottom-12 left-4 right-4 text-center pointer-events-none z-10">
                  <span className="inline-block px-3.5 py-1.5 rounded-xl bg-black/75 backdrop-blur-md text-white text-[13px] font-medium border border-white/10">
                    {currentSub}
                  </span>
                </div>
              )}

              {immersive && (
                <button onClick={(e) => { e.stopPropagation(); onClose(); }}
                  className="absolute top-3 left-3 z-30 p-2 rounded-full bg-black/50 backdrop-blur text-rose-300 active:scale-95 transition">
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}

              {/* 悬浮控制层 */}
              <div
                className={`absolute inset-0 z-20 transition-opacity duration-300 ${showControls ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="absolute top-0 inset-x-0 h-20 bg-gradient-to-b from-black/70 to-transparent" />
                <div className="absolute bottom-0 inset-x-0 h-24 bg-gradient-to-t from-black/80 to-transparent" />

                <div className="absolute bottom-3 inset-x-4 flex flex-col gap-2.5">
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
                          className="p-1.5 rounded-full bg-white/10 text-white/70 active:scale-95" title="退出沉浸模式">
                          <Minimize2 className="w-4 h-4" />
                        </button>
                      )}
                      {/* ★ 新增：自动截屏开关（融合土豆放映室） */}
                      <button onClick={() => setAutoShot(!autoShot)}
                        className={`text-[10px] px-2 py-1 rounded-full border flex items-center gap-1 ${autoShot ? "border-rose-400/40 text-rose-300 bg-rose-500/10" : "border-white/10 text-white/60 bg-white/5"}`}
                        title={`每 ${AUTO_SHOT_INTERVAL} 秒佑会主动看一眼屏幕搭话`}>
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
            </div>

            {/* 沉浸模式抽屉 */}
            {immersive && (
              <div
                className="shrink-0 bg-[#131318] border-t border-white/10 flex flex-col overflow-hidden transition-all duration-300"
                style={{ height: drawerOpen ? "42vh" : "28px" }}
              >
                <button
                  onClick={() => setDrawerOpen(!drawerOpen)}
                  className="w-full h-7 shrink-0 flex items-center justify-center gap-1.5 text-[10px] text-white/50 active:brightness-125 bg-[#18181e]">
                  <ChevronsUp className={`w-3.5 h-3.5 transition-transform ${drawerOpen ? "rotate-180" : "animate-pulse"}`} />
                  <span>{drawerOpen ? "收起伴聊" : `展开伴聊 · ${formatTime(currentTime)}`}</span>
                </button>
                {drawerOpen && (
                  <>
                    <ChatStream chatList={chatList} chatScrollRef={chatScrollRef}
                      isGeneratingReply={isGeneratingReply} lastError={lastError} />
                    <div className="shrink-0 p-3 pb-6 border-t border-white/5">
                      <InputBar value={danmakuInput} setValue={setDanmakuInput} onSend={() => handleSendMessage()}
                        heldFrame={heldFrame} onSnap={() => setHeldFrame(grabCurrentFrame())}
                        onClearSnap={() => setHeldFrame("")} disabled={isGeneratingReply} />
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 竖屏（非沉浸） */}
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

                <ChatStream chatList={chatList} chatScrollRef={chatScrollRef}
                  isGeneratingReply={isGeneratingReply} lastError={lastError} />

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

/* ══════ 子组件 ══════ */
function ChatStream({ chatList, chatScrollRef, isGeneratingReply, lastError }:
  { chatList: ChatMsg[]; chatScrollRef: React.RefObject<HTMLDivElement | null>; isGeneratingReply: boolean; lastError: string; }) {
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
            msg.role === "user" ? "bg-rose-500 text-white rounded-tr-sm"
              : "bg-[#1f1f27] text-white/90 border border-white/5 rounded-tl-sm shadow-md"}`}>
            {msg.content}
          </div>
        </div>
      ))}
      {isGeneratingReply && (
        <div className="flex items-center gap-1.5 text-xs text-rose-400/80 px-2 py-1">
          <Sparkles className="w-3.5 h-3.5 animate-spin" /><span>佑正在思考这一幕...</span>
        </div>
      )}
      {lastError && (
        <div className="text-[10px] text-amber-400/80 px-2 break-all">调试信息：{lastError.slice(0, 120)}</div>
      )}
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
        <input
          type="text" value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onSend(); }}
          placeholder={disabled ? "佑正在想..." : "和佑随口聊聊这一幕..."}
          className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-rose-400/50"
        />
        <button onClick={onSend} disabled={(!value.trim() && !heldFrame) || disabled}
          className="p-2.5 bg-rose-500 hover:bg-rose-600 disabled:opacity-30 rounded-xl text-white active:scale-95 transition shrink-0">
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
