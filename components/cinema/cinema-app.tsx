"use client";

import React, { useState, useRef, useEffect } from "react";
import { 
  ChevronLeft, 
  Play, 
  Pause, 
  Send, 
  Film, 
  Camera, 
  Subtitles, 
  RotateCcw, 
  FastForward, 
  Rewind, 
  Volume2, 
  VolumeX, 
  Sparkles, 
  X,
  Plus
} from "lucide-react";
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

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const remainder = s % 60;
    return `${m.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  };

  const handleSelectVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
    setCurrentTime(0);
    setIsPlaying(false);
  };

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
      return "";
    }
  };

  const handleSnap = () => {
    const frame = grabCurrentFrame();
    if (frame) setHeldFrame(frame);
  };

  const buildCinemaPrompt = (userText: string, currentSec: number, hasFrame: boolean) => {
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

  const handleSendDanmaku = async () => {
    if (!danmakuInput.trim() && !heldFrame) return;
    const text = danmakuInput.trim() || "你看这里~";
    setDanmakuInput("");

    const userDanmaku: DanmakuItem = {
      id: Date.now().toString(),
      sender: "user",
      text,
      time: currentTime,
      lane: Math.floor(Math.random() * 4),
    };
    setDanmakus((prev) => [...prev, userDanmaku]);

    let frameToSend = heldFrame || grabCurrentFrame();
    setHeldFrame("");

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
      console.error(e);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const sec = videoRef.current.currentTime;
    setCurrentTime(sec);

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
    <div 
      className="relative flex flex-col h-full w-full bg-[#0a0a0c] text-neutral-100 select-none overflow-hidden font-sans"
      style={{ zIndex: 100 }}
    >
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSelectVideo} />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSelectSrt} />

      {/* 顶部 iOS 磨砂导航栏 */}
      <header className="relative z-50 flex items-center justify-between px-4 pt-12 pb-3 bg-[#121216]/80 backdrop-blur-xl border-b border-white/5">
        <button 
          type="button" 
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }} 
          className="flex items-center gap-1 text-[15px] font-medium text-rose-400 hover:text-rose-300 active:scale-95 transition"
        >
          <ChevronLeft className="w-5 h-5 -ml-1" />
          <span>返回</span>
        </button>
        
        <div className="flex flex-col items-center">
          <span className="text-[15px] font-semibold text-white/95 max-w-[160px] truncate">
            {videoTitle || "放映室"}
          </span>
          <span className="text-[10px] text-white/40 tracking-wider">WITH YOU</span>
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-xs px-2.5 py-1 rounded-full bg-white/10 hover:bg-white/15 active:scale-95 text-white/80 transition"
        >
          {videoSrc ? "换片" : "选片"}
        </button>
      </header>

      {/* 主播放展示区 */}
      <main className="flex-1 relative flex flex-col items-center justify-center overflow-hidden">
        {!videoSrc ? (
          <div className="flex flex-col items-center gap-5 px-8 text-center max-w-sm">
            <div className="relative">
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-rose-500/20 to-violet-500/20 border border-white/10 flex items-center justify-center shadow-2xl backdrop-blur-md">
                <Film className="w-9 h-9 text-rose-400" />
              </div>
              <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-500/80 flex items-center justify-center text-[10px] text-white font-bold">
                +
              </div>
            </div>

            <div>
              <h3 className="text-lg font-bold tracking-tight text-white/90">双人沉浸放映</h3>
              <p className="text-xs text-white/50 mt-1.5 leading-relaxed">
                选一部喜欢的视频，和佑一起并肩看剧、发弹幕与随心吐槽。
              </p>
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white font-medium text-sm shadow-lg shadow-rose-500/25 active:scale-[0.98] transition"
            >
              从手机相册/文件选片
            </button>
          </div>
        ) : (
          <div 
            className="relative w-full h-full flex items-center justify-center bg-black"
            onClick={() => setShowControls(!showControls)}
          >
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

            {/* 弹幕轨道 */}
            {showDanmaku && (
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                {danmakus
                  .filter((d) => Math.abs(d.time - currentTime) < 5)
                  .map((dm) => (
                    <div
                      key={dm.id}
                      className={`absolute whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium shadow-xl backdrop-blur-md transition-all ${
                        dm.sender === "char"
                          ? "bg-rose-500/80 text-white border border-rose-300/30"
                          : "bg-white/80 text-neutral-900 border border-white/80"
                      }`}
                      style={{
                        top: `${14 + dm.lane * 18}%`,
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

            {/* 字幕条 */}
            {showSubtitles && currentSub && (
              <div className="absolute bottom-16 left-4 right-4 text-center pointer-events-none z-10">
                <span className="inline-block px-3.5 py-1.5 rounded-xl bg-black/60 backdrop-blur-md text-white text-xs font-medium border border-white/10 shadow-lg">
                  {currentSub}
                </span>
              </div>
            )}

            {/* 极简 iOS 磨砂浮动控制器 */}
            <div 
              className={`absolute inset-x-3 bottom-3 p-3.5 rounded-2xl bg-[#18181c]/75 backdrop-blur-xl border border-white/10 shadow-2xl flex flex-col gap-2.5 transition-all duration-300 ${
                showControls ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"
              }`} 
              onClick={(e) => e.stopPropagation()}
            >
              {/* 进度条 */}
              <div className="flex items-center gap-2.5 text-[11px] text-white/50 font-mono">
                <span>{formatTime(currentTime)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  value={currentTime}
                  onChange={(e) => {
                    if (videoRef.current) videoRef.current.currentTime = Number(e.target.value);
                  }}
                  className="flex-1 h-1 bg-white/15 rounded-lg appearance-none cursor-pointer accent-rose-400"
                />
                <span>{formatTime(duration)}</span>
              </div>

              {/* 控制按钮 */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => seek(-10)} className="text-white/60 hover:text-white active:scale-95 transition">
                    <Rewind className="w-4 h-4" />
                  </button>
                  <button type="button" onClick={togglePlay} className="p-2 rounded-full bg-white/10 hover:bg-white/20 active:scale-90 text-rose-400 transition">
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 translate-x-0.5" />}
                  </button>
                  <button type="button" onClick={() => seek(10)} className="text-white/60 hover:text-white active:scale-95 transition">
                    <FastForward className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button 
                    type="button" 
                    onClick={() => srtInputRef.current?.click()} 
                    className="text-[11px] px-2.5 py-1 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-white/70 flex items-center gap-1 active:scale-95 transition"
                  >
                    <Subtitles className="w-3.5 h-3.5" />
                    <span>{subtitles.length ? "已挂字幕" : "配字幕"}</span>
                  </button>
                  <button 
                    type="button" 
                    onClick={() => setShowDanmaku(!showDanmaku)} 
                    className={`text-[11px] px-2.5 py-1 rounded-full border active:scale-95 transition ${
                      showDanmaku ? "border-rose-400/40 text-rose-400 bg-rose-500/10" : "border-white/5 text-white/40 bg-white/5"
                    }`}
                  >
                    弹幕
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 底部打字与互动栏 */}
      {videoSrc && (
        <footer className="p-3 bg-[#121216]/90 backdrop-blur-xl border-t border-white/5 flex flex-col gap-2 z-50 pb-8">
          {heldFrame && (
            <div className="flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-xl border border-white/10 self-start">
              <img src={heldFrame} alt="snap" className="w-7 h-7 rounded-lg object-cover" />
              <span className="text-[11px] text-rose-300 font-medium">已夹住此刻画面</span>
              <button type="button" onClick={() => setHeldFrame("")} className="text-white/40 hover:text-white ml-1">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSnap}
              title="截取画面给佑看"
              className={`p-2.5 rounded-xl border active:scale-95 transition ${
                heldFrame ? "bg-rose-500 text-white border-rose-400" : "bg-white/5 border-white/10 text-white/60 hover:text-white"
              }`}
            >
              <Camera className="w-4 h-4" />
            </button>
            <input
              type="text"
              placeholder={isGeneratingReply ? "佑正在思考弹幕..." : "和佑随口聊聊这一幕..."}
              value={danmakuInput}
              onChange={(e) => setDanmakuInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSendDanmaku(); }}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-rose-400/50 transition"
            />
            <button
              type="button"
              onClick={handleSendDanmaku}
              disabled={(!danmakuInput.trim() && !heldFrame) || isGeneratingReply}
              className="p-2.5 bg-rose-500 hover:bg-rose-600 disabled:opacity-30 rounded-xl text-white active:scale-95 transition"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}
