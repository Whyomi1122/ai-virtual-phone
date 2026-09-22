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
  FastForward, 
  Rewind, 
  X,
  MessageCircle,
  Sparkles,
  BookOpen,
  LayoutTemplate
} from "lucide-react";
import { loadChatSessions, pushChatMessage } from "@/lib/chat-storage";
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

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  frame?: string;
  timeStr: string;
}

export default function CinemaApp({ onClose }: { onClose: () => void }) {
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [videoTitle, setVideoTitle] = useState<string>("");
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [showControls, setShowControls] = useState<boolean>(true);

  // 模式：theater (剧场伴聊流) | immersive (全屏纯享)
  const [viewMode, setViewMode] = useState<"theater" | "immersive">("theater");

  // 字幕与弹幕
  const [subtitles, setSubtitles] = useState<SubtitleCue[]>([]);
  const [currentSub, setCurrentSub] = useState<string>("");
  const [showSubtitles, setShowSubtitles] = useState<boolean>(true);
  const [danmakus, setDanmakus] = useState<DanmakuItem[]>([]);
  const [showDanmaku, setShowDanmaku] = useState<boolean>(true);
  const [danmakuInput, setDanmakuInput] = useState<string>("");

  // 对话流与证据
  const [chatList, setChatList] = useState<ChatMsg[]>([]);
  const [heldFrame, setHeldFrame] = useState<string>("");
  const [isGeneratingReply, setIsGeneratingReply] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const formatTime = (sec: number) => {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const remainder = s % 60;
    return `${m.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatList, isGeneratingReply]);

  const handleSelectVideo = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setVideoTitle(file.name.replace(/\.[a-z0-9]+$/i, ""));
    setCurrentTime(0);
    setIsPlaying(false);
    setChatList([
      {
        id: "sys-welcome",
        role: "assistant",
        content: `我们开始看《${file.name.replace(/\.[a-z0-9]+$/i, "")}》啦！看到想吐槽或有意思的地方，随时和我说~`,
        timeStr: "00:00"
      }
    ]);
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
      const maxW = 480;
      const scale = Math.min(1, maxW / videoRef.current.videoWidth);
      canvas.width = Math.round(videoRef.current.videoWidth * scale);
      canvas.height = Math.round(videoRef.current.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", 0.65);
    } catch (e) {
      return "";
    }
  };

  const handleSnap = () => {
    const frame = grabCurrentFrame();
    if (frame) setHeldFrame(frame);
  };

  // Cove 证据层：构建严格证据 Prompt
  const buildCoveEvidencePrompt = (userText: string, currentSec: number, hasFrame: boolean) => {
    const recentCues = subtitles
      .filter((c) => c.start <= currentSec && currentSec - c.start < 60)
      .slice(-6);
    
    let prompt = `———— 以下是系统随消息附上的共影证据，不是对方说的话；对方真正说的话在最上方 ————\n`;
    prompt += `【共影室】《${videoTitle || "视频"}》· 播放进度 ${formatTime(currentSec)} / ${formatTime(duration)}\n`;
    
    if (recentCues.length) {
      prompt += `[播放点之前最近台词]\n` + recentCues.map((c) => `[${formatTime(c.start)}] ${c.text}`).join("\n") + `\n`;
    } else {
      prompt += `[台词证据] （当前片段暂无台词字幕）\n`;
    }

    if (hasFrame) {
      prompt += `[画面证据] 随附了当前 ${formatTime(currentSec)} 的截图。若有文字请先阅读画面文字。\n`;
    }

    prompt += `[严格边界说明] 你正与对方肩并肩看片。你只知道播放点及之前发生的事情，后面的剧情你完全不知道，严禁剧透、严禁编造未发生的故事。请像坐在身边随口接话一样，一两句即可（30字以内），充满自然生活感与陪伴感。`;
    return prompt;
  };

  const handleSendMessage = async (customText?: string) => {
    const text = (customText || danmakuInput).trim();
    if (!text && !heldFrame) return;
    setDanmakuInput("");

    const nowStr = formatTime(currentTime);
    const frameToSend = heldFrame || (viewMode === "immersive" ? grabCurrentFrame() : "");
    setHeldFrame("");

    // 1. 用户消息上屏
    const userMsg: ChatMsg = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      frame: frameToSend,
      timeStr: nowStr
    };
    setChatList((prev) => [...prev, userMsg]);

    // 2. 弹幕飞过
    const userDanmaku: DanmakuItem = {
      id: Date.now().toString(),
      sender: "user",
      text,
      time: currentTime,
      lane: Math.floor(Math.random() * 4),
    };
    setDanmakus((prev) => [...prev, userDanmaku]);

    // 3. AI 回复
    setIsGeneratingReply(true);
    try {
      const sessions = loadChatSessions();
      const currentSession = sessions[0];
      if (currentSession) {
        const evidence = buildCoveEvidencePrompt(text, currentTime, Boolean(frameToSend));
        const fullPrompt = `${text}\n\n${evidence}`;

        const completionResult = await generateChatCompletion(
          currentSession,
          [{
            id: Date.now().toString(),
            role: "user",
            content: fullPrompt,
            createdAt: Date.now(),
            imageUrls: frameToSend ? [frameToSend] : undefined
          }],
          { appTags: ["cinema", "cove"] }
        );

        const reply = flattenCompletionResult(completionResult)
          .replace(/\[.*?\]/g, "")
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();

        if (reply) {
          setTimeout(() => {
            setChatList((prev) => [
              ...prev,
              {
                id: (Date.now() + 1).toString(),
                role: "assistant",
                content: reply,
                timeStr: formatTime(currentTime)
              }
            ]);
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
          }, 600);
        }
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsGeneratingReply(false);
    }
  };

  // Cove 整片聊聊与沉淀记忆
  const handleWholeFilmChat = async () => {
    if (!videoTitle) return;
    setIsGeneratingReply(true);
    try {
      const sessions = loadChatSessions();
      const currentSession = sessions[0];
      if (currentSession) {
        const prompt = `【共影总结】我们刚刚一起看完了《${videoTitle}》。请你以伴侣的口吻，结合刚才的观影陪伴，写一段 50 字左右温馨走心的观后短评感言，并表示很开心能一起看。`;
        const completionResult = await generateChatCompletion(
          currentSession,
          [{ id: Date.now().toString(), role: "user", content: prompt, createdAt: Date.now() }],
          { appTags: ["cinema", "summary"] }
        );
        const reply = flattenCompletionResult(completionResult).replace(/\[.*?\]/g, "").trim();
        if (reply) {
          setChatList((prev) => [
            ...prev,
            {
              id: Date.now().toString(),
              role: "assistant",
              content: `🎬 观影纪念：\n${reply}`,
              timeStr: "全片"
            }
          ]);
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
      className="relative flex flex-col h-full w-full bg-[#0d0d11] text-neutral-100 select-none overflow-hidden font-sans"
      style={{ zIndex: 100 }}
    >
      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleSelectVideo} />
      <input ref={srtInputRef} type="file" accept=".srt,.vtt" className="hidden" onChange={handleSelectSrt} />

      {/* 顶部 iOS 磨砂导航栏 */}
      <header className="relative z-50 flex items-center justify-between px-4 pt-12 pb-3 bg-[#131318]/90 backdrop-blur-xl border-b border-white/5">
        <button 
          type="button" 
          onClick={(e) => { e.stopPropagation(); onClose(); }} 
          className="flex items-center gap-1 text-[15px] font-medium text-rose-400 hover:text-rose-300 active:scale-95 transition"
        >
          <ChevronLeft className="w-5 h-5 -ml-1" />
          <span>返回</span>
        </button>
        
        <div className="flex flex-col items-center">
          <span className="text-[15px] font-semibold text-white/95 max-w-[150px] truncate">
            {videoTitle || "共影空间"}
          </span>
          <span className="text-[10px] text-white/40 tracking-wider">COVE COMPANION</span>
        </div>

        <div className="flex items-center gap-1.5">
          {videoSrc && (
            <button
              type="button"
              onClick={() => setViewMode(viewMode === "theater" ? "immersive" : "theater")}
              title="切换伴聊/全屏模式"
              className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 text-white/70 active:scale-95 transition"
            >
              <LayoutTemplate className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-xs px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 active:scale-95 transition"
          >
            {videoSrc ? "换片" : "选片"}
          </button>
        </div>
      </header>

      {/* 主体区域 */}
      <main className="flex-1 relative flex flex-col overflow-hidden">
        {!videoSrc ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 px-8 text-center max-w-sm mx-auto">
            <div className="w-20 h-20 rounded-3xl bg-gradient-to-tr from-rose-500/20 to-purple-500/20 border border-white/10 flex items-center justify-center shadow-2xl backdrop-blur-md">
              <Film className="w-9 h-9 text-rose-400" />
            </div>

            <div>
              <h3 className="text-lg font-bold tracking-tight text-white/90">双人共影与伴聊</h3>
              <p className="text-xs text-white/50 mt-1.5 leading-relaxed">
                导入视频与字幕，佑将根据真实播放时刻与台词证据，实时陪你吐槽与交流。
              </p>
            </div>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 text-white font-medium text-sm shadow-lg shadow-rose-500/25 active:scale-[0.98] transition"
            >
              选择本地视频开始
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 1. 播放舞台 */}
            <div 
              className={`relative bg-black transition-all duration-300 ${
                viewMode === "immersive" ? "flex-1" : "h-[36vh] shrink-0"
              }`}
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

              {/* 弹幕浮层 */}
              {showDanmaku && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  {danmakus
                    .filter((d) => Math.abs(d.time - currentTime) < 5)
                    .map((dm) => (
                      <div
                        key={dm.id}
                        className={`absolute whitespace-nowrap px-3 py-1 rounded-full text-xs font-medium shadow-xl backdrop-blur-md transition-all ${
                          dm.sender === "char"
                            ? "bg-rose-500/85 text-white border border-rose-300/30"
                            : "bg-white/85 text-neutral-900 border border-white/80"
                        }`}
                        style={{
                          top: `${12 + dm.lane * 20}%`,
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
                <div className="absolute bottom-14 left-4 right-4 text-center pointer-events-none z-10">
                  <span className="inline-block px-3.5 py-1.5 rounded-xl bg-black/75 backdrop-blur-md text-white text-xs font-medium border border-white/10 shadow-lg">
                    {currentSub}
                  </span>
                </div>
              )}

              {/* 悬浮控制器 */}
              <div 
                className={`absolute inset-x-2.5 bottom-2 p-2.5 rounded-2xl bg-[#141418]/80 backdrop-blur-xl border border-white/10 shadow-2xl flex flex-col gap-2 transition-all duration-300 ${
                  showControls ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"
                }`} 
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-2 text-[10px] text-white/50 font-mono">
                  <span>{formatTime(currentTime)}</span>
                  <input
                    type="range"
                    min={0}
                    max={duration || 100}
                    value={currentTime}
                    onChange={(e) => {
                      if (videoRef.current) videoRef.current.currentTime = Number(e.target.value);
                    }}
                    className="flex-1 h-1 bg-white/15 rounded-lg appearance-none accent-rose-400"
                  />
                  <span>{formatTime(duration)}</span>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <button type="button" onClick={() => seek(-10)} className="text-white/60 hover:text-white"><Rewind className="w-3.5 h-3.5" /></button>
                    <button type="button" onClick={togglePlay} className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 text-rose-400">
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 translate-x-0.5" />}
                    </button>
                    <button type="button" onClick={() => seek(10)} className="text-white/60 hover:text-white"><FastForward className="w-3.5 h-3.5" /></button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button 
                      type="button" 
                      onClick={() => srtInputRef.current?.click()} 
                      className="text-[10px] px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-white/70 flex items-center gap-1"
                    >
                      <Subtitles className="w-3 h-3" />
                      <span>{subtitles.length ? "已配字幕" : "配字幕"}</span>
                    </button>
                    <button 
                      type="button" 
                      onClick={() => setShowDanmaku(!showDanmaku)} 
                      className={`text-[10px] px-2 py-0.5 rounded-full border ${
                        showDanmaku ? "border-rose-400/40 text-rose-400 bg-rose-500/10" : "border-white/5 text-white/40"
                      }`}
                    >
                      弹幕
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 2. Cove 伴看衔接状态条 (Theater 模式) */}
            {viewMode === "theater" && (
              <div className="flex items-center justify-between px-3.5 py-2 bg-[#17171e]/90 border-y border-white/5 text-[11px] text-white/60">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-white/80 font-medium">与 佑 同步观影中</span>
                  <span className="text-white/30">|</span>
                  <span className="text-white/40 font-mono">{formatTime(currentTime)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    type="button" 
                    onClick={() => handleSendMessage("这一幕好精彩，你怎么看？")}
                    className="text-rose-400 hover:text-rose-300 font-medium active:scale-95 transition"
                  >
                    问这一幕
                  </button>
                  <span className="text-white/20">·</span>
                  <button 
                    type="button" 
                    onClick={handleWholeFilmChat}
                    className="text-white/60 hover:text-white transition"
                  >
                    整片聊聊
                  </button>
                </div>
              </div>
            )}

            {/* 3. Cove 对话流区域 (Theater 模式) */}
            {viewMode === "theater" && (
              <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-3.5 space-y-3">
                {chatList.map((msg) => (
                  <div 
                    key={msg.id} 
                    className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
                  >
                    <div className="flex items-center gap-1.5 mb-1 px-1">
                      <span className="text-[10px] text-white/30">{msg.role === "user" ? "我" : "佑"}</span>
                      <span className="text-[9px] text-white/20 font-mono">@{msg.timeStr}</span>
                    </div>
                    {msg.frame && (
                      <img 
                        src={msg.frame} 
                        alt="frame" 
                        className="w-32 h-20 object-cover rounded-xl border border-white/10 mb-1.5 shadow-md"
                      />
                    )}
                    <div 
                      className={`max-w-[82%] px-3.5 py-2 rounded-2xl text-xs leading-relaxed ${
                        msg.role === "user"
                          ? "bg-rose-500 text-white rounded-tr-sm"
                          : "bg-[#1f1f27] text-white/90 border border-white/5 rounded-tl-sm shadow-md"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
                {isGeneratingReply && (
                  <div className="flex items-center gap-1.5 text-xs text-rose-400/80 px-2 py-1">
                    <Sparkles className="w-3.5 h-3.5 animate-spin" />
                    <span>佑正在思考这一幕...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* 底部打字输入栏 */}
      {videoSrc && (
        <footer className="p-3 bg-[#131318]/95 backdrop-blur-xl border-t border-white/5 flex flex-col gap-2 z-50 pb-8">
          {heldFrame && (
            <div className="flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-xl border border-white/10 self-start">
              <img src={heldFrame} alt="snap" className="w-7 h-7 rounded-lg object-cover" />
              <span className="text-[11px] text-rose-300 font-medium">已夹住此刻画面证据</span>
              <button type="button" onClick={() => setHeldFrame("")} className="text-white/40 hover:text-white ml-1">
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSnap}
              title="截取当前帧画面证据"
              className={`p-2.5 rounded-xl border active:scale-95 transition ${
                heldFrame ? "bg-rose-500 text-white border-rose-400" : "bg-white/5 border-white/10 text-white/60 hover:text-white"
              }`}
            >
              <Camera className="w-4 h-4" />
            </button>
            <input
              type="text"
              placeholder={isGeneratingReply ? "佑正在想弹幕..." : "和佑随口聊聊这一幕..."}
              value={danmakuInput}
              onChange={(e) => setDanmakuInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSendMessage(); }}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3.5 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-rose-400/50 transition"
            />
            <button
              type="button"
              onClick={() => handleSendMessage()}
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
