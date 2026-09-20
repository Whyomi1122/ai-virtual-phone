"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { ArrowLeft, Play, Pause, Send, Film, Camera, Subtitles, RotateCcw, FastForward, Rewind, MessageSquare, Volume2, VolumeX, Sparkles, X, Settings } from "lucide-react";
import { loadChatSessions } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";

interface DanmakuItem {
  id: string;
  sender: "user" | "char";
  text: string;
  time: number;
  lane: number;
}

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

export default function CinemaApp({ onClose }: { onClose: () => void }) {
  // 核心播放状态
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoTitle, setVideoTitle] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [showControls, setShowControls] = useState<boolean>(true);

  // 字幕与弹幕
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSub, setCurrentSub] = useState<string>("");
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState<boolean>(true);
  const [danmakuInput, setDanmakuInput] = useState<string>("");

  // 画面捕获与 AI 思考
  const [heldFrame, setHeldFrame] = useState<string>("");
  const [isGeneratingReply, setIsGeneratingReply] = useState<boolean>(false);
  const [autoVision, setAutoVision] = useState<boolean>(true); // 每句话自动附上此刻一帧

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 格式化时间为 mm:ss
  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const remainder = s % 60;
    return `${m.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  };

  // 1. 本地视频选择
  const handleSelectVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
    setCurrentTime(0);
    setIsPlaying(false);
  };

  // 2. 字幕解析 (.srt / .vtt)
  const handleSelectSrt = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      parseSubtitles(text);
    };
    reader.readAsText(file);
  };

  const parseSubtitles = (srtText: string) => {
    const cues: SubtitleCue[] = [];
    const normalized = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const blocks = normalized.split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;
      
      let timeLine = lines[0].includes("-->") ? lines[0] : lines[1];
      let textLines = lines[0].includes("-->") ? lines.slice(1) : lines.slice(2);

      if (timeLine && timeLine.includes("-->")) {
        const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
        const parseTimeStr = (t: string) => {
          const parts = t.replace(",", ".").split(":");
          if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          }
          return 0;
        };
        const start = parseTimeStr(startStr);
        const end = parseTimeStr(endStr);
        const text = textLines.join(" ").replace(/<[^>]+>/g, "").trim();
        if (text) cues.push({ start, end, text });
      }
    }
    setSubtitles(cues);
  };

  // 3. 实时捕获当前帧 (Grab Frame)
  const grabCurrentFrame = (): string => {
    if (!videoRef.current || !videoRef.current.videoWidth) return "";
    try {
      const canvas = document.createElement("canvas");
      const maxW = 512;
      const scale = Math.min(1, maxW / videoRef.current.videoWidth);
      canvas.width = Math.round(videoRef.current.videoWidth * scale);
      canvas.height = Math.round(videoRef.current.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      console.warn("无法捕获视频帧（可能受跨域限制）:", e);
      return "";
    }
  };

  // 4. 手动留影 (拍照键)
  const handleSnap = () => {
    const frame = grabCurrentFrame();
    if (frame) {
      setHeldFrame(frame);
    }
  };

  // 5. 组装 IB 原版观影 Context Prompt
  const buildCinemaPrompt = (userText: string, currentSec: number, hasFrame: boolean) => {
    // 提取最近的字幕
    const recentCues = subtitles
      .filter((c) => c.start <= currentSec && currentSec - c.start < 60)
      .slice(-6);
    
    let prompt = `———— 以下是系统随消息附上的观影状态，不是对方说的话；对方真正说的话在最上面 ————\n`;
    prompt += `【观影室】《${videoTitle || "当前视频"}》· 进度 ${formatTime(currentSec)} / ${formatTime(duration)}\n`;
    
    if (recentCues.length) {
      prompt += `[播放点之前最近的字幕]\n` + recentCues.map((c) => `[${formatTime(c.start)}] ${c.text}`).join("\n") + `\n`;
    }

    if (hasFrame) {
      prompt += `[画面] 随本条消息附了此刻的一帧画面（${formatTime(currentSec)}）；画面里若有字幕先读字幕。\n`;
    }

    prompt += `[说明] 你现在正和用户并肩坐在一起看这部片。以上是这一轮你知道的全部，后面的剧情你不知道，不预告、不猜结局。请像坐在旁边一起看片的人那样随口接话吐槽，一两句即可（25字以内），保持生活感和趣味。`;
    return prompt;
  };

  // 6. 发送弹幕与触发 AI 吐槽
  const handleSendDanmaku = async () => {
    if (!danmakuInput.trim() && !heldFrame) return;
    const text = danmakuInput.trim() || "你看这里~";
    setDanmakuInput("");

    // 发送用户弹幕
    const userDanmaku: DanmakuItem = {
      id: Date.now().toString(),
      sender: "user",
      text,
      time: currentTime,
      lane: Math.floor(Math.random() * 4),
    };
    setDanmakus((prev) => [...prev, userDanmaku]);

    // 抓取帧
    let frameToSend = heldFrame;
    if (!frameToSend && autoVision) {
      frameToSend = grabCurrentFrame();
    }
    setHeldFrame(""); // 清空暂存

    // 触发 AI
    setIsGeneratingReply(true);
    try {
      const sessions = loadChatSessions();
      const currentSession = sessions[0];
      if (currentSession) {
        const cinemaContext = buildCinemaPrompt(text, currentTime, Boolean(frameToSend));
        const fullUserMessage = `${text}\n\n${cinemaContext}`;

        const completionResult = await generateChatCompletion(
          currentSession,
          [{
            id: Date.now().toString(),
            role: "user",
            content: fullUserMessage,
            createdAt: Date.now(),
            // 如果底层支持图片帧直接随请求带走
            imageUrls: frameToSend ? [frameToSend] : undefined
          }],
          { appTags: ["cinema", "danmaku"] }
        );

        const reply = flattenCompletionResult(completionResult)
          .replace(/\[.*?\]/g, "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();

        if (reply) {
          setTimeout(() => {
            setDanmakus((prev) => [
              ...prev,
              {
                id: (Date.now() + 1).toString(),
                sender: "char",
                text: reply,
                time: currentTime + 1,
                lane: (userDanmaku.lane + 1) % 4,
              },
            ]);
          }, 800);
        }
      }
    } catch (e) {
      console.error("观影室 AI 回复失败:", e);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  // 播放器时间更新
  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const sec = videoRef.current.currentTime;
    setCurrentTime(sec);

    // 更新当前字幕
    if (subtitles.length > 0) {
      const match = subtitles.find((c) => sec >= c.start && sec <= c.end);
      setCurrentSub(match ? match.text : "");
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const seek = (seconds: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
  };

  return (
    <div className="flex flex-col h-full w-full bg-black text-white select-none overflow-hidden font-sans">
      {/* 隐藏的文件上传 input */}
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSelectVideo} />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSelectSrt} />

      {/* 顶部导航 */}
      <header className="flex items-center justify-between px-3 py-2.5 bg-neutral-900/90 backdrop-blur border-b border-white/10 z-20">
        <button type="button" onClick={onClose} className="flex items-center gap-1 text-xs font-medium text-neutral-300 hover:text-white transition">
          <ArrowLeft className="w-4 h-4" />
          <span>返回</span>
        </button>
        <div className="flex items-center gap-1.5 font-semibold text-sm truncate max-w-[200px]">
          <Film className="w-4 h-4 text-rose-400 shrink-0" />
          <span className="truncate">{videoTitle || "双人放映室"}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-[11px] px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 border border-white/5 transition"
          >
            选片
          </button>
        </div>
      </header>

      {/* 主舞台与放映区域 */}
      <main className="flex-1 relative flex flex-col items-center justify-center bg-black overflow-hidden">
        {!videoSrc ? (
          <div className="flex flex-col items-center gap-4 px-6 text-center">
            <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400">
              <Film className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-base font-bold text-neutral-100">选一部影片，和 TA 一起看</h3>
              <p className="text-xs text-neutral-400 mt-1">支持本地 MP4 / WebM 格式视频与字幕配对</p>
            </div>
            <div className="flex gap-3 mt-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-rose-500 hover:bg-rose-600 font-medium text-xs rounded-xl shadow-lg transition"
              >
                选择视频文件
              </button>
            </div>
          </div>
        ) : (
          <div className="relative w-full h-full flex items-center justify-center bg-black group" onClick={() => setShowControls(!showControls)}>
            <video
              ref={videoRef}
              src={videoSrc}
              className="w-full h-full object-contain"
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              playsInline
            />

            {/* 弹幕浮层 */}
            {showDanmaku && (
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {danmakus
                  .filter((d) => Math.abs(d.time - currentTime) < 5)
                  .map((dm) => (
                    <div
                      key={dm.id}
                      className={`absolute whitespace-nowrap px-2.5 py-1 rounded-full text-xs font-medium shadow-md transition-all ${
                        dm.sender === "char"
                          ? "bg-rose-500/90 text-white border border-rose-300/40"
                          : "bg-white/90 text-neutral-900 border border-white"
                      }`}
                      style={{
                        top: `${15 + dm.lane * 18}%`,
                        right: "-20%",
                        transform: "translateX(-120%)",
                        animation: "danmakuFly 6s linear forwards",
                      }}
                    >
                      {dm.sender === "char" ? `佑: ${dm.text}` : dm.text}
                    </div>
                  ))}
              </div>
            )}

            {/* 字幕浮层 */}
            {showSubtitles && currentSub && (
              <div className="absolute bottom-16 left-4 right-4 text-center pointer-events-none z-10">
                <span className="inline-block px-3 py-1.5 rounded-lg bg-black/70 backdrop-blur-sm text-white text-xs md:text-sm font-medium shadow-lg border border-white/10">
                  {currentSub}
                </span>
              </div>
            )}

            {/* 播放浮层控制条 */}
            <div className={`absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/90 via-black/40 to-transparent flex flex-col gap-2 transition-opacity duration-200 ${showControls ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`} onClick={(e) => e.stopPropagation()}>
              {/* 进度条 */}
              <div className="flex items-center gap-2 text-[10px] text-neutral-400 font-mono">
                <span>{formatTime(currentTime)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={(e) => {
                    if (videoRef.current) {
                      videoRef.current.currentTime = Number(e.target.value);
                    }
                  }}
                  className="flex-1 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-rose-500"
                />
                <span>{formatTime(duration)}</span>
              </div>

              {/* 控制按钮组 */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => seek(-10)} className="hover:text-rose-400"><Rewind className="w-4 h-4" /></button>
                  <button type="button" onClick={togglePlay} className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-white">
                    {isPlaying ? <Pause className="w-4 h-4 text-rose-400" /> : <Play className="w-4 h-4 text-rose-400" />}
                  </button>
                  <button type="button" onClick={() => seek(10)} className="hover:text-rose-400"><FastForward className="w-4 h-4" /></button>
                </div>

                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => srtInputRef.current?.click()} className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-neutral-300 flex items-center gap-1">
                    <Subtitles className="w-3.5 h-3.5" />
                    <span>{subtitles.length ? "已配字幕" : "配字幕"}</span>
                  </button>
                  <button type="button" onClick={() => setShowDanmaku(!showDanmaku)} className={`text-[11px] px-2 py-1 rounded border ${showDanmaku ? "border-rose-400 text-rose-400 bg-rose-500/10" : "border-white/10 text-neutral-400"}`}>
                    弹幕
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 底部互动打字与留影栏 */}
      {videoSrc && (
        <footer className="p-2.5 bg-neutral-950 border-t border-white/10 flex flex-col gap-1.5 z-20">
          {heldFrame && (
            <div className="flex items-center gap-2 px-2 py-1 bg-neutral-900 rounded-lg border border-white/10 self-start">
              <img src={heldFrame} alt="snap" className="w-8 h-8 rounded object-cover border border-white/20" />
              <span className="text-[11px] text-rose-300">已夹住这一帧画面</span>
              <button type="button" onClick={() => setHeldFrame("")} className="text-neutral-400 hover:text-white ml-1">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSnap}
              title="留影：截取当前画面发给佑"
              className={`p-2 rounded-xl border transition ${heldFrame ? "bg-rose-500 text-white border-rose-400" : "bg-neutral-900 border-white/10 text-neutral-300 hover:text-white"}`}
            >
              <Camera className="w-4 h-4" />
            </button>
            <input
              type="text"
              placeholder={isGeneratingReply ? "佑正在想弹幕..." : "和佑随口聊聊这一幕..."}
              value={danmakuInput}
              onChange={(e) => setDanmakuInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSendDanmaku(); }}
              className="flex-1 bg-neutral-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-400"
            />
            <button
              type="button"
              onClick={handleSendDanmaku}
              disabled={(!danmakuInput.trim() && !heldFrame) || isGeneratingReply}
              className="p-2 bg-rose-500 hover:bg-rose-600 disabled:opacity-40 rounded-xl text-white transition"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}