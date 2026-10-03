import React, { useState, useRef, useEffect, createContext, useContext } from 'react';
import {
  Play, Pause, Square, RotateCcw, SkipBack, Scissors, Mic, Type, Download,
  Trash2, Plus, Volume2, VolumeX, Music, Wand2, Upload, ChevronRight,
  ChevronLeft, X, Save, Image as ImageIcon, GripVertical, ZoomIn, ZoomOut, Maximize2,
  Copy, AlignLeft, AlignCenter, AlignRight, Sliders, Sparkles, FolderDown, FolderUp, FolderOpen, MoreHorizontal
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { get, set } from 'idb-keyval';
import { generateAIVoice } from './services/gemini';
import { Subtitle, Voiceover, VideoState, VideoClip } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { Login } from './components/Login';
import { readStoredUser, type AuthUser } from './lib/auth';
import { loadFFmpeg, writeFrame, writeAudioInput, hasAudioStream, deleteFile, buildFfmpegCommand, runEncode, readOutput, encodePassthroughVideoSegment, encodePassthroughImageSegment, concatSegments, encodeOverlayPass, type AudioInput } from './lib/ffmpegExport';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const MAGIC_BASE = 'https://cookie.vegvisr.org';
const DASHBOARD_BASE = 'https://dashboard.vegvisr.org';

const AuthContext = createContext<AuthUser | null>(null);

function AuthGate({ children }: { children: React.ReactNode }) {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState<'checking' | 'authed' | 'anonymous'>('checking');

  const setAuthCookie = (token: string) => {
    if (!token) return;
    const isVegvisr = window.location.hostname.endsWith('vegvisr.org');
    const domain = isVegvisr ? '; Domain=.vegvisr.org' : '';
    const maxAge = 60 * 60 * 24 * 30;
    document.cookie = `vegvisr_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure${domain}`;
  };

  const persistUser = (user: {
    email: string;
    role: string;
    user_id: string | null;
    emailVerificationToken: string | null;
    oauth_id?: string | null;
  }) => {
    const payload = {
      email: user.email,
      role: user.role,
      user_id: user.user_id,
      oauth_id: user.oauth_id || user.user_id || null,
      emailVerificationToken: user.emailVerificationToken,
    };
    localStorage.setItem('user', JSON.stringify(payload));
    if (user.emailVerificationToken) setAuthCookie(user.emailVerificationToken);
    sessionStorage.setItem('email_session_verified', '1');
    setAuthUser({
      userId: payload.user_id || payload.oauth_id || '',
      email: payload.email,
      role: payload.role || null,
    });
  };

  const fetchUserContext = async (targetEmail: string) => {
    const roleRes = await fetch(`${DASHBOARD_BASE}/get-role?email=${encodeURIComponent(targetEmail)}`);
    if (!roleRes.ok) throw new Error(`User role unavailable (status: ${roleRes.status})`);
    const roleData = await roleRes.json();
    if (!roleData?.role) throw new Error('Unable to retrieve user role.');
    const userDataRes = await fetch(`${DASHBOARD_BASE}/userdata?email=${encodeURIComponent(targetEmail)}`);
    if (!userDataRes.ok) throw new Error(`Unable to fetch user data (status: ${userDataRes.status})`);
    const userData = await userDataRes.json();
    return {
      email: targetEmail,
      role: roleData.role,
      user_id: userData.user_id,
      emailVerificationToken: userData.emailVerificationToken,
      oauth_id: userData.oauth_id,
    };
  };

  const verifyMagicToken = async (token: string) => {
    const res = await fetch(`${MAGIC_BASE}/login/magic/verify?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok || !data.success || !data.email) throw new Error(data.error || 'Invalid or expired magic link.');
    try {
      const userContext = await fetchUserContext(data.email);
      persistUser(userContext);
    } catch {
      persistUser({ email: data.email, role: 'user', user_id: data.email, emailVerificationToken: null });
    }
  };

  const clearAuthCookie = () => {
    const base = 'vegvisr_token=; Path=/; Max-Age=0; SameSite=Lax; Secure';
    document.cookie = base;
    if (window.location.hostname.endsWith('vegvisr.org')) {
      document.cookie = `${base}; Domain=.vegvisr.org`;
    }
  };

  const handleLogout = () => {
    try {
      localStorage.removeItem('user');
      sessionStorage.removeItem('email_session_verified');
    } catch { /* ignore */ }
    clearAuthCookie();
    setAuthUser(null);
    setAuthStatus('anonymous');
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const magic = url.searchParams.get('magic');
    if (!magic) return;
    setAuthStatus('checking');
    verifyMagicToken(magic)
      .then(() => {
        url.searchParams.delete('magic');
        window.history.replaceState({}, '', url.toString());
        setAuthStatus('authed');
      })
      .catch(() => setAuthStatus('anonymous'));
  }, []);

  useEffect(() => {
    let isMounted = true;
    const stored = readStoredUser();
    if (stored && isMounted) {
      setAuthUser(stored);
      setAuthStatus('authed');
    } else if (isMounted) {
      setAuthStatus('anonymous');
    }
    return () => { isMounted = false; };
  }, []);

  if (authStatus === 'authed') {
    return (
      <AuthContext.Provider value={authUser}>
        <div className="flex flex-col h-screen">
          <div className="flex-shrink-0 border-b border-slate-800 bg-slate-900 px-4 py-1.5 flex items-center justify-end">
            <span className="text-xs text-slate-400 mr-3">{authUser?.email}</span>
            <button
              type="button"
              onClick={handleLogout}
              className="text-xs text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 rounded-md px-2.5 py-1 transition-colors"
            >
              Log out
            </button>
          </div>
          {children}
        </div>
      </AuthContext.Provider>
    );
  }

  if (authStatus === 'anonymous') {
    return <Login />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 text-white text-sm">
      Checking session...
    </div>
  );
}

export function useAuthUser() {
  return useContext(AuthContext);
}

function VidoCutApp() {
  const [videoState, setVideoState] = useState<VideoState>({
    clips: [],
    subtitles: [],
    voiceovers: [],
    watermarkSize: 15,
  });

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const selectedClip = videoState.clips.find(c => c.id === selectedClipId);
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<string | null>(null);
  const selectedSubtitle = videoState.subtitles.find(s => s.id === selectedSubtitleId) || (videoState.subtitles.length > 0 ? videoState.subtitles[0] : null);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  // Persistence: Load state
  useEffect(() => {
    const loadState = async () => {
      try {
        const savedState = await get<VideoState>('vocalcut-project');
        if (savedState) {
          // Recreate URLs for files
          const clipsWithUrls = savedState.clips.map(clip => ({
            ...clip,
            type: clip.type || 'video',
            url: clip.file ? URL.createObjectURL(clip.file) : clip.url
          }));
          const voiceoversWithUrls = savedState.voiceovers.map(v => ({
            ...v,
            url: v.file ? URL.createObjectURL(v.file) : v.url
          }));
          
          setVideoState({
            ...savedState,
            clips: clipsWithUrls,
            voiceovers: voiceoversWithUrls
          });
          
          if (clipsWithUrls.length > 0) {
            setSelectedClipId(clipsWithUrls[0].id);
          }
        }
      } catch (error) {
        console.error("Failed to load project:", error);
      } finally {
        setIsLoaded(true);
      }
    };
    loadState();
  }, []);

  // Persistence: Save state
  useEffect(() => {
    if (!isLoaded) return;
    
    const saveState = async () => {
      try {
        // We don't save the URLs as they change every session
        await set('vocalcut-project', videoState);
      } catch (error) {
        console.error("Failed to save project:", error);
      }
    };
    
    const timeout = setTimeout(saveState, 1000);
    return () => clearTimeout(timeout);
  }, [videoState, isLoaded]);
  
  const totalDuration = videoState.clips.reduce((acc, clip) => {
    const duration = (clip.trimEnd || 0) - (clip.trimStart || 0);
    return acc + (isFinite(duration) ? duration : 0);
  }, 0);

  const getGlobalTime = (clipId: string, localTime: number) => {
    let globalTime = 0;
    for (const clip of videoState.clips) {
      if (clip.id === clipId) {
        return globalTime + (localTime - clip.trimStart);
      }
      globalTime += (clip.trimEnd - clip.trimStart);
    }
    return globalTime;
  };

  const getClipGlobalStart = (clipId: string) => {
    let globalStart = 0;
    for (const clip of videoState.clips) {
      if (clip.id === clipId) return globalStart;
      globalStart += (clip.trimEnd - clip.trimStart);
    }
    return 0;
  };


  const getVoiceoverGlobalTime = (v: Voiceover) => {
    if (!v.clipId) return v.relativeStartTime >= 0 ? v.relativeStartTime : ((v as any).startTime || 0);
    let globalTime = 0;
    for (const clip of videoState.clips) {
      if (clip.id === v.clipId) {
        return globalTime + v.relativeStartTime;
      }
      globalTime += (clip.trimEnd - clip.trimStart);
    }
    return v.relativeStartTime >= 0 ? v.relativeStartTime : -1;
  };

  const getClipAtTime = (globalTime: number) => {
    let accumulatedTime = 0;
    for (const clip of videoState.clips) {
      const clipDuration = clip.trimEnd - clip.trimStart;
      if (globalTime <= accumulatedTime + clipDuration) {
        return { clip, localTime: clip.trimStart + (globalTime - accumulatedTime) };
      }
      accumulatedTime += clipDuration;
    }
    return null;
  };

  const handleTimelineScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left + timelineRef.current.scrollLeft);
    const targetGlobalTime = Math.max(0, Math.min(x / zoom, totalDuration));
    
    const clipInfo = getClipAtTime(targetGlobalTime);
    if (clipInfo) {
      if (clipInfo.clip.id !== selectedClipId) {
        setSelectedClipId(clipInfo.clip.id);
      }
      if (videoRef.current && isFinite(clipInfo.localTime)) {
        videoRef.current.currentTime = clipInfo.localTime;
      }
    }
    setCurrentTime(targetGlobalTime);
  };

  const [activeTab, setActiveTab] = useState<'trim' | 'voice' | 'subtitles' | 'watermark'>('trim');
  // Phone layout only (below md): the contextual panel is a bottom sheet, and
  // the secondary header actions live in an overflow menu.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiVoice, setAiVoice] = useState<'Kore' | 'Puck' | 'Charon' | 'Fenrir' | 'Zephyr'>('Kore');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [selectedVoiceoverId, setSelectedVoiceoverId] = useState<string | null>(null);

  type DraggingState = {
    kind: 'clip-trim-start' | 'clip-trim-end' | 'clip-move' | 'voiceover-move' | 'voiceover-trim-start' | 'voiceover-trim-end' | 'subtitle-move' | 'subtitle-trim-start' | 'subtitle-trim-end';
    id: string;
    initialClientX: number;
    initialTrimStart?: number;
    initialTrimEnd?: number;
    initialGlobalStart?: number;
    initialDuration?: number;
    initialStart?: number;
    initialEnd?: number;
  } | null;

  const [draggingState, setDraggingState] = useState<DraggingState>(null);
  const [zoom, setZoom] = useState(50); // pixels per second for composition lanes
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const [isSavingProject, setIsSavingProject] = useState(false);
  const [projectMessage, setProjectMessage] = useState<string | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDraggingFile) setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingFile(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFilesArray(Array.from(e.dataTransfer.files));
    }
  };


  const videoRef = useRef<HTMLVideoElement>(null);
  const voiceoverAudioMapRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const timelineRef = useRef<HTMLDivElement>(null);
  const addTrackFileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Handle Media and Audio File Uploads
  const handleFilesArray = async (fileList: File[]) => {
    if (!fileList || fileList.length === 0) return;

    const newClips: VideoClip[] = [];

    const getDuration = (file: File): Promise<number> => {
      return new Promise((resolve) => {
        if (file.type.startsWith('image/')) {
          resolve(5);
          return;
        }
        const isAudio = file.type.startsWith('audio/') || /\.(wav|wave|mp3|m4a|aac|ogg|flac|wma)$/i.test(file.name);
        const tempEl = document.createElement(isAudio ? 'audio' : 'video');
        tempEl.preload = 'metadata';
        const tempUrl = URL.createObjectURL(file);
        tempEl.src = tempUrl;
        tempEl.onloadedmetadata = () => {
          if (isFinite(tempEl.duration)) {
            resolve(tempEl.duration);
            return;
          }
          // Some MP4/MOV files (phone recordings, screen captures) report
          // duration as Infinity until the browser seeks near the end.
          tempEl.currentTime = 1e101;
          tempEl.ontimeupdate = () => {
            tempEl.ontimeupdate = null;
            resolve(isFinite(tempEl.duration) ? tempEl.duration : 5);
          };
        };
        tempEl.onerror = () => {
          resolve(5);
        };
      });
    };

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const url = URL.createObjectURL(file);
      const isAudio = file.type.startsWith('audio/') || /\.(wav|wave|mp3|m4a|aac|ogg|flac|wma)$/i.test(file.name);

      if (isAudio) {
        const audioDuration = await getDuration(file);
        addVoiceover(url, 'recorded', file.name, file);

        // If no video or image clips exist yet, generate a default canvas background clip matching audio duration
        if (videoState.clips.length === 0 && newClips.length === 0) {
          const id = Math.random().toString(36).substr(2, 9);
          newClips.push({
            id,
            url: '', // Canvas placeholder
            file: undefined,
            duration: audioDuration || 5,
            trimStart: 0,
            trimEnd: audioDuration || 5,
            type: 'image'
          });
        }
        continue;
      }

      const id = Math.random().toString(36).substr(2, 9);
      const type = file.type.startsWith('image/') ? 'image' : 'video';
      const duration = await getDuration(file);

      newClips.push({
        id,
        url,
        file,
        duration,
        trimStart: 0,
        trimEnd: duration,
        type
      });
    }

    if (newClips.length > 0) {
      setVideoState(prev => ({
        ...prev,
        clips: [...prev.clips, ...newClips],
      }));

      if (!selectedClipId) {
        setSelectedClipId(newClips[0].id);
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await handleFilesArray(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const duplicateClip = (clip: VideoClip) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newClip: VideoClip = {
      ...clip,
      id,
    };

    // Duplicate voiceovers associated with this clip
    const relatedVoiceovers = videoState.voiceovers
      .filter(v => v.clipId === clip.id)
      .map(v => ({
        ...v,
        id: Math.random().toString(36).substr(2, 9),
        clipId: id
      }));

    setVideoState(prev => ({
      ...prev,
      clips: [...prev.clips, newClip],
      voiceovers: [...prev.voiceovers, ...relatedVoiceovers]
    }));
    setSelectedClipId(id);
  };

  const handleSplitClip = () => {
    if (!selectedClip) return;
    
    // Find global start time of selected clip
    const gStart = getClipGlobalStart(selectedClip.id);
    const gEnd = gStart + (selectedClip.trimEnd - selectedClip.trimStart);
    
    // Check if current playhead (currentTime) is within the clip bounds
    if (currentTime > gStart && currentTime < gEnd) {
      const localSplitTime = currentTime - gStart + selectedClip.trimStart;
      
      const clipIndex = videoState.clips.findIndex(c => c.id === selectedClip.id);
      if (clipIndex === -1) return;
      
      const leftClip: VideoClip = {
        ...selectedClip,
        trimEnd: localSplitTime
      };
      
      const rightClip: VideoClip = {
        ...selectedClip,
        id: Math.random().toString(36).substr(2, 9),
        trimStart: localSplitTime
      };
      
      const updatedClips = [...videoState.clips];
      updatedClips.splice(clipIndex, 1, leftClip, rightClip);
      
      setVideoState(prev => ({
        ...prev,
        clips: updatedClips
      }));
      
      // Auto select the right clip
      setSelectedClipId(rightClip.id);
    }
  };

  const toggleMuteClip = (clipId: string) => {
    setVideoState(prev => ({
      ...prev,
      clips: prev.clips.map(c => c.id === clipId ? { ...c, muted: !c.muted } : c)
    }));
  };

  const handleExtractAudio = (clip: VideoClip) => {
    if (clip.type !== 'video') return;

    const clipIndex = videoState.clips.findIndex(c => c.id === clip.id);
    const newVoiceover: Voiceover = {
      id: Math.random().toString(36).substr(2, 9),
      url: clip.url,
      file: clip.file,
      clipId: clip.id,
      relativeStartTime: 0,
      type: 'extracted',
      text: `Extracted Audio (Clip ${clipIndex >= 0 ? clipIndex + 1 : 1})`
    };

    setVideoState(prev => ({
      ...prev,
      clips: prev.clips.map(c => c.id === clip.id ? { ...c, muted: true } : c),
      voiceovers: [...prev.voiceovers, newVoiceover]
    }));
  };


  const onLoadedMetadata = (id: string) => {
    const clip = videoState.clips.find(c => c.id === id);
    if (clip?.type === 'image') return;

    if (videoRef.current) {
      const duration = videoRef.current.duration;
      if (isFinite(duration)) {
        setVideoState(prev => ({
          ...prev,
          clips: prev.clips.map(c => c.id === id ? { ...c, duration, trimEnd: duration } : c),
        }));
      }

      // The <video> element is keyed by clip id, so advancing to the next clip
      // remounts a fresh (paused) element. If a play-through is in progress,
      // seek to this clip's trim start and resume so playback spans all tracks.
      if (isPlaying) {
        if (clip && isFinite(clip.trimStart)) {
          videoRef.current.currentTime = clip.trimStart;
        }
        videoRef.current.play().catch(() => {});
      }
    }
  };

  const pauseAllPlayback = () => {
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
    voiceoverAudioMapRef.current.forEach(audio => {
      try {
        if (!audio.paused) audio.pause();
      } catch (e) {}
    });
  };

  const handleStop = () => {
    pauseAllPlayback();
    setCurrentTime(0);
    if (videoState.clips.length > 0) {
      const firstClip = videoState.clips[0];
      setSelectedClipId(firstClip.id);
      if (videoRef.current && isFinite(firstClip.trimStart)) {
        videoRef.current.currentTime = firstClip.trimStart;
      }
    }
  };

  const togglePlay = () => {
    if (isPlaying) {
      pauseAllPlayback();
    } else {
      if (currentTime >= totalDuration - 0.05 && totalDuration > 0) {
        setCurrentTime(0);
        if (videoState.clips.length > 0) {
          const firstClip = videoState.clips[0];
          setSelectedClipId(firstClip.id);
          if (videoRef.current && isFinite(firstClip.trimStart)) {
            videoRef.current.currentTime = firstClip.trimStart;
          }
        }
      }

      setIsPlaying(true);
      if (videoRef.current && selectedClip?.type === 'video') {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name !== 'AbortError') {
              console.error("Playback failed:", error);
            }
          });
        }
      }
    }
  };

  // Support image playback transition
  useEffect(() => {
    if (!isPlaying || selectedClip?.type !== 'image') return;

    let frameId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const delta = (now - lastTime) / 1000;
      lastTime = now;

      setCurrentTime(prev => {
        const nextTime = prev + delta;
        
        // Find current clip's global start time
        let globalStart = 0;
        for (const clip of videoState.clips) {
          if (clip.id === selectedClip!.id) break;
          globalStart += (clip.trimEnd - clip.trimStart);
        }
        
        const localTime = nextTime - globalStart + selectedClip!.trimStart;

        if (localTime >= selectedClip!.trimEnd) {
          const nextClipInfo = getClipAtTime(nextTime + 0.05);
          if (nextClipInfo && nextClipInfo.clip.id !== selectedClip!.id) {
            setTimeout(() => setSelectedClipId(nextClipInfo.clip.id), 0);
          } else {
            setTimeout(() => pauseAllPlayback(), 0);
            return globalStart + (selectedClip!.trimEnd - selectedClip!.trimStart);
          }
        }
        return nextTime;
      });

      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, selectedClipId, selectedClip?.trimEnd, videoState.clips]);

  // Advance to the next clip on the timeline, or stop if this is the last clip.
  // Shared by the trimmed-end path (handleTimeUpdate) and the natural-end path
  // (handleVideoEnded), because a clip whose trimEnd equals its real duration
  // fires `ended` before handleTimeUpdate ever reports localTime >= trimEnd.
  const advancePastClip = (clip: VideoClip) => {
    const globalEnd = getGlobalTime(clip.id, clip.trimEnd);
    const nextClipInfo = getClipAtTime(globalEnd + 0.01);
    if (nextClipInfo && nextClipInfo.clip.id !== clip.id) {
      // The <video> is keyed by clip id, so this remounts a fresh element;
      // its onLoadedMetadata resumes playback while isPlaying is true.
      setCurrentTime(globalEnd);
      setSelectedClipId(nextClipInfo.clip.id);
    } else {
      if (videoRef.current && isFinite(clip.trimStart)) {
        videoRef.current.currentTime = clip.trimStart;
      }
      pauseAllPlayback();
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current && selectedClip) {
      const localTime = videoRef.current.currentTime;
      const globalTime = getGlobalTime(selectedClip.id, localTime);
      setCurrentTime(globalTime);

      // Trimmed clip: advance before the underlying file ends.
      if (localTime >= selectedClip.trimEnd) {
        advancePastClip(selectedClip);
      }
    }
  };

  const handleVideoEnded = () => {
    if (selectedClip) {
      advancePastClip(selectedClip);
    }
  };

  useEffect(() => {
    if (videoRef.current && selectedClip) {
      videoRef.current.muted = !!selectedClip.muted;
      // When selected clip changes, we might need to seek to its trim start
      // but only if we are not already at the right global time
      const clipInfo = getClipAtTime(currentTime);
      if (clipInfo && clipInfo.clip.id === selectedClip.id) {
        if (isFinite(clipInfo.localTime) && Math.abs(videoRef.current.currentTime - clipInfo.localTime) > 0.1) {
          videoRef.current.currentTime = clipInfo.localTime;
        }
      } else if (isFinite(selectedClip.trimStart)) {
        videoRef.current.currentTime = selectedClip.trimStart;
      }
    }
  }, [selectedClipId, selectedClip?.muted]);

  // Voiceover: Recording
  const startRecording = async () => {
    try {
      // Use high-quality audio constraints to prevent distortion
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 1
        } 
      });

      // Try to find the best supported mime type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
        ? 'audio/webm;codecs=opus' 
        : 'audio/ogg;codecs=opus';

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        audioBitsPerSecond: 128000 // High bitrate for clarity
      });

      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const audioUrl = URL.createObjectURL(audioBlob);
        addVoiceover(audioUrl, 'recorded');
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  // Timeline Dragging Logic
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingState) return;

      const deltaPixels = e.clientX - draggingState.initialClientX;
      const deltaSeconds = deltaPixels / zoom;

      setVideoState(prev => {
        // 1. Clip trim start / end
        if (draggingState.kind === 'clip-trim-start' || draggingState.kind === 'clip-trim-end') {
          const clipIndex = prev.clips.findIndex(c => c.id === draggingState.id);
          if (clipIndex === -1) return prev;

          const clip = prev.clips[clipIndex];
          const newClips = [...prev.clips];

          if (draggingState.kind === 'clip-trim-start') {
            const initialStart = draggingState.initialTrimStart ?? 0;
            const initialEnd = draggingState.initialTrimEnd ?? clip.duration;
            const newTrimStart = Math.max(0, Math.min(initialStart + deltaSeconds, initialEnd - 0.2));
            newClips[clipIndex] = { ...clip, trimStart: newTrimStart };
            if (videoRef.current && isFinite(newTrimStart)) {
              videoRef.current.currentTime = newTrimStart;
            }
          } else {
            const initialStart = draggingState.initialTrimStart ?? 0;
            const initialEnd = draggingState.initialTrimEnd ?? clip.duration;
            const maxDur = clip.type === 'image' ? 120 : (clip.duration || 10);
            const newTrimEnd = Math.max(initialStart + 0.2, Math.min(initialEnd + deltaSeconds, maxDur));
            newClips[clipIndex] = { ...clip, trimEnd: newTrimEnd };
            if (videoRef.current && isFinite(newTrimEnd)) {
              videoRef.current.currentTime = newTrimEnd;
            }
          }
          return { ...prev, clips: newClips };
        }

        // 2. Clip move (reorder video/image clip on timeline track)
        if (draggingState.kind === 'clip-move') {
          const clipIndex = prev.clips.findIndex(c => c.id === draggingState.id);
          if (clipIndex === -1) return prev;

          const targetGlobalTime = Math.max(0, (draggingState.initialGlobalStart ?? 0) + deltaSeconds);
          const currentClips = [...prev.clips];
          const clip = currentClips[clipIndex];

          let accumulatedTime = 0;
          let targetIndex = clipIndex;

          for (let i = 0; i < currentClips.length; i++) {
            const c = currentClips[i];
            const cDur = c.trimEnd - c.trimStart;
            const midpoint = accumulatedTime + cDur / 2;
            if (targetGlobalTime > midpoint) {
              targetIndex = i;
            }
            accumulatedTime += cDur;
          }

          targetIndex = Math.max(0, Math.min(currentClips.length - 1, targetIndex));

          if (targetIndex !== clipIndex) {
            currentClips.splice(clipIndex, 1);
            currentClips.splice(targetIndex, 0, clip);
            return { ...prev, clips: currentClips };
          }
          return prev;
        }

        // 3. Voiceover move (reposition sound/audio clip)
        if (draggingState.kind === 'voiceover-move') {
          const vId = draggingState.id;
          const newGlobalStart = Math.max(0, (draggingState.initialGlobalStart ?? 0) + deltaSeconds);

          let accumulated = 0;
          let targetClipId: string | undefined = undefined;
          let relativeStartTime = newGlobalStart;

          for (const clip of prev.clips) {
            const clipDur = clip.trimEnd - clip.trimStart;
            if (newGlobalStart >= accumulated && newGlobalStart < accumulated + clipDur) {
              targetClipId = clip.id;
              relativeStartTime = newGlobalStart - accumulated;
              break;
            }
            accumulated += clipDur;
          }

          if (!targetClipId && prev.clips.length > 0) {
            const lastClip = prev.clips[prev.clips.length - 1];
            let lastClipGlobalStart = 0;
            for (const c of prev.clips) {
              if (c.id === lastClip.id) break;
              lastClipGlobalStart += (c.trimEnd - c.trimStart);
            }
            targetClipId = lastClip.id;
            relativeStartTime = newGlobalStart - lastClipGlobalStart;
          }

          return {
            ...prev,
            voiceovers: prev.voiceovers.map(v => v.id === vId ? { ...v, clipId: targetClipId, relativeStartTime } : v)
          };
        }

        // 4. Voiceover trim start / end
        if (draggingState.kind === 'voiceover-trim-start') {
          const vId = draggingState.id;
          const initialStart = draggingState.initialGlobalStart ?? 0;
          const initialDur = draggingState.initialDuration ?? 4;

          const newGlobalStart = Math.max(0, Math.min(initialStart + deltaSeconds, initialStart + initialDur - 0.2));
          const newDur = Math.max(0.2, initialDur - (newGlobalStart - initialStart));

          let accumulated = 0;
          let targetClipId: string | undefined = undefined;
          let relativeStartTime = newGlobalStart;

          for (const clip of prev.clips) {
            const clipDur = clip.trimEnd - clip.trimStart;
            if (newGlobalStart >= accumulated && newGlobalStart < accumulated + clipDur) {
              targetClipId = clip.id;
              relativeStartTime = newGlobalStart - accumulated;
              break;
            }
            accumulated += clipDur;
          }

          if (!targetClipId && prev.clips.length > 0) {
            const lastClip = prev.clips[prev.clips.length - 1];
            let lastClipGlobalStart = 0;
            for (const c of prev.clips) {
              if (c.id === lastClip.id) break;
              lastClipGlobalStart += (c.trimEnd - c.trimStart);
            }
            targetClipId = lastClip.id;
            relativeStartTime = newGlobalStart - lastClipGlobalStart;
          }

          return {
            ...prev,
            voiceovers: prev.voiceovers.map(v => v.id === vId ? { ...v, clipId: targetClipId, relativeStartTime, duration: newDur } : v)
          };
        }

        if (draggingState.kind === 'voiceover-trim-end') {
          const initialDur = draggingState.initialDuration ?? 4;
          const newDur = Math.max(0.2, initialDur + deltaSeconds);

          return {
            ...prev,
            voiceovers: prev.voiceovers.map(v => v.id === draggingState.id ? { ...v, duration: newDur } : v)
          };
        }

        // 5. Subtitle move & trim
        if (draggingState.kind === 'subtitle-move') {
          const dur = (draggingState.initialEnd ?? 3) - (draggingState.initialStart ?? 0);
          const newStart = Math.max(0, (draggingState.initialStart ?? 0) + deltaSeconds);
          return {
            ...prev,
            subtitles: prev.subtitles.map(s => s.id === draggingState.id ? { ...s, start: newStart, end: newStart + dur } : s)
          };
        }

        if (draggingState.kind === 'subtitle-trim-start') {
          const initialStart = draggingState.initialStart ?? 0;
          const initialEnd = draggingState.initialEnd ?? 3;
          const newStart = Math.max(0, Math.min(initialStart + deltaSeconds, initialEnd - 0.2));
          return {
            ...prev,
            subtitles: prev.subtitles.map(s => s.id === draggingState.id ? { ...s, start: newStart } : s)
          };
        }

        if (draggingState.kind === 'subtitle-trim-end') {
          const initialStart = draggingState.initialStart ?? 0;
          const initialEnd = draggingState.initialEnd ?? 3;
          const newEnd = Math.max(initialStart + 0.2, initialEnd + deltaSeconds);
          return {
            ...prev,
            subtitles: prev.subtitles.map(s => s.id === draggingState.id ? { ...s, end: newEnd } : s)
          };
        }

        return prev;
      });
    };

    const handleMouseUp = () => {
      setDraggingState(null);
    };

    if (draggingState) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingState, zoom]);

  // Timeline Mouse Wheel / Trackpad Zooming
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.2 : 0.833;
        setZoom(prev => Math.min(1000, Math.max(1, Math.round(prev * zoomFactor))));
      }
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const handleFitToScreen = () => {
    if (timelineRef.current && totalDuration > 0) {
      const containerWidth = timelineRef.current.clientWidth || 800;
      // Calculate zoom so entire recording plus small buffer fits horizontally
      const calculatedZoom = Math.max(1, Math.floor((containerWidth - 60) / (totalDuration + 2)));
      setZoom(calculatedZoom);
    } else {
      setZoom(10);
    }
  };


  // Voiceover: Upload
  const handleAudioUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      addVoiceover(url, 'recorded', file.name, file);
    }
  };

  // Voiceover: AI
  const handleGenerateAIVoice = async () => {
    if (!aiText.trim()) return;
    setIsGeneratingAi(true);
    try {
      const audioUrl = await generateAIVoice(aiText, aiVoice);
      addVoiceover(audioUrl, 'ai', aiText);
      setAiText('');
    } catch (err) {
      console.error("AI Voice error:", err);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  // Watermark: Upload
  const handleWatermarkUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setVideoState(prev => ({
          ...prev,
          watermarkUrl: reader.result as string
        }));
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Offline export via ffmpeg.wasm, decoupled from wall-clock/playback
  // speed. Each clip is trimmed once (stream-copy when the source already
  // matches the export resolution — a fast remux, not a re-encode) and
  // concatenated; subtitles/watermark are pre-rendered ONCE each as
  // transparent PNGs (their content doesn't change while on screen) and
  // burned in via ffmpeg's own `overlay` filter, time-gated per subtitle.
  // No per-frame canvas rendering, no discrete video seeking.
  const handleExport = async () => {
    if (videoState.clips.length === 0) return;

    console.log("Starting export process (ffmpeg.wasm)...");
    setIsExporting(true);
    setExportProgress(0);
    setIsPlaying(false);
    if (videoRef.current) videoRef.current.pause();

    const FPS = 30;
    const MAX_DIM = 1280;
    let w = videoRef.current?.videoWidth || 1280;
    let h = videoRef.current?.videoHeight || 720;
    if (w > MAX_DIM || h > MAX_DIM) {
      const ratio = w / h;
      if (w > h) { w = MAX_DIM; h = Math.round(MAX_DIM / ratio); }
      else { h = MAX_DIM; w = Math.round(MAX_DIM * ratio); }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setIsExporting(false); return; }
    console.log(`Export canvas initialized: ${canvas.width}x${canvas.height}`);

    try {
      await loadFFmpeg((p) => setExportProgress(p.percent * 0.05)); // 0-5%

      let watermarkImg: HTMLImageElement | null = null;
      if (videoState.watermarkUrl) {
        watermarkImg = new Image();
        watermarkImg.src = videoState.watermarkUrl;
        await new Promise((resolve) => {
          if (!watermarkImg) { resolve(null); return; }
          watermarkImg.onload = resolve;
          watermarkImg.onerror = resolve;
        });
      }

      // One-time probe of a clip's native resolution, to decide whether a
      // pure stream-copy (no re-encode) is safe: it only works when the
      // source is already exactly at the export's target dimensions.
      const getVideoDimensions = (url: string) => new Promise<{ width: number; height: number } | null>((resolve) => {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => resolve({ width: probe.videoWidth, height: probe.videoHeight });
        probe.onerror = () => resolve(null);
        probe.src = url;
        setTimeout(() => resolve(null), 5000);
      });

      // Draw one subtitle's box+text onto the (already-cleared, transparent)
      // canvas. Reused both to pre-render each subtitle's overlay PNG.
      const drawSubtitleOnly = (sub: Subtitle) => {
        const relFontSize = (sub.fontSize || 24) * (canvas.height / 500);
        const weight = sub.fontWeight === 'extrabold' ? '800' : sub.fontWeight === 'bold' ? 'bold' : 'normal';
        const style = sub.fontStyle === 'italic' ? 'italic' : 'normal';
        ctx.font = `${style} ${weight} ${relFontSize}px Inter, sans-serif`;

        const metrics = ctx.measureText(sub.text || '');
        const padding = relFontSize * 0.5;
        const rectWidth = metrics.width + padding * 2;
        const rectHeight = relFontSize * 1.4;

        let posY = canvas.height * 0.85;
        if (sub.positionY === 'top') posY = canvas.height * 0.15;
        else if (sub.positionY === 'center') posY = canvas.height * 0.5;

        let posX = canvas.width / 2;
        const align: CanvasTextAlign = 'center';
        if (sub.positionX === 'left') posX = canvas.width * 0.08 + rectWidth / 2;
        else if (sub.positionX === 'right') posX = canvas.width * 0.92 - rectWidth / 2;

        const bg = sub.backgroundColor || 'rgba(0, 0, 0, 0.75)';
        if (bg !== 'transparent') {
          ctx.fillStyle = bg;
          ctx.fillRect(posX - rectWidth / 2, posY - rectHeight / 2, rectWidth, rectHeight);
        }

        if (sub.hasShadow !== false) {
          ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
          ctx.shadowBlur = 8;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
        } else {
          ctx.shadowColor = 'transparent';
        }

        ctx.fillStyle = sub.color || '#ffffff';
        ctx.textAlign = align;
        ctx.textBaseline = 'middle';
        ctx.fillText(sub.text || '', posX, posY);
        ctx.shadowColor = 'transparent';
      };

      const drawWatermarkOnly = () => {
        if (!watermarkImg) return;
        const padding = canvas.width * 0.03;
        const sizePercentage = (videoState.watermarkSize || 15) / 100;
        const size = canvas.width * sizePercentage;
        const aspect = watermarkImg.width / watermarkImg.height;
        let drawW = size;
        let drawH = size / aspect;
        if (drawH > size) { drawH = size; drawW = size * aspect; }

        const pos = videoState.watermarkPosition || 'top-right';
        let drawX = canvas.width - drawW - padding;
        let drawY = padding;
        if (pos === 'top-left') { drawX = padding; drawY = padding; }
        else if (pos === 'top-center') { drawX = (canvas.width - drawW) / 2; drawY = padding; }
        else if (pos === 'bottom-left') { drawX = padding; drawY = canvas.height - drawH - padding; }
        else if (pos === 'bottom-center') { drawX = (canvas.width - drawW) / 2; drawY = canvas.height - drawH - padding; }
        else if (pos === 'bottom-right') { drawX = canvas.width - drawW - padding; drawY = canvas.height - drawH - padding; }
        else if (pos === 'center') { drawX = (canvas.width - drawW) / 2; drawY = (canvas.height - drawH) / 2; }

        ctx.globalAlpha = (videoState.watermarkOpacity ?? 80) / 100;
        ctx.drawImage(watermarkImg, drawX, drawY, drawW, drawH);
        ctx.globalAlpha = 1.0;
      };

      // Pre-render the watermark overlay once (position/size/opacity never
      // change) — reused across every segment that needs it.
      let watermarkOverlayName: string | null = null;
      if (watermarkImg) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        drawWatermarkOnly();
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
        watermarkOverlayName = 'watermark_overlay.png';
        await writeFrame(watermarkOverlayName, blob);
      }

      // Split each clip into sub-segments at subtitle AND watermark boundaries.
      // Like subtitles, the watermark now has its own [start,end] window
      // (default: the whole video, for backward compatibility with existing
      // projects) instead of being unconditionally global — so a logo that
      // only covers the first/last few seconds no longer forces a full
      // re-encode of the entire timeline. A segment with nothing active in
      // it stays a pure trim — stream-copied when the source already matches
      // export resolution, so it costs seconds, not minutes. Only segments
      // that actually need something drawn on top pay for a re-encode, and
      // that re-encode is scoped to JUST that segment's own duration via
      // ffmpeg's overlay filter — not the whole timeline.
      const watermarkActive = !!videoState.watermarkUrl;
      const watermarkStart = videoState.watermarkStart ?? 0;
      const watermarkEnd = videoState.watermarkEnd ?? totalDuration;
      type Segment = { clip: VideoClip; localStart: number; durationSec: number; needsOverlay: boolean };
      const segments: Segment[] = [];
      for (const clip of videoState.clips) {
        const clipGlobalStart = getClipGlobalStart(clip.id);
        const clipDur = clip.trimEnd - clip.trimStart;
        if (!isFinite(clipDur) || clipDur <= 0) continue;

        const boundaries = new Set<number>([0, clipDur]);
        if (showSubtitles) {
          for (const sub of videoState.subtitles) {
            const relStart = sub.start - clipGlobalStart;
            const relEnd = sub.end - clipGlobalStart;
            if (relEnd <= 0 || relStart >= clipDur) continue;
            boundaries.add(Math.max(0, relStart));
            boundaries.add(Math.min(clipDur, relEnd));
          }
        }
        if (watermarkActive) {
          const relStart = watermarkStart - clipGlobalStart;
          const relEnd = watermarkEnd - clipGlobalStart;
          if (!(relEnd <= 0 || relStart >= clipDur)) {
            boundaries.add(Math.max(0, relStart));
            boundaries.add(Math.min(clipDur, relEnd));
          }
        }
        const sorted = Array.from(boundaries).sort((a, b) => a - b);
        for (let i = 0; i < sorted.length - 1; i++) {
          const segStart = sorted[i];
          const segEnd = sorted[i + 1];
          const segDur = segEnd - segStart;
          if (segDur < 0.02) continue;
          const midGlobal = clipGlobalStart + (segStart + segEnd) / 2;
          const watermarkHere = watermarkActive && midGlobal >= watermarkStart && midGlobal <= watermarkEnd;
          const needsOverlay = watermarkHere || (showSubtitles && videoState.subtitles.some(s => midGlobal >= s.start && midGlobal <= s.end));
          segments.push({ clip, localStart: segStart, durationSec: segDur, needsOverlay });
        }
      }
      console.log(`Timeline split into ${segments.length} segment(s): ${segments.filter(s => !s.needsOverlay).length} passthrough, ${segments.filter(s => s.needsOverlay).length} need overlay.`);

      const writtenClipSources = new Set<string>();
      const segmentOutputs: string[] = [];
      const totalSegDuration = segments.reduce((acc, s) => acc + s.durationSec, 0) || 1;
      let cumulativeDuration = 0;

      for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const seg = segments[segIdx];
        const clipGlobalStart = getClipGlobalStart(seg.clip.id);
        const sourceStart = seg.clip.trimStart + seg.localStart;
        const segStartProgress = 5 + Math.round((cumulativeDuration / totalSegDuration) * 60);
        const segEndProgress = 5 + Math.round(((cumulativeDuration + seg.durationSec) / totalSegDuration) * 60);
        const onSegProgress = (ratio: number) => {
          const clamped = Math.max(0, Math.min(1, ratio));
          setExportProgress(segStartProgress + Math.round((segEndProgress - segStartProgress) * clamped));
        };

        const srcName = `clip_src_${seg.clip.id}`;
        if (!writtenClipSources.has(srcName)) {
          await writeAudioInput(srcName, seg.clip.file || seg.clip.url);
          writtenClipSources.add(srcName);
        }

        const trimmedName = `trim_${segIdx}.mp4`;
        if (seg.clip.type === 'video') {
          const dims = await getVideoDimensions(seg.clip.url);
          const canStreamCopy = !!dims && dims.width === canvas.width && dims.height === canvas.height;
          console.log(`Segment ${segIdx + 1}/${segments.length}: ${seg.needsOverlay ? 'overlay' : 'passthrough'}, ${seg.durationSec.toFixed(1)}s, ${canStreamCopy ? 'stream-copy' : 're-encode'} trim`);
          await encodePassthroughVideoSegment(srcName, sourceStart, seg.durationSec, FPS, canvas.width, canvas.height, trimmedName, canStreamCopy, seg.needsOverlay ? undefined : onSegProgress);
        } else {
          await encodePassthroughImageSegment(srcName, seg.durationSec, FPS, canvas.width, canvas.height, trimmedName, seg.needsOverlay ? undefined : onSegProgress);
        }

        let outName = trimmedName;
        if (seg.needsOverlay) {
          const overlays: { name: string; enableExpr: string | null }[] = [];
          if (showSubtitles) {
            for (let i = 0; i < videoState.subtitles.length; i++) {
              const sub = videoState.subtitles[i];
              const segGlobalStart = clipGlobalStart + seg.localStart;
              const localSubStart = sub.start - segGlobalStart;
              const localSubEnd = sub.end - segGlobalStart;
              if (localSubEnd <= 0 || localSubStart >= seg.durationSec) continue; // not active in this segment

              ctx.clearRect(0, 0, canvas.width, canvas.height);
              drawSubtitleOnly(sub);
              const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
              const name = `subtitle_${segIdx}_${i}.png`;
              await writeFrame(name, blob);
              overlays.push({
                name,
                enableExpr: `between(t,${Math.max(0, localSubStart).toFixed(3)},${Math.min(seg.durationSec, localSubEnd).toFixed(3)})`,
              });
            }
          }
          if (watermarkOverlayName) {
            const segGlobalStart = clipGlobalStart + seg.localStart;
            const localWmStart = watermarkStart - segGlobalStart;
            const localWmEnd = watermarkEnd - segGlobalStart;
            if (localWmEnd > 0 && localWmStart < seg.durationSec) {
              // Gate with enable= too: this segment may be a superset of the
              // watermark's own window (e.g. it also contains a subtitle
              // that starts earlier), so the watermark shouldn't necessarily
              // cover the segment's full duration.
              const gatedStart = Math.max(0, localWmStart);
              const gatedEnd = Math.min(seg.durationSec, localWmEnd);
              const fullyCovers = gatedStart <= 0.001 && gatedEnd >= seg.durationSec - 0.001;
              overlays.push({
                name: watermarkOverlayName,
                enableExpr: fullyCovers ? null : `between(t,${gatedStart.toFixed(3)},${gatedEnd.toFixed(3)})`,
              });
            }
          }

          outName = `overlay_${segIdx}.mp4`;
          await encodeOverlayPass(trimmedName, overlays, outName, onSegProgress);
          await deleteFile(trimmedName);
          for (const o of overlays) {
            if (o.name !== watermarkOverlayName) await deleteFile(o.name);
          }
        }

        cumulativeDuration += seg.durationSec;
        segmentOutputs.push(outName);
        setExportProgress(segEndProgress);
      }

      if (watermarkOverlayName) await deleteFile(watermarkOverlayName);

      setExportProgress(65);
      console.log("Concatenating segments...");
      await concatSegments(segmentOutputs, 'video_concat.mp4');
      for (const name of segmentOutputs) {
        await deleteFile(name);
      }
      const videoForMux = 'video_concat.mp4';

      setExportProgress(70);
      console.log("Video ready. Preparing audio tracks...");

      // Audio: each non-muted clip's own soundtrack, trimmed to [trimStart,trimEnd]
      // and placed at its clip's global start; plus every voiceover track, offset
      // the same way the old real-time export computed it (extracted voiceovers
      // are recorded relative to their host clip's un-trimmed timeline).
      const audioInputs: AudioInput[] = [];
      let audioIdx = 0;

      for (const clip of videoState.clips) {
        if (clip.type !== 'video' || clip.muted) continue;
        const source = clip.file || clip.url;
        if (!source) continue;
        const durationSec = clip.trimEnd - clip.trimStart;
        if (!isFinite(durationSec) || durationSec <= 0) continue;
        const inputName = `clip_audio_${audioIdx}`;
        try {
          await writeAudioInput(inputName, source);
          // A silent source has no audio stream; mapping [n:a] to it fails the
          // whole mux, so skip the track instead.
          if (!(await hasAudioStream(inputName))) {
            await deleteFile(inputName);
            continue;
          }
          audioInputs.push({
            inputName,
            startSec: getClipGlobalStart(clip.id),
            durationSec,
            sourceStartSec: clip.trimStart,
            volume: 1,
          });
          audioIdx++;
        } catch (err) {
          console.warn(`Skipping audio for clip ${clip.id}:`, err);
        }
      }

      for (const v of videoState.voiceovers) {
        const vGlobalStart = getVoiceoverGlobalTime(v);
        if (vGlobalStart === -1) continue;

        let offset = 0;
        if (v.clipId && v.type === 'extracted') {
          const hostClip = videoState.clips.find(c => c.id === v.clipId);
          if (hostClip && isFinite(hostClip.trimStart)) offset = hostClip.trimStart;
        }

        const source = v.file || v.url;
        const inputName = `voiceover_audio_${audioIdx}`;
        try {
          await writeAudioInput(inputName, source);
          audioInputs.push({
            inputName,
            startSec: vGlobalStart,
            durationSec: v.duration || 10,
            sourceStartSec: offset,
            volume: 1,
          });
          audioIdx++;
        } catch (err) {
          console.warn(`Skipping voiceover audio ${v.id}:`, err);
        }
      }

      setExportProgress(72);
      console.log(`Encoding with ${audioInputs.length} audio track(s)...`);

      const cmd = buildFfmpegCommand(videoForMux, totalDuration, audioInputs);
      await runEncode(cmd, (ratio) => {
        const clamped = Math.max(0, Math.min(1, ratio));
        setExportProgress(72 + Math.round(clamped * 23)); // 72-95%
      });

      setExportProgress(95);
      const blob = await readOutput();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vocalcut-export-${Date.now()}.mp4`;
      a.click();
      URL.revokeObjectURL(url);

      // Clean up virtual filesystem (per-segment temp files are already
      // deleted as each segment finishes)
      await deleteFile('video_concat.mp4');
      for (const srcName of writtenClipSources) {
        await deleteFile(srcName);
      }
      for (const input of audioInputs) {
        await deleteFile(input.inputName);
      }
      await deleteFile('output.mp4');

      setExportProgress(100);
      console.log("Export complete.");
    } catch (err) {
      console.error("Export failed:", err);
      setProjectMessage(err instanceof Error ? `Export failed: ${err.message}` : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  const addVoiceover = (url: string, type: 'recorded' | 'ai' | 'extracted', text?: string, file?: File | Blob) => {
    const clipInfo = getClipAtTime(currentTime);
    
    // Calculate relative start time (time within the current clip's duration)
    let relativeStartTime = 0;
    if (clipInfo) {
      let clipGlobalStart = 0;
      for (const c of videoState.clips) {
        if (c.id === clipInfo.clip.id) break;
        clipGlobalStart += (c.trimEnd - c.trimStart);
      }
      relativeStartTime = currentTime - clipGlobalStart;
    }

    const newVoiceoverId = Math.random().toString(36).substr(2, 9);
    const displayName = text || (file && (file as File).name ? (file as File).name : 'Audio Track');

    const newVoiceover: Voiceover = {
      id: newVoiceoverId,
      url,
      file,
      clipId: clipInfo?.clip.id,
      relativeStartTime,
      type,
      text: displayName,
      duration: 5
    };

    // Asynchronously detect audio duration
    const audioEl = new Audio(url);
    audioEl.onloadedmetadata = () => {
      if (audioEl.duration && isFinite(audioEl.duration)) {
        setVideoState(prev => ({
          ...prev,
          voiceovers: prev.voiceovers.map(v => v.id === newVoiceoverId ? { ...v, duration: audioEl.duration } : v)
        }));
      }
    };

    setVideoState(prev => ({
      ...prev,
      voiceovers: [...prev.voiceovers, newVoiceover]
    }));
  };

  // Subtitles & Text Layers
  const addSubtitle = (preset?: 'heading' | 'lowerThird' | 'caption' | 'subtitle') => {
    let fontSize = 24;
    let color = '#ffffff';
    let backgroundColor = 'rgba(0, 0, 0, 0.75)';
    let positionY: 'top' | 'center' | 'bottom' = 'bottom';
    let positionX: 'left' | 'center' | 'right' = 'center';
    let text = 'New Text Layer';

    if (preset === 'heading') {
      text = 'HEADING TITLE';
      fontSize = 34;
      positionY = 'center';
      positionX = 'center';
      backgroundColor = 'transparent';
    } else if (preset === 'lowerThird') {
      text = 'Speaker Name • Title';
      fontSize = 18;
      positionY = 'bottom';
      positionX = 'left';
      backgroundColor = '#3b82f6';
    } else if (preset === 'caption') {
      text = 'Add caption text here...';
      fontSize = 22;
      positionY = 'bottom';
      positionX = 'center';
      backgroundColor = 'rgba(0, 0, 0, 0.85)';
    }

    const endBoundary = totalDuration > 0 ? totalDuration : currentTime + 3;
    const newSub: Subtitle = {
      id: Math.random().toString(36).substr(2, 9),
      text,
      start: currentTime,
      end: Math.min(currentTime + 3, endBoundary > currentTime ? endBoundary : currentTime + 3),
      fontSize,
      color,
      backgroundColor,
      positionY,
      positionX,
      fontWeight: preset === 'heading' ? 'extrabold' : 'bold',
      fontStyle: 'normal',
      hasShadow: true,
    };
    setVideoState(prev => ({
      ...prev,
      subtitles: [...prev.subtitles, newSub]
    }));
    setSelectedSubtitleId(newSub.id);
  };

  const duplicateSubtitle = (sub: Subtitle) => {
    const dur = Math.max(1, sub.end - sub.start);
    const newSub: Subtitle = {
      ...sub,
      id: Math.random().toString(36).substr(2, 9),
      start: sub.end,
      end: sub.end + dur
    };
    setVideoState(prev => ({
      ...prev,
      subtitles: [...prev.subtitles, newSub]
    }));
    setSelectedSubtitleId(newSub.id);
  };

  const updateSubtitle = (id: string, updates: Partial<Subtitle>) => {
    setVideoState(prev => ({
      ...prev,
      subtitles: prev.subtitles.map(s => s.id === id ? { ...s, ...updates } : s)
    }));
  };

  const removeSubtitle = (id: string) => {
    setVideoState(prev => ({
      ...prev,
      subtitles: prev.subtitles.filter(s => s.id !== id)
    }));
    if (selectedSubtitleId === id) {
      setSelectedSubtitleId(null);
    }
  };

  const removeVoiceover = (id: string) => {
    setVideoState(prev => ({
      ...prev,
      voiceovers: prev.voiceovers.filter(v => v.id !== id)
    }));
  };

  // Project Export & Import File Handlers
  const fileToDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleSaveProjectFile = async () => {
    try {
      setIsSavingProject(true);
      setProjectMessage('Packaging project file...');

      const serializedClips = await Promise.all(
        videoState.clips.map(async (clip) => {
          let fileDataUrl: string | undefined = undefined;
          if (clip.file) {
            try {
              fileDataUrl = await fileToDataUrl(clip.file);
            } catch (e) {
              console.warn('Could not encode clip file:', clip.id, e);
            }
          }
          return {
            ...clip,
            fileDataUrl,
            file: undefined
          };
        })
      );

      const serializedVoiceovers = await Promise.all(
        videoState.voiceovers.map(async (v) => {
          let fileDataUrl: string | undefined = undefined;
          if (v.file) {
            try {
              fileDataUrl = await fileToDataUrl(v.file);
            } catch (e) {
              console.warn('Could not encode voiceover file:', v.id, e);
            }
          }
          return {
            ...v,
            fileDataUrl,
            file: undefined
          };
        })
      );

      const exportData = {
        version: '1.0',
        appName: 'VidoCut',
        exportedAt: new Date().toISOString(),
        videoState: {
          ...videoState,
          clips: serializedClips,
          voiceovers: serializedVoiceovers
        }
      };

      const jsonStr = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const dateStr = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vidocut-project-${dateStr}.vidocut`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setProjectMessage('Project file saved!');
      setTimeout(() => setProjectMessage(null), 3000);
    } catch (err) {
      console.error('Failed to save project file:', err);
      setProjectMessage('Error saving project');
      setTimeout(() => setProjectMessage(null), 3000);
    } finally {
      setIsSavingProject(false);
    }
  };

  const handleOpenProjectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setProjectMessage('Opening project file...');
      const text = await file.text();
      const parsed = JSON.parse(text);

      const stateData = parsed.videoState || parsed;
      if (!stateData || !Array.isArray(stateData.clips)) {
        throw new Error('Invalid VidoCut project file structure');
      }

      // Reconstruct Files and Blob URLs for clips
      const reconstructedClips = await Promise.all(
        (stateData.clips || []).map(async (clip: any) => {
          let fileObj: File | undefined = undefined;
          let url = clip.url;

          const dataUri = clip.fileDataUrl || (clip.url && clip.url.startsWith('data:') ? clip.url : null);
          if (dataUri) {
            try {
              const res = await fetch(dataUri);
              const blob = await res.blob();
              fileObj = new File([blob], clip.name || 'video_clip', { type: clip.fileType || blob.type || 'video/mp4' });
              url = URL.createObjectURL(fileObj);
            } catch (err) {
              console.warn('Could not reconstruct file for clip:', clip.id, err);
            }
          }

          return {
            ...clip,
            file: fileObj,
            url
          };
        })
      );

      // Reconstruct Files and Blob URLs for voiceovers
      const reconstructedVoiceovers = await Promise.all(
        (stateData.voiceovers || []).map(async (v: any) => {
          let fileObj: File | undefined = undefined;
          let url = v.url;

          const dataUri = v.fileDataUrl || (v.url && v.url.startsWith('data:') ? v.url : null);
          if (dataUri) {
            try {
              const res = await fetch(dataUri);
              const blob = await res.blob();
              fileObj = new File([blob], 'voiceover.wav', { type: 'audio/wav' });
              url = URL.createObjectURL(fileObj);
            } catch (err) {
              console.warn('Could not reconstruct voiceover audio:', v.id, err);
            }
          }

          return {
            ...v,
            file: fileObj,
            url
          };
        })
      );

      const newVideoState: VideoState = {
        ...stateData,
        clips: reconstructedClips,
        voiceovers: reconstructedVoiceovers
      };

      setVideoState(newVideoState);
      if (reconstructedClips.length > 0) {
        setSelectedClipId(reconstructedClips[0].id);
      }
      setProjectMessage('Project loaded successfully!');
      setTimeout(() => setProjectMessage(null), 3000);
    } catch (err) {
      console.error('Failed to open project file:', err);
      alert('Failed to open project file. Make sure it is a valid .vidocut or .json project file.');
      setProjectMessage(null);
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  // Active subtitles for display
  const activeSubtitles = videoState.subtitles.filter(
    s => currentTime >= s.start && currentTime <= s.end
  );

  // Play and synchronize voiceovers/audio tracks precisely
  useEffect(() => {
    const currentMap = voiceoverAudioMapRef.current;
    const currentVoIds = new Set(videoState.voiceovers.map(v => v.id));

    // Cleanup deleted voiceovers
    currentMap.forEach((audio, id) => {
      if (!currentVoIds.has(id)) {
        try {
          audio.pause();
          audio.src = '';
        } catch (e) {}
        currentMap.delete(id);
      }
    });

    // Register new voiceovers
    videoState.voiceovers.forEach(v => {
      if (!currentMap.has(v.id)) {
        const audio = new Audio(v.url);
        currentMap.set(v.id, audio);
      }
    });

    if (!isPlaying) {
      currentMap.forEach(audio => {
        try {
          if (!audio.paused) audio.pause();
        } catch (e) {}
      });
      return;
    }

    videoState.voiceovers.forEach(v => {
      const vGlobalStart = getVoiceoverGlobalTime(v);
      if (vGlobalStart === -1) return;

      const audio = currentMap.get(v.id);
      if (!audio) return;

      const vDuration = v.duration || 5;

      if (currentTime >= vGlobalStart && currentTime < vGlobalStart + vDuration) {
        let offset = currentTime - vGlobalStart;
        if (v.clipId && v.type === 'extracted') {
          const clip = videoState.clips.find(c => c.id === v.clipId);
          if (clip && isFinite(clip.trimStart)) {
            offset += clip.trimStart;
          }
        }

        if (audio.paused) {
          audio.currentTime = Math.max(0, offset);
          audio.play().catch(() => {});
        } else if (Math.abs(audio.currentTime - offset) > 0.3) {
          audio.currentTime = Math.max(0, offset);
        }
      } else {
        if (!audio.paused) {
          audio.pause();
        }
      }
    });
  }, [currentTime, isPlaying, videoState.voiceovers, videoState.clips]);

  // Keyboard shortcut listener (Space = Toggle Play/Pause, Escape = Stop)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        handleStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, currentTime, totalDuration, selectedClip, videoState.clips]);

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg">
        <div className="w-12 h-12 border-4 border-accent/20 border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-screen max-h-screen flex flex-col bg-bg overflow-hidden select-none">
      {/* Header */}
      <header className="h-14 md:h-16 border-b border-border flex items-center justify-between px-3 md:px-6 glass z-10 relative">
        <div className="flex items-center gap-2 md:gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center bg-white/5 border border-white/10 shrink-0">
            <img 
              src="https://favicons.vegvisr.org/favicons/1782026007878-1-1782026040233-180x180.png" 
              alt="VidoCut" 
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
            />
          </div>
          <span className="font-bold text-lg tracking-tight">VidoCut</span>
          <span className="px-2 py-0.5 rounded-full bg-green-500/20 border border-green-500/40 text-green-400 text-[10px] font-mono font-semibold tracking-tight">
            {__APP_VERSION__}
          </span>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          {projectMessage && (
            <div className="hidden md:flex px-3 py-1 bg-accent/20 border border-accent/40 rounded-full text-xs font-semibold text-accent animate-pulse items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5" />
              <span>{projectMessage}</span>
            </div>
          )}

          {isExporting && (
            <div className="hidden md:flex flex-col items-end gap-1">
              <div className="flex items-center gap-3 px-4 py-1.5 bg-white/5 rounded-full border border-white/10">
                <span className="text-[9px] font-bold text-accent/60 uppercase tracking-widest">Recording</span>
                <div className="w-20 h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-accent transition-all duration-300"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-accent font-bold">{Math.round(exportProgress)}%</span>
              </div>
              <span className="text-[9px] text-slate-500 font-medium animate-pulse">Keep tab active for faster export</span>
            </div>
          )}

          {/* Project File Actions */}
          <button
            onClick={() => projectFileInputRef.current?.click()}
            className="hidden md:flex px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs font-semibold text-slate-300 hover:text-white items-center gap-1.5 transition-all"
            title="Open a saved .vidocut project file"
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
            <span>Open Project</span>
          </button>

          <button
            onClick={handleSaveProjectFile}
            disabled={isSavingProject}
            className="hidden md:flex px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-full text-xs font-semibold text-slate-300 hover:text-white items-center gap-1.5 transition-all disabled:opacity-50"
            title="Save project state to a .vidocut file on your computer"
          >
            <FolderDown className="w-3.5 h-3.5 text-accent" />
            <span>{isSavingProject ? 'Saving...' : 'Save Project'}</span>
          </button>

          <button 
            onClick={() => window.location.reload()}
            className="hidden md:block p-2 hover:bg-white/10 rounded-full transition-colors text-slate-400 hover:text-white"
            title="Reset Workspace"
          >
            <X className="w-4 h-4" />
          </button>
          
          <button 
            onClick={handleExport}
            disabled={isExporting}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-white px-4 h-11 md:h-auto md:py-2 rounded-full flex items-center gap-2 text-sm font-medium transition-all shadow-md shadow-accent/20"
          >
            {isExporting ? (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            <span className="md:hidden">{isExporting ? `${Math.round(exportProgress)}%` : 'Export'}</span>
            <span className="hidden md:inline">{isExporting ? 'Exporting...' : 'Export Video'}</span>
          </button>

          {/* Phone-only overflow menu: the actions hidden from the header above */}
          <div className="md:hidden">
            <button
              onClick={() => setMobileMenuOpen(o => !o)}
              aria-label="More actions"
              aria-expanded={mobileMenuOpen}
              className="w-11 h-11 rounded-xl flex items-center justify-center text-slate-300 hover:bg-white/10"
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>
            {mobileMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMobileMenuOpen(false)} />
                <div className="absolute right-3 top-14 z-50 w-56 rounded-2xl border border-border bg-bg shadow-2xl p-1.5 flex flex-col">
                  <button
                    onClick={() => { setMobileMenuOpen(false); projectFileInputRef.current?.click(); }}
                    className="h-12 px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-slate-200 hover:bg-white/10"
                  >
                    <FolderOpen className="w-4 h-4 text-amber-400" /> Open Project
                  </button>
                  <button
                    onClick={() => { setMobileMenuOpen(false); handleSaveProjectFile(); }}
                    disabled={isSavingProject}
                    className="h-12 px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50"
                  >
                    <FolderDown className="w-4 h-4 text-accent" /> {isSavingProject ? 'Saving...' : 'Save Project'}
                  </button>
                  <button
                    onClick={() => window.location.reload()}
                    className="h-12 px-3 rounded-xl flex items-center gap-3 text-sm font-medium text-red-300 hover:bg-white/10"
                  >
                    <X className="w-4 h-4" /> Reset Workspace
                  </button>
                </div>
              </>
            )}
          </div>

          <input 
            type="file" 
            ref={projectFileInputRef} 
            accept=".vidocut,.json" 
            onChange={handleOpenProjectFile} 
            className="hidden" 
          />
        </div>
      </header>

      {/* Hidden file uploader for adding extra tracks */}
      <input 
        type="file" 
        ref={addTrackFileInputRef}
        accept="video/*,image/*,audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.flac,audio/wav,audio/x-wav" 
        multiple 
        onChange={handleFileUpload} 
        className="hidden" 
      />

      <main className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Left Sidebar: Tools */}
        <aside className="order-last md:order-first w-full md:w-16 h-[72px] md:h-auto shrink-0 border-t md:border-t-0 md:border-r border-border flex flex-row md:flex-col items-center justify-around md:justify-start py-1 md:py-6 gap-0 md:gap-6 glass pb-[env(safe-area-inset-bottom)] relative z-[35]" role="tablist">
          <ToolButton 
            active={activeTab === 'trim'} 
            onClick={() => { setMobileSheetOpen(activeTab === 'trim' ? !mobileSheetOpen : true); setActiveTab('trim'); }}
            icon={<Scissors className="w-5 h-5" />}
            label="Trim"
          />
          <ToolButton 
            active={activeTab === 'voice'} 
            onClick={() => { setMobileSheetOpen(activeTab === 'voice' ? !mobileSheetOpen : true); setActiveTab('voice'); }}
            icon={<Mic className="w-5 h-5" />}
            label="Voice"
          />
          <ToolButton 
            active={activeTab === 'subtitles'} 
            onClick={() => { setMobileSheetOpen(activeTab === 'subtitles' ? !mobileSheetOpen : true); setActiveTab('subtitles'); }}
            icon={<Type className="w-5 h-5" />}
            label="Text"
          />
          <ToolButton 
            active={activeTab === 'watermark'} 
            onClick={() => { setMobileSheetOpen(activeTab === 'watermark' ? !mobileSheetOpen : true); setActiveTab('watermark'); }}
            icon={<ImageIcon className="w-5 h-5" />}
            label="Logo"
          />
        </aside>

        {/* Center: Preview & Timeline */}
        <section 
          className="flex-1 flex flex-col relative bg-black/40 min-h-0 overflow-hidden"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Drag Overlay */}
          <AnimatePresence>
            {isDraggingFile && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-50 bg-accent/20 backdrop-blur-md border-2 border-dashed border-accent flex flex-col items-center justify-center pointer-events-none"
              >
                <Upload className="w-16 h-16 text-accent mb-4 animate-bounce" />
                <p className="text-xl font-bold text-white">Drop WAV, Audio, Video, or Images Here</p>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex-1 min-h-0 flex items-center justify-center p-4 md:p-6 relative">
            {videoState.clips.length > 0 ? (
              <div className="relative max-w-full max-h-full aspect-video bg-black rounded-2xl overflow-hidden shadow-2xl border border-white/5 flex items-center justify-center">
                {selectedClip?.type === 'video' ? (
                  <video 
                    key={selectedClip.id}
                    ref={videoRef}
                    src={selectedClip.url}
                    muted={selectedClip.muted}
                    onLoadedMetadata={() => onLoadedMetadata(selectedClip.id)}
                    onTimeUpdate={handleTimeUpdate}
                    onEnded={handleVideoEnded}
                    className="max-h-full max-w-full object-contain"
                    onClick={togglePlay}
                  />
                ) : selectedClip?.type === 'image' ? (
                  <img 
                    key={selectedClip.id}
                    src={selectedClip.url}
                    className="max-h-full max-w-full object-contain cursor-pointer"
                    onClick={togglePlay}
                    referrerPolicy="no-referrer"
                  />
                ) : null}
              
              {/* Text Layer Overlay */}
              <AnimatePresence>
                {showSubtitles && activeSubtitles.map(sub => {
                  const isSelected = selectedSubtitleId === sub.id;

                  // Y position
                  let posYClass = "bottom-10";
                  if (sub.positionY === 'top') posYClass = "top-10";
                  else if (sub.positionY === 'center') posYClass = "top-1/2 -translate-y-1/2";

                  // X position
                  let posXClass = "left-0 right-0 justify-center";
                  if (sub.positionX === 'left') posXClass = "left-8 justify-start";
                  else if (sub.positionX === 'right') posXClass = "right-8 justify-end";

                  const bg = sub.backgroundColor || 'rgba(0, 0, 0, 0.75)';
                  const color = sub.color || '#ffffff';
                  const fontSize = sub.fontSize || 24;
                  const weight = sub.fontWeight === 'extrabold' ? 'font-black' : sub.fontWeight === 'bold' ? 'font-bold' : 'font-normal';
                  const style = sub.fontStyle === 'italic' ? 'italic' : '';

                  return (
                    <motion.div
                      key={sub.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      className={cn("absolute px-6 flex items-center z-20 pointer-events-auto cursor-pointer select-none", posYClass, posXClass)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedSubtitleId(sub.id);
                        setActiveTab('subtitles');
                      }}
                    >
                      <span 
                        className={cn(
                          "px-4 py-2 rounded-xl backdrop-blur-md transition-all border",
                          weight,
                          style,
                          isSelected ? "ring-2 ring-yellow-400 border-yellow-400 shadow-[0_0_20px_rgba(250,204,21,0.5)]" : "border-white/10 hover:border-white/30"
                        )}
                        style={{
                          fontSize: `${fontSize}px`,
                          color: color,
                          backgroundColor: bg,
                          textShadow: sub.hasShadow !== false ? '0 2px 8px rgba(0,0,0,0.8)' : 'none'
                        }}
                      >
                        {sub.text}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>

              {/* Watermark Overlay */}
              {videoState.watermarkUrl
                && currentTime >= (videoState.watermarkStart ?? 0)
                && currentTime <= (videoState.watermarkEnd ?? totalDuration)
                && (() => {
                const pos = videoState.watermarkPosition || 'top-right';
                let posClass = "top-4 right-4";
                if (pos === 'top-left') posClass = "top-4 left-4";
                else if (pos === 'top-center') posClass = "top-4 left-1/2 -translate-x-1/2";
                else if (pos === 'bottom-left') posClass = "bottom-4 left-4";
                else if (pos === 'bottom-center') posClass = "bottom-4 left-1/2 -translate-x-1/2";
                else if (pos === 'bottom-right') posClass = "bottom-4 right-4";
                else if (pos === 'center') posClass = "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2";

                const opacityVal = (videoState.watermarkOpacity ?? 80) / 100;

                return (
                  <div 
                    onClick={(e) => {
                      e.stopPropagation();
                      setActiveTab('watermark');
                    }}
                    className={cn("absolute cursor-pointer pointer-events-auto z-20 group transition-all", posClass)}
                    style={{ 
                      width: `${videoState.watermarkSize || 15}%`, 
                      height: 'auto', 
                      maxWidth: '40%',
                      opacity: opacityVal
                    }}
                    title="Click to edit watermark position & settings"
                  >
                    <img 
                      src={videoState.watermarkUrl} 
                      alt="Watermark" 
                      onError={() => {
                        console.warn("Watermark image failed to load, clearing URL.");
                        setVideoState(prev => ({ ...prev, watermarkUrl: undefined }));
                      }}
                      className="w-full h-full object-contain group-hover:scale-105 transition-transform"
                      referrerPolicy="no-referrer"
                    />
                    <div className="absolute -inset-1 border border-dashed border-accent/60 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
                  </div>
                );
              })()}

              {/* Muted Audio Indicator */}
              {selectedClip?.muted && (
                <div className="absolute top-4 left-4 bg-red-500/80 backdrop-blur-md text-white text-xs px-2.5 py-1 rounded-full flex items-center gap-1.5 border border-white/20 shadow-lg pointer-events-none z-10">
                  <VolumeX className="w-3.5 h-3.5" />
                  <span className="font-semibold text-[11px] tracking-wide">Audio Muted</span>
                </div>
              )}

              {/* Playback Overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                {!isPlaying && (
                  <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="w-20 h-20 bg-white/10 backdrop-blur-xl rounded-full flex items-center justify-center border border-white/20"
                  >
                    <Play className="w-10 h-10 text-white fill-white ml-1" />
                  </motion.div>
                )}
              </div>
            </div>
          ) : (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="max-w-md w-full glass p-12 rounded-3xl text-center space-y-8"
              >
                <div className="w-20 h-20 rounded-2xl overflow-hidden flex items-center justify-center mx-auto bg-white/5 border border-white/10 shadow-xl">
                  <img 
                    src="https://favicons.vegvisr.org/favicons/1782026007878-1-1782026040233-512x512.png" 
                    alt="VidoCut Logo" 
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
                <div className="space-y-2">
                  <h1 className="text-3xl font-bold tracking-tight">VidoCut</h1>
                  <p className="text-slate-400">Upload video, images, or WAV audio files to start editing.</p>
                </div>
                <label className="block">
                  <span className="sr-only">Choose media or WAV files</span>
                  <input 
                    type="file" 
                    accept="video/*,image/*,audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.flac,audio/wav,audio/x-wav" 
                    multiple
                    onChange={handleFileUpload}
                    className="block w-full text-sm text-slate-500
                      file:mr-4 file:py-3 file:px-6
                      file:rounded-full file:border-0
                      file:text-sm file:font-semibold
                      file:bg-accent file:text-white
                      hover:file:bg-accent-hover cursor-pointer"
                  />
                </label>
              </motion.div>
            )}
          </div>

          {/* Timeline and Composition Layers */}
          <div className="h-[340px] md:h-[280px] shrink-0 glass border-t border-border flex flex-col overflow-hidden">
            {/* Timeline Toolbar */}
            <div className="min-h-12 md:h-12 border-b border-border bg-black/30 flex flex-wrap md:flex-nowrap items-center justify-between gap-y-1 px-2 md:px-6 py-1 md:py-0 shrink-0 select-none">
              <div className="flex items-center gap-1 md:gap-4">
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={togglePlay}
                    className="w-11 h-11 md:w-8 md:h-8 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 transition-transform shadow"
                    title={isPlaying ? "Pause Playback (Space)" : "Play (Space)"}
                  >
                    {isPlaying ? <Pause className="w-4 h-4 fill-black" /> : <Play className="w-4 h-4 fill-black ml-0.5" />}
                  </button>

                  <button 
                    onClick={handleStop}
                    className="w-11 h-11 md:w-8 md:h-8 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 rounded-full flex items-center justify-center transition-all"
                    title="Stop Playback & Reset (Esc)"
                  >
                    <Square className="w-3.5 h-3.5 fill-red-400" />
                  </button>

                  <button 
                    onClick={() => {
                      pauseAllPlayback();
                      setCurrentTime(0);
                      if (videoState.clips.length > 0) {
                        const firstClip = videoState.clips[0];
                        setSelectedClipId(firstClip.id);
                        if (videoRef.current && isFinite(firstClip.trimStart)) {
                          videoRef.current.currentTime = firstClip.trimStart;
                        }
                      }
                    }}
                    className="w-11 h-11 md:w-8 md:h-8 bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 rounded-full flex items-center justify-center transition-all"
                    title="Rewind to Start"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button 
                  onClick={handleSplitClip}
                  disabled={!selectedClip}
                  className="h-11 md:h-8 px-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg flex items-center gap-1.5 text-xs font-semibold text-slate-200 transition-colors disabled:opacity-40 whitespace-nowrap"
                  title="Split selected clip at current playhead position"
                >
                  <Scissors className="w-3.5 h-3.5 text-accent" />
                  <span className="max-md:hidden">Split Clip</span><span className="md:hidden">Split</span>
                </button>
              </div>

              {/* Time displays & Zoom */}
              <div className="flex items-center gap-2 md:gap-3">
                <div className="text-xs font-mono bg-white/5 whitespace-nowrap border border-white/10 rounded-lg px-2.5 py-1 text-slate-300">
                  <span className="text-accent font-bold">{formatTime(currentTime)}</span>
                  <span className="text-slate-500 mx-1.5">/</span>
                  <span className="text-slate-400">{formatTime(totalDuration)}</span>
                </div>

                {/* Zoom controls */}
                <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg px-2 py-1">
                  <span className="text-[10px] font-bold text-slate-400 mr-1 hidden sm:inline">ZOOM</span>
                  <button 
                    onClick={() => setZoom(z => Math.max(1, Math.round(z / 1.3)))}
                    className="max-md:hidden p-0.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors"
                    title="Zoom Out (Ctrl + Scroll Down)"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <input 
                    type="range"
                    min="1"
                    max="1000"
                    step="1"
                    value={zoom}
                    onChange={(e) => setZoom(parseInt(e.target.value) || 1)}
                    className="max-md:hidden w-16 sm:w-24 h-1 bg-white/15 rounded-full appearance-none cursor-pointer accent-accent"
                    title="Timeline Zoom Level (1px/s to 1000px/s)"
                  />
                  <button 
                    onClick={() => setZoom(z => Math.min(1000, Math.round(z * 1.3)))}
                    className="max-md:hidden p-0.5 hover:bg-white/10 rounded text-slate-400 hover:text-white transition-colors"
                    title="Zoom In (Ctrl + Scroll Up)"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <span className="max-md:hidden text-[9px] font-mono text-slate-300 min-w-[38px] text-center px-1">
                    {zoom}px/s
                  </span>

                  <button
                    onClick={handleFitToScreen}
                    className="px-2 py-0.5 max-md:h-9 text-[9px] font-bold rounded transition-all bg-accent/20 text-accent hover:bg-accent/30 border border-accent/30 flex items-center gap-1 shadow-sm md:ml-1"
                    title="Fit Entire Video / Recording onto Screen"
                  >
                    <Maximize2 className="w-2.5 h-2.5" />
                    <span>FIT SCREEN</span>
                  </button>
                  
                  {/* Preset Zoom Levels */}
                  <div className="hidden lg:flex items-center gap-0.5 border-l border-white/10 pl-1.5 ml-0.5">
                    <button
                      onClick={() => setZoom(30)}
                      className={cn("px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors", zoom === 30 ? "bg-accent text-white font-bold" : "text-slate-400 hover:bg-white/10")}
                      title="1x Zoom (30px/s)"
                    >
                      1x
                    </button>
                    <button
                      onClick={() => setZoom(100)}
                      className={cn("px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors", zoom === 100 ? "bg-accent text-white font-bold" : "text-slate-400 hover:bg-white/10")}
                      title="3x Zoom (100px/s)"
                    >
                      3x
                    </button>
                    <button
                      onClick={() => setZoom(300)}
                      className={cn("px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors", zoom === 300 ? "bg-accent text-white font-bold" : "text-slate-400 hover:bg-white/10")}
                      title="10x Zoom (300px/s)"
                    >
                      10x
                    </button>
                    <button
                      onClick={() => setZoom(800)}
                      className={cn("px-1.5 py-0.5 text-[9px] font-mono rounded transition-colors", zoom === 800 ? "bg-accent text-white font-bold" : "text-slate-400 hover:bg-white/10")}
                      title="Ultra Zoom (800px/s)"
                    >
                      MAX
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Timeline Workspace (Multi-Track Grid scrollable vertically, with horizontal scrolling on the tracks pane) */}
            <div className="flex-1 flex overflow-y-auto select-none custom-scrollbar min-h-0">
              <div className="flex flex-1 min-w-0">
                {/* Left Column: Track Labels and Actions (fixed width) */}
                <div className="w-32 md:w-48 bg-black/40 border-r border-border flex flex-col select-none shrink-0">
                {/* Ruler Track spacer */}
                <div className="h-8 border-b border-white/10 flex items-center justify-between px-3 bg-white/[0.02] shrink-0">
                  <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold font-mono">Tracks</span>
                  <button 
                    onClick={() => addTrackFileInputRef.current?.click()}
                    className="p-1 hover:bg-white/10 text-accent rounded flex items-center gap-1 text-[10px] font-bold"
                    id="add-track-ruler"
                    title="Add Track (Upload Video/Image)"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>NEW</span>
                  </button>
                </div>

                {/* Subtitle / Text Lane Label */}
                <div className="h-12 border-b border-white/5 flex items-center px-3 justify-between bg-yellow-500/[0.01] shrink-0">
                  <div className="flex items-center gap-2">
                    <Type className="w-3.5 h-3.5 text-yellow-500/80" />
                    <span className="text-xs font-bold text-slate-300 whitespace-nowrap">Text <span className="max-md:hidden">Layers</span></span>
                  </div>
                  <button
                    onClick={() => addSubtitle()}
                    className="p-1 hover:bg-yellow-500/20 text-yellow-400 rounded transition-colors text-[9px] font-bold flex items-center gap-1"
                    title="Add Text Layer"
                  >
                    <Plus className="w-3 h-3" />
                    <span>ADD</span>
                  </button>
                </div>

                {/* Video / Image Clip Lanes */}
                {videoState.clips.map((clip, idx) => (
                  <div 
                    key={clip.id} 
                    className={cn(
                      "h-12 border-b border-white/5 flex items-center justify-between px-3 transition-colors shrink-0",
                      selectedClipId === clip.id ? "bg-accent/5" : "bg-black/10"
                    )}
                  >
                    <div 
                      className="flex-1 flex flex-col min-w-0 cursor-pointer"
                      onClick={() => setSelectedClipId(clip.id)}
                    >
                      <span className="text-xs font-bold text-slate-300 truncate">
                        {clip.type === 'image' ? 'Image' : 'Video'}-{idx + 1}
                      </span>
                      <span className="max-md:hidden text-[9px] font-mono text-slate-500">
                        {clip.type === 'image' ? 'still image' : `${clip.duration.toFixed(1)}s max`}
                      </span>
                    </div>

                    {/* Left Panel Actions */}
                    <div className="flex items-center gap-0.5">
                      {clip.type === 'video' && (
                        <>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleMuteClip(clip.id);
                            }}
                            className={cn(
                              "p-1 rounded transition-colors",
                              clip.muted ? "text-red-400 bg-red-500/20 hover:bg-red-500/30" : "text-slate-400 hover:text-white hover:bg-white/10"
                            )}
                            title={clip.muted ? "Unmute Clip Audio" : "Mute Clip Audio"}
                          >
                            {clip.muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
                          </button>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              handleExtractAudio(clip);
                            }}
                            className="p-1 text-amber-400 hover:text-amber-300 hover:bg-amber-500/20 rounded transition-colors"
                            title="Split Audio to Track"
                          >
                            <Music className="w-3 h-3" />
                          </button>
                        </>
                      )}
                      <button 
                        disabled={idx === 0}
                        onClick={() => {
                          const newClips = [...videoState.clips];
                          const temp = newClips[idx];
                          newClips[idx] = newClips[idx - 1];
                          newClips[idx - 1] = temp;
                          setVideoState(prev => ({ ...prev, clips: newClips }));
                        }}
                        className="p-1 hover:bg-white/10 text-slate-400 rounded disabled:opacity-30"
                        title="Move Clip Up"
                      >
                        <ChevronLeft className="w-3 h-3 rotate-90" />
                      </button>
                      <button 
                        disabled={idx === videoState.clips.length - 1}
                        onClick={() => {
                          const newClips = [...videoState.clips];
                          const temp = newClips[idx];
                          newClips[idx] = newClips[idx + 1];
                          newClips[idx + 1] = temp;
                          setVideoState(prev => ({ ...prev, clips: newClips }));
                        }}
                        className="p-1 hover:bg-white/10 text-slate-400 rounded disabled:opacity-30"
                        title="Move Clip Down"
                      >
                        <ChevronRight className="w-3 h-3 rotate-90" />
                      </button>
                      <button 
                        onClick={() => {
                          setVideoState(prev => ({
                            ...prev,
                            clips: prev.clips.filter(c => c.id !== clip.id)
                          }));
                          if (selectedClipId === clip.id) setSelectedClipId(null);
                        }}
                        className="p-1 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded transition-colors"
                        title="Delete Track"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}

                {/* Add Track Action Row */}
                <button
                  onClick={() => addTrackFileInputRef.current?.click()}
                  className="h-10 border-b border-white/5 flex items-center justify-center gap-2 px-3 text-xs font-semibold text-accent/80 hover:text-accent bg-accent/5 hover:bg-accent/10 transition-colors cursor-pointer shrink-0"
                  id="add-track-button"
                  title="Add Track (Upload Video/Image)"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Track</span>
                </button>

                {/* Voiceover Track Label */}
                <div className="h-12 border-b border-white/5 flex items-center px-3 justify-between bg-purple-500/[0.01] shrink-0">
                  <div className="flex items-center gap-2">
                    <Mic className="w-3.5 h-3.5 text-purple-500/80" />
                    <span className="text-xs font-bold text-slate-300">Voiceovers</span>
                  </div>
                  <span className="text-[9px] font-mono text-slate-500 bg-white/5 px-1.5 py-0.5 rounded font-mono">AUDIO</span>
                </div>
              </div>

              {/* Right Column: Interactive Timeline Tracks (horizontal scrollable) */}
              <div 
                ref={timelineRef}
                className="flex-1 relative overflow-x-auto select-none bg-black/25 custom-scrollbar min-w-0 font-sans"
                style={{ direction: 'ltr' }}
              >
                {/* Timescale Track Width calculated dynamically */}
                <div 
                  className="relative flex flex-col min-h-full"
                  style={{ width: `${Math.max(600, (totalDuration + 5) * zoom)}px` }}
                >
                  
                  {/* Dynamic Ruler Row */}
                  <div 
                    className="h-8 bg-black/45 border-b border-white/10 relative cursor-pointer"
                    onClick={handleTimelineScrub}
                  >
                    {(() => {
                      const getRulerConfig = (z: number) => {
                        if (z < 20) return { major: 10, minor: 2 };
                        if (z < 40) return { major: 5, minor: 1 };
                        if (z < 90) return { major: 2, minor: 0.5 };
                        if (z < 200) return { major: 1, minor: 0.2 };
                        if (z < 450) return { major: 0.5, minor: 0.1 };
                        if (z < 800) return { major: 0.2, minor: 0.05 };
                        return { major: 0.1, minor: 0.02 };
                      };

                      const { major: majorStep, minor: minorStep } = getRulerConfig(zoom);
                      const totalRulerSeconds = Math.max(10, Math.ceil(totalDuration) + 10);
                      const totalTicksCount = Math.ceil(totalRulerSeconds / minorStep);

                      return Array.from({ length: totalTicksCount + 1 }).map((_, idx) => {
                        const time = Math.round(idx * minorStep * 1000) / 1000;
                        const isMajor = Math.abs((time / majorStep) - Math.round(time / majorStep)) < 0.0001;
                        return (
                          <div 
                            key={idx} 
                            className="absolute bottom-0 flex flex-col items-center select-none"
                            style={{ left: `${time * zoom}px` }}
                          >
                            {/* Tick mark */}
                            <div className={cn("w-px", isMajor ? "h-3 bg-white/60" : "h-1.5 bg-white/20")} />
                            {/* Label */}
                            {isMajor && (
                              <span className="text-[9px] font-mono text-slate-300 absolute bottom-3 translate-x-[1px] whitespace-nowrap">
                                {time < 1 || majorStep < 1 ? `${time.toFixed(1)}s` : `${Math.round(time)}s`}
                              </span>
                            )}
                          </div>
                        );
                      });
                    })()}
                  </div>

                  {/* Infinite Grid Lines */}
                  {(() => {
                    const getRulerConfig = (z: number) => {
                      if (z < 20) return { major: 10, minor: 2 };
                      if (z < 40) return { major: 5, minor: 1 };
                      if (z < 90) return { major: 2, minor: 0.5 };
                      if (z < 200) return { major: 1, minor: 0.2 };
                      if (z < 450) return { major: 0.5, minor: 0.1 };
                      if (z < 800) return { major: 0.2, minor: 0.05 };
                      return { major: 0.1, minor: 0.02 };
                    };

                    const { major: majorStep } = getRulerConfig(zoom);
                    const totalRulerSeconds = Math.max(10, Math.ceil(totalDuration) + 10);
                    const majorTicksCount = Math.ceil(totalRulerSeconds / majorStep);

                    return Array.from({ length: majorTicksCount + 1 }).map((_, idx) => {
                      const time = Math.round(idx * majorStep * 1000) / 1000;
                      return (
                        <div 
                          key={idx} 
                          className="absolute top-8 bottom-0 border-l border-white/5 pointer-events-none"
                          style={{ left: `${time * zoom}px` }}
                        />
                      );
                    });
                  })()}

                  {/* Subtitles Track Lane */}
                  <div className="h-12 border-b border-white/5 relative bg-yellow-500/[0.01]">
                    {videoState.subtitles.map(sub => {
                      const isSelected = selectedSubtitleId === sub.id;
                      const subDur = Math.max(0.2, sub.end - sub.start);
                      return (
                        <div
                          key={sub.id}
                          className={cn(
                            "absolute top-1.5 bottom-1.5 bg-yellow-500/20 border border-yellow-500/50 rounded-lg px-2 text-[10px] text-yellow-300 font-bold flex items-center justify-between transition-colors select-none group cursor-grab active:cursor-grabbing overflow-hidden",
                            isSelected ? "ring-2 ring-yellow-400 z-10 bg-yellow-500/30 shadow-[0_0_10px_rgba(234,179,8,0.3)]" : "hover:bg-yellow-500/30"
                          )}
                          style={{ 
                            left: `${sub.start * zoom}px`, 
                            width: `${subDur * zoom}px` 
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSubtitleId(sub.id);
                            setActiveTab('subtitles');
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setSelectedSubtitleId(sub.id);
                            setDraggingState({
                              kind: 'subtitle-move',
                              id: sub.id,
                              initialClientX: e.clientX,
                              initialStart: sub.start,
                              initialEnd: sub.end
                            });
                          }}
                        >
                          {/* Left Trim Handle */}
                          <div 
                            className="absolute left-0 top-0 bottom-0 w-2.5 hover:bg-yellow-400 cursor-col-resize z-20 flex items-center justify-center rounded-l-lg transition-colors bg-yellow-500/40"
                            title="Drag to trim start"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedSubtitleId(sub.id);
                              setDraggingState({
                                kind: 'subtitle-trim-start',
                                id: sub.id,
                                initialClientX: e.clientX,
                                initialStart: sub.start,
                                initialEnd: sub.end
                              });
                            }}
                          >
                            <div className="w-0.5 h-3 bg-yellow-100 rounded-full" />
                          </div>

                          <span className="truncate px-2 pointer-events-none">{sub.text}</span>

                          {/* Right Trim Handle */}
                          <div 
                            className="absolute right-0 top-0 bottom-0 w-2.5 hover:bg-yellow-400 cursor-col-resize z-20 flex items-center justify-center rounded-r-lg transition-colors bg-yellow-500/40"
                            title="Drag to trim end"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedSubtitleId(sub.id);
                              setDraggingState({
                                kind: 'subtitle-trim-end',
                                id: sub.id,
                                initialClientX: e.clientX,
                                initialStart: sub.start,
                                initialEnd: sub.end
                              });
                            }}
                          >
                            <div className="w-0.5 h-3 bg-yellow-100 rounded-full" />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Media/Clip Tracks Lanes */}
                  {videoState.clips.map((clip) => {
                    const gStart = getClipGlobalStart(clip.id);
                    const isSelected = selectedClipId === clip.id;
                    const clipDur = clip.trimEnd - clip.trimStart;

                    return (
                      <div 
                        key={clip.id} 
                        className={cn(
                          "h-12 border-b border-white/5 relative flex items-center transition-colors select-none",
                          isSelected ? "bg-accent/5" : ""
                        )}
                      >
                        <div
                          className={cn(
                            "absolute top-1.5 bottom-1.5 rounded-xl border flex items-center justify-between group cursor-grab active:cursor-grabbing transition-all overflow-hidden",
                            isSelected 
                              ? "bg-accent/20 border-accent shadow-[0_0_15px_rgba(59,130,246,0.3)] z-10" 
                              : "bg-white/5 border-white/10 hover:bg-white/10"
                          )}
                          style={{ 
                            left: `${gStart * zoom}px`, 
                            width: `${clipDur * zoom}px` 
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedClipId(clip.id);
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setSelectedClipId(clip.id);
                            setDraggingState({
                              kind: 'clip-move',
                              id: clip.id,
                              initialClientX: e.clientX,
                              initialGlobalStart: gStart
                            });
                          }}
                        >
                          {/* Left handle for trimStart */}
                          <div 
                            className="absolute left-0 top-0 bottom-0 w-3 bg-accent/80 hover:bg-accent cursor-col-resize z-25 flex items-center justify-center rounded-l-xl transition-colors"
                            title="Drag to trim clip start"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedClipId(clip.id);
                              setDraggingState({
                                kind: 'clip-trim-start',
                                id: clip.id,
                                initialClientX: e.clientX,
                                initialTrimStart: clip.trimStart,
                                initialTrimEnd: clip.trimEnd
                              });
                            }}
                          >
                            <div className="w-0.5 h-3.5 bg-white/80 rounded-full" />
                          </div>

                          {/* Center Content */}
                          <div className="flex-1 flex items-center gap-1.5 overflow-hidden select-none pointer-events-none px-3.5">
                            {clip.type === 'image' ? (
                              <ImageIcon className="w-3.5 h-3.5 text-accent shrink-0" />
                            ) : (
                              <Scissors className="w-3.5 h-3.5 text-accent shrink-0" />
                            )}
                            <span className="text-[10px] font-bold uppercase tracking-wider truncate">
                              {clip.type === 'image' ? 'Image' : 'Video'}-{clip.id.substring(0, 4)}
                            </span>
                            <span className="text-[9px] text-slate-400 font-mono shrink-0">
                              ({clipDur.toFixed(1)}s)
                            </span>
                            {clip.muted && (
                              <span className="p-0.5 bg-red-500/20 text-red-400 rounded shrink-0 ml-auto" title="Audio Muted">
                                <VolumeX className="w-3 h-3" />
                              </span>
                            )}
                          </div>

                          {/* Right handle for trimEnd */}
                          <div 
                            className="absolute right-0 top-0 bottom-0 w-3 bg-accent/80 hover:bg-accent cursor-col-resize z-25 flex items-center justify-center rounded-r-xl transition-colors"
                            title="Drag to resize/trim clip end"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedClipId(clip.id);
                              setDraggingState({
                                kind: 'clip-trim-end',
                                id: clip.id,
                                initialClientX: e.clientX,
                                initialTrimStart: clip.trimStart,
                                initialTrimEnd: clip.trimEnd
                              });
                            }}
                          >
                            <div className="w-0.5 h-3.5 bg-white/80 rounded-full" />
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Add Track Spacer on Right Column to match Left Column button height */}
                  <div className="h-10 border-b border-white/5 relative bg-white/[0.01]" />

                  {/* Voiceovers Track Lane */}
                  <div className="h-12 border-b border-white/5 relative bg-purple-500/[0.01]">
                    {videoState.voiceovers.map(v => {
                      const vGlobalStart = getVoiceoverGlobalTime(v);
                      if (vGlobalStart === -1) return null;
                      const vDur = v.duration || 4;
                      const isSelected = selectedVoiceoverId === v.id;

                      const colorStyle = v.type === 'extracted'
                        ? "bg-amber-500/20 border-amber-500/50 text-amber-300"
                        : v.type === 'ai'
                          ? "bg-purple-500/20 border-purple-500/50 text-purple-300"
                          : "bg-blue-500/20 border-blue-500/50 text-blue-300";

                      const handleColor = v.type === 'extracted'
                        ? "bg-amber-400/80 hover:bg-amber-400"
                        : v.type === 'ai'
                          ? "bg-purple-400/80 hover:bg-purple-400"
                          : "bg-blue-400/80 hover:bg-blue-400";

                      return (
                        <div
                          key={v.id}
                          className={cn(
                            "absolute top-1.5 bottom-1.5 border rounded-lg flex items-center justify-between transition-all select-none group cursor-grab active:cursor-grabbing overflow-hidden",
                            colorStyle,
                            isSelected ? "ring-2 ring-purple-400 shadow-[0_0_12px_rgba(168,85,247,0.4)] z-10" : "hover:opacity-95"
                          )}
                          style={{ 
                            left: `${vGlobalStart * zoom}px`, 
                            width: `${vDur * zoom}px` 
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedVoiceoverId(v.id);
                            setActiveTab('voice');
                          }}
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setSelectedVoiceoverId(v.id);
                            setDraggingState({
                              kind: 'voiceover-move',
                              id: v.id,
                              initialClientX: e.clientX,
                              initialGlobalStart: vGlobalStart,
                              initialDuration: vDur
                            });
                          }}
                        >
                          {/* Left Trim/Resize Handle */}
                          <div 
                            className={cn(
                              "absolute left-0 top-0 bottom-0 w-2.5 cursor-col-resize z-20 flex items-center justify-center transition-colors rounded-l-lg",
                              handleColor
                            )}
                            title="Drag to adjust sound clip start position"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedVoiceoverId(v.id);
                              setDraggingState({
                                kind: 'voiceover-trim-start',
                                id: v.id,
                                initialClientX: e.clientX,
                                initialGlobalStart: vGlobalStart,
                                initialDuration: vDur
                              });
                            }}
                          >
                            <div className="w-0.5 h-3 bg-white/80 rounded-full" />
                          </div>

                          <div className="flex-1 flex items-center gap-1.5 px-3 overflow-hidden pointer-events-none">
                            {v.type === 'extracted' ? (
                              <Music className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                            ) : (
                              <Mic className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                            )}
                            <span className="truncate text-[10px] font-bold">{v.text || 'Audio Track'}</span>
                            <span className="text-[9px] opacity-70 font-mono shrink-0 ml-auto">({vDur.toFixed(1)}s)</span>
                          </div>

                          {/* Right Trim/Resize Handle */}
                          <div 
                            className={cn(
                              "absolute right-0 top-0 bottom-0 w-2.5 cursor-col-resize z-20 flex items-center justify-center transition-colors rounded-r-lg",
                              handleColor
                            )}
                            title="Drag to resize sound clip duration"
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedVoiceoverId(v.id);
                              setDraggingState({
                                kind: 'voiceover-trim-end',
                                id: v.id,
                                initialClientX: e.clientX,
                                initialGlobalStart: vGlobalStart,
                                initialDuration: vDur
                              });
                            }}
                          >
                            <div className="w-0.5 h-3 bg-white/80 rounded-full" />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Playhead indicator bar */}
                  <div 
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                    style={{ left: `${currentTime * zoom}px` }}
                  >
                    {/* Tick Handle */}
                    <div className="absolute top-0 -left-1.5 w-3.5 h-3.5 bg-red-500 rounded-b-full shadow border border-white/50" />
                  </div>

                </div>
              </div>
              </div>
            </div>
          </div>

        </section>

        {/* Right Sidebar: Contextual Panel */}
        {mobileSheetOpen && (
          <div className="md:hidden fixed inset-0 z-30 bg-black/60" onClick={() => setMobileSheetOpen(false)} />
        )}
        <aside
          role="dialog"
          aria-label={`${activeTab} settings`}
          className={cn(
            "glass flex flex-col overflow-hidden border-border",
            // Phone: bottom sheet above the tab bar. Desktop: the original right panel.
            "fixed inset-x-0 bottom-[72px] z-40 h-[65vh] rounded-t-3xl border-t transition-transform duration-200",
            mobileSheetOpen ? "translate-y-0" : "translate-y-[110%] pointer-events-none invisible",
            "md:static md:visible md:pointer-events-auto md:translate-y-0 md:h-auto md:w-80 md:rounded-none md:border-t-0 md:border-l"
          )}
        >
          <div className="md:hidden flex justify-center pt-2"><div className="w-10 h-1.5 rounded-full bg-slate-600" /></div>
          <div className="px-4 md:p-6 py-3 border-b border-border flex items-center justify-between">
            <h2 className="font-bold capitalize">{activeTab}</h2>
            <div className="flex items-center gap-2">
              <div className="text-xs font-mono text-slate-500">
                {videoState.subtitles.length + videoState.voiceovers.length} Items
              </div>
              <button
                onClick={() => setMobileSheetOpen(false)}
                aria-label="Close panel"
                className="md:hidden w-11 h-11 -mr-2 rounded-xl flex items-center justify-center text-slate-300 hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
            {activeTab === 'trim' && (
              <div className="space-y-6">
                <div className="space-y-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Clips</h3>
                  <Reorder.Group 
                    axis="y" 
                    values={videoState.clips} 
                    onReorder={(newClips) => setVideoState(prev => ({ ...prev, clips: newClips }))}
                    className="space-y-2"
                  >
                    {videoState.clips.map((clip, index) => (
                      <Reorder.Item 
                        key={clip.id} 
                        value={clip}
                        onClick={() => setSelectedClipId(clip.id)}
                        className={cn(
                          "group flex items-center gap-3 p-3 rounded-xl border transition-colors duration-150 select-none cursor-pointer",
                          selectedClipId === clip.id 
                            ? "bg-accent/10 border-accent/30" 
                            : "bg-white/5 border-white/10 hover:bg-white/10"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <GripVertical className="w-4 h-4 text-slate-600 group-hover:text-slate-400 cursor-grab active:cursor-grabbing" />
                          <div className="w-6 h-6 bg-white/10 rounded flex items-center justify-center text-[10px] font-bold">
                            {index + 1}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {clip.type === 'image' ? 'Image' : 'Clip'} {index + 1}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {formatTime(clip.trimEnd - clip.trimStart)}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                          {clip.type === 'video' && (
                            <>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleMuteClip(clip.id);
                                }}
                                className={cn(
                                  "p-1.5 rounded-lg transition-colors",
                                  clip.muted 
                                    ? "bg-red-500/20 text-red-400 hover:bg-red-500/30" 
                                    : "hover:bg-white/10 text-slate-500 hover:text-white"
                                )}
                                title={clip.muted ? "Unmute Audio" : "Mute Audio"}
                              >
                                {clip.muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                              </button>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleExtractAudio(clip);
                                }}
                                className="p-1.5 hover:bg-amber-500/20 text-slate-500 hover:text-amber-300 rounded-lg transition-colors"
                                title="Split Audio to Track"
                              >
                                <Music className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              duplicateClip(clip);
                            }}
                            className="p-1.5 hover:bg-accent/20 text-slate-500 hover:text-accent rounded-lg"
                            title="Duplicate Clip"
                          >
                            <Plus className="w-4 h-4" />
                          </button>
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setVideoState(prev => ({
                                ...prev,
                                clips: prev.clips.filter(c => c.id !== clip.id)
                              }));
                              if (selectedClipId === clip.id) setSelectedClipId(null);
                            }}
                            className="p-1.5 hover:bg-red-500/20 text-slate-500 hover:text-red-500 rounded-lg"
                            title="Delete Clip"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </Reorder.Item>
                    ))}
                  </Reorder.Group>
                  
                  <label className="w-full py-3 bg-white/5 hover:bg-white/10 border border-dashed border-white/20 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all">
                      <Plus className="w-4 h-4" />
                      <span className="text-sm">Add Media / WAV Audio</span>
                      <input 
                        type="file" 
                        accept="video/*,image/*,audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.flac,audio/wav,audio/x-wav" 
                        multiple
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>

                {selectedClip && (
                  <div className="space-y-6 pt-6 border-t border-border">
                    <div className="space-y-4">
                      <label className="text-sm font-medium text-slate-400">Start Time</label>
                      <div className="flex items-center gap-4">
                        <input 
                          type="number" 
                          value={selectedClip.trimStart.toFixed(2)}
                          onChange={(e) => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimStart: Math.max(0, parseFloat(e.target.value)) } : c)
                          }))}
                          className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                        />
                        <button 
                          onClick={() => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimStart: currentTime } : c)
                          }))}
                          className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-4">
                      <label className="text-sm font-medium text-slate-400">
                        {selectedClip.type === 'image' ? 'Duration' : 'End Time'}
                      </label>
                      <div className="flex items-center gap-4">
                        <input 
                          type="number" 
                          value={selectedClip.trimEnd.toFixed(2)}
                          onChange={(e) => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { 
                              ...c, 
                              trimEnd: parseFloat(e.target.value),
                              duration: c.type === 'image' ? Math.max(c.duration, parseFloat(e.target.value)) : c.duration
                            } : c)
                          }))}
                          className="flex-1 bg-white/5 border border-border rounded-lg px-3 py-2 text-sm font-mono"
                        />
                        <button 
                          onClick={() => setVideoState(prev => ({ 
                            ...prev, 
                            clips: prev.clips.map(c => c.id === selectedClip.id ? { ...c, trimEnd: currentTime } : c)
                          }))}
                          className="p-2 bg-accent/10 text-accent rounded-lg hover:bg-accent/20"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {selectedClip.type === 'video' && (
                      <div className="space-y-3 pt-4 border-t border-border">
                        <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Audio Controls</label>
                        
                        <div className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/10">
                          <div className="flex items-center gap-2">
                            {selectedClip.muted ? (
                              <VolumeX className="w-4 h-4 text-red-400" />
                            ) : (
                              <Volume2 className="w-4 h-4 text-accent" />
                            )}
                            <span className="text-xs font-bold text-slate-200">
                              {selectedClip.muted ? 'Audio Muted' : 'Audio Enabled'}
                            </span>
                          </div>
                          <button 
                            onClick={() => toggleMuteClip(selectedClip.id)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-xs font-bold transition-all",
                              selectedClip.muted 
                                ? "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30" 
                                : "bg-white/10 text-slate-300 hover:bg-white/20"
                            )}
                          >
                            {selectedClip.muted ? 'Unmute' : 'Mute'}
                          </button>
                        </div>

                        <button 
                          onClick={() => handleExtractAudio(selectedClip)}
                          className="w-full py-3 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 rounded-xl font-bold flex items-center justify-center gap-2 text-xs transition-all"
                        >
                          <Music className="w-4 h-4 text-amber-400" />
                          Split Audio to Track
                        </button>
                        <p className="text-[10px] text-slate-500 leading-tight">
                          Extracts video audio into a separate voiceover/audio track and mutes original video.
                        </p>
                      </div>
                    )}

                    <button 
                      onClick={() => duplicateClip(selectedClip)}
                      className="w-full py-4 bg-accent text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-accent-hover transition-all shadow-lg shadow-accent/20"
                    >
                      <Plus className="w-5 h-5" />
                      Add Selection as New Clip
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'voice' && (
              <div className="space-y-8">
                {/* Record Button */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Your Voice</h3>
                  <div className="flex flex-col gap-3">
                    <button 
                      onClick={isRecording ? stopRecording : startRecording}
                      className={cn(
                        "w-full py-4 rounded-2xl flex items-center justify-center gap-3 font-bold transition-all",
                        isRecording 
                          ? "bg-red-500 text-white animate-pulse" 
                          : "bg-white/5 hover:bg-white/10 text-white border border-white/10"
                      )}
                    >
                      <Mic className={cn("w-5 h-5", isRecording && "fill-white")} />
                      {isRecording ? "Stop Recording" : "Record Voiceover"}
                    </button>
                    
                    <label className="w-full py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all">
                      <Upload className="w-4 h-4 text-accent" />
                      <span className="text-sm">Upload WAV / Audio File</span>
                      <input 
                        type="file" 
                        accept="audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.flac,audio/wav,audio/x-wav" 
                        onChange={handleAudioUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {/* AI Voice */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">AI Voice</h3>
                  <div className="grid grid-cols-5 gap-2">
                    {(['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'] as const).map(v => (
                      <button
                        key={v}
                        onClick={() => setAiVoice(v)}
                        className={cn(
                          "py-2 text-[10px] font-bold rounded-lg border transition-all",
                          aiVoice === v 
                            ? "bg-accent border-accent text-white" 
                            : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                        )}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                  <textarea 
                    value={aiText}
                    onChange={(e) => setAiText(e.target.value)}
                    placeholder="Enter text for AI voiceover..."
                    className="w-full bg-white/5 border border-border rounded-xl p-4 text-sm min-h-[100px] focus:ring-1 ring-accent outline-none"
                  />
                  <button 
                    onClick={handleGenerateAIVoice}
                    disabled={isGeneratingAi || !aiText.trim()}
                    className="w-full py-3 bg-accent hover:bg-accent-hover disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition-all"
                  >
                    {isGeneratingAi ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Wand2 className="w-5 h-5" />
                    )}
                    Generate AI Voice
                  </button>
                </div>

                {/* List of Voiceovers */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Timeline</h3>
                  <div className="space-y-3">
                    {videoState.voiceovers.map(v => (
                      <div key={v.id} className="p-3 bg-white/5 rounded-xl border border-border flex items-center justify-between group">
                        <div className="flex items-center gap-3">
                          <div className={cn("p-2 rounded-lg", v.type === 'ai' ? "bg-purple-500/20 text-purple-400" : v.type === 'extracted' ? "bg-amber-500/20 text-amber-400" : "bg-blue-500/20 text-blue-400")}>
                            {v.type === 'ai' ? <Wand2 className="w-4 h-4" /> : v.type === 'extracted' ? <Music className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                          </div>
                          <div>
                            <div className="text-[10px] font-bold text-accent uppercase mb-1">
                              {videoState.clips.find(c => c.id === v.clipId)?.type === 'image' ? 'Image' : 'Clip'} Associated
                            </div>
                            <div className="text-xs font-mono text-slate-400">{formatTime(getVoiceoverGlobalTime(v))}</div>
                            <div className="text-sm font-medium truncate max-w-[120px]">{v.text || 'Voice Recording'}</div>
                          </div>
                        </div>
                        <button 
                          onClick={() => removeVoiceover(v.id)}
                          className="p-2 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'subtitles' && (
              <div className="space-y-6">
                {/* Burn-in toggle */}
                <div className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/10">
                  <div className="space-y-0.5">
                    <div className="text-sm font-bold">Burn-in Text Layers</div>
                    <div className="text-[10px] text-slate-400">Show text overlays in preview and video export</div>
                  </div>
                  <button 
                    onClick={() => setShowSubtitles(!showSubtitles)}
                    className={cn(
                      "w-12 h-6 rounded-full transition-all relative",
                      showSubtitles ? "bg-accent" : "bg-white/10"
                    )}
                  >
                    <div className={cn(
                      "absolute top-1 w-4 h-4 bg-white rounded-full transition-all",
                      showSubtitles ? "left-7" : "left-1"
                    )} />
                  </button>
                </div>

                {/* Add Text Presets Grid */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">Add Text Layer</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button 
                      onClick={() => addSubtitle('heading')}
                      className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold text-left flex flex-col gap-1 transition-all group"
                    >
                      <span className="text-xs text-accent font-extrabold flex items-center gap-1.5">
                        <Type className="w-3.5 h-3.5" /> HEADING
                      </span>
                      <span className="text-[10px] text-slate-400 font-normal">Bold Title Overlay</span>
                    </button>

                    <button 
                      onClick={() => addSubtitle('lowerThird')}
                      className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold text-left flex flex-col gap-1 transition-all group"
                    >
                      <span className="text-xs text-blue-400 font-extrabold flex items-center gap-1.5">
                        <Sliders className="w-3.5 h-3.5" /> LOWER THIRD
                      </span>
                      <span className="text-[10px] text-slate-400 font-normal">Name / Speaker Tag</span>
                    </button>

                    <button 
                      onClick={() => addSubtitle('caption')}
                      className="p-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold text-left flex flex-col gap-1 transition-all group"
                    >
                      <span className="text-xs text-amber-400 font-extrabold flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5" /> CAPTION
                      </span>
                      <span className="text-[10px] text-slate-400 font-normal">Dark Glass Subtitle</span>
                    </button>

                    <button 
                      onClick={() => addSubtitle()}
                      className="p-3 bg-accent/20 hover:bg-accent/30 border border-accent/40 rounded-xl font-bold text-left flex flex-col gap-1 transition-all group"
                    >
                      <span className="text-xs text-white font-extrabold flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5" /> CUSTOM TEXT
                      </span>
                      <span className="text-[10px] text-slate-300 font-normal font-sans">Blank Text Layer</span>
                    </button>
                  </div>
                </div>

                {/* Selected Layer Inspector */}
                {selectedSubtitle ? (
                  <div className="space-y-5 pt-4 border-t border-border">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-accent flex items-center gap-1.5">
                        <Type className="w-3.5 h-3.5" /> Edit Text Layer
                      </span>
                      <div className="flex items-center gap-1">
                        <button 
                          onClick={() => duplicateSubtitle(selectedSubtitle)}
                          className="p-1.5 hover:bg-white/10 text-slate-400 hover:text-white rounded-lg transition-colors"
                          title="Duplicate Text Layer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button 
                          onClick={() => removeSubtitle(selectedSubtitle.id)}
                          className="p-1.5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 rounded-lg transition-colors"
                          title="Delete Text Layer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Text Input */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-slate-400">Text Content</label>
                      <textarea 
                        value={selectedSubtitle.text}
                        onChange={(e) => updateSubtitle(selectedSubtitle.id, { text: e.target.value })}
                        placeholder="Type text overlay here..."
                        className="w-full bg-white/5 border border-white/15 rounded-xl p-3 text-sm font-medium outline-none focus:ring-1 ring-accent min-h-[70px] resize-none"
                      />
                    </div>

                    {/* Start & End Timing */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-slate-400">Start Time (s)</label>
                        <input 
                          type="number" 
                          step="0.1"
                          value={selectedSubtitle.start.toFixed(1)}
                          onChange={(e) => updateSubtitle(selectedSubtitle.id, { start: Math.max(0, parseFloat(e.target.value) || 0) })}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-medium text-slate-400">End Time (s)</label>
                        <input 
                          type="number" 
                          step="0.1"
                          value={selectedSubtitle.end.toFixed(1)}
                          onChange={(e) => updateSubtitle(selectedSubtitle.id, { end: Math.max(0.1, parseFloat(e.target.value) || 0) })}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                        />
                      </div>
                    </div>

                    {/* Font Size Slider + Presets */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-[11px] text-slate-400">
                        <span>Font Size</span>
                        <span className="font-mono text-white font-bold">{selectedSubtitle.fontSize || 24}px</span>
                      </div>
                      <input 
                        type="range" 
                        min="12" 
                        max="64" 
                        value={selectedSubtitle.fontSize || 24}
                        onChange={(e) => updateSubtitle(selectedSubtitle.id, { fontSize: parseInt(e.target.value) })}
                        className="w-full h-1 bg-white/15 rounded-full appearance-none cursor-pointer accent-accent"
                      />
                      <div className="flex items-center justify-between gap-1 pt-1">
                        {[
                          { label: 'S (16)', size: 16 },
                          { label: 'M (24)', size: 24 },
                          { label: 'L (34)', size: 34 },
                          { label: 'XL (48)', size: 48 },
                        ].map(f => (
                          <button
                            key={f.size}
                            onClick={() => updateSubtitle(selectedSubtitle.id, { fontSize: f.size })}
                            className={cn(
                              "flex-1 py-1 text-[9px] font-mono font-bold rounded border transition-colors",
                              (selectedSubtitle.fontSize || 24) === f.size 
                                ? "bg-accent border-accent text-white" 
                                : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/10"
                            )}
                          >
                            {f.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Text Color Swatches */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-slate-400">Text Color</label>
                      <div className="flex items-center gap-2">
                        {[
                          '#ffffff', '#facc15', '#3b82f6', '#10b981', '#ef4444', '#a855f7', '#ec4899', '#000000'
                        ].map(c => (
                          <button
                            key={c}
                            onClick={() => updateSubtitle(selectedSubtitle.id, { color: c })}
                            className={cn(
                              "w-6 h-6 rounded-full border transition-all shrink-0",
                              (selectedSubtitle.color || '#ffffff') === c ? "ring-2 ring-white scale-110 border-white" : "border-white/20 hover:scale-105"
                            )}
                            style={{ backgroundColor: c }}
                            title={c}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Background Style Swatches */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-slate-400">Background Style</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        {[
                          { label: 'Dark Glass', value: 'rgba(0, 0, 0, 0.75)' },
                          { label: 'Solid Black', value: '#000000' },
                          { label: 'Transparent', value: 'transparent' },
                          { label: 'Accent Blue', value: '#3b82f6' },
                          { label: 'Yellow Glow', value: '#facc15' },
                          { label: 'Pure White', value: '#ffffff' },
                        ].map(bg => (
                          <button
                            key={bg.value}
                            onClick={() => updateSubtitle(selectedSubtitle.id, { backgroundColor: bg.value })}
                            className={cn(
                              "py-1.5 px-2 text-[10px] font-bold rounded-lg border text-center transition-all truncate",
                              (selectedSubtitle.backgroundColor || 'rgba(0, 0, 0, 0.75)') === bg.value 
                                ? "bg-accent/20 border-accent text-accent" 
                                : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                            )}
                          >
                            {bg.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Screen Position Grid */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-slate-400">Screen Position</label>
                      <div className="grid grid-cols-3 gap-1.5">
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'top', positionX: 'left' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'top' && selectedSubtitle.positionX === 'left' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Top Left
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'top', positionX: 'center' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'top' && (selectedSubtitle.positionX || 'center') === 'center' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Top Mid
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'top', positionX: 'right' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'top' && selectedSubtitle.positionX === 'right' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Top Right
                        </button>

                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'center', positionX: 'left' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'center' && selectedSubtitle.positionX === 'left' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Mid Left
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'center', positionX: 'center' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'center' && (selectedSubtitle.positionX || 'center') === 'center' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Center
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'center', positionX: 'right' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", selectedSubtitle.positionY === 'center' && selectedSubtitle.positionX === 'right' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Mid Right
                        </button>

                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'bottom', positionX: 'left' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", (selectedSubtitle.positionY || 'bottom') === 'bottom' && selectedSubtitle.positionX === 'left' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Bot Left
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'bottom', positionX: 'center' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", (selectedSubtitle.positionY || 'bottom') === 'bottom' && (selectedSubtitle.positionX || 'center') === 'center' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Bot Mid
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { positionY: 'bottom', positionX: 'right' })}
                          className={cn("p-1.5 text-[10px] font-mono rounded border flex items-center justify-center text-center", (selectedSubtitle.positionY || 'bottom') === 'bottom' && selectedSubtitle.positionX === 'right' ? "bg-accent border-accent text-white font-bold" : "bg-white/5 border-white/10 text-slate-400")}
                        >
                          Bot Right
                        </button>
                      </div>
                    </div>

                    {/* Font Style Toggles */}
                    <div className="space-y-2">
                      <label className="text-[11px] font-medium text-slate-400">Style & Shadow</label>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { fontWeight: selectedSubtitle.fontWeight === 'extrabold' ? 'normal' : 'extrabold' })}
                          className={cn("flex-1 py-1.5 text-xs font-black rounded border transition-colors", selectedSubtitle.fontWeight === 'extrabold' ? "bg-accent border-accent text-white" : "bg-white/5 border-white/10 text-slate-300")}
                        >
                          Bold
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { fontStyle: selectedSubtitle.fontStyle === 'italic' ? 'normal' : 'italic' })}
                          className={cn("flex-1 py-1.5 text-xs italic font-bold rounded border transition-colors", selectedSubtitle.fontStyle === 'italic' ? "bg-accent border-accent text-white" : "bg-white/5 border-white/10 text-slate-300")}
                        >
                          Italic
                        </button>
                        <button 
                          onClick={() => updateSubtitle(selectedSubtitle.id, { hasShadow: !selectedSubtitle.hasShadow })}
                          className={cn("flex-1 py-1.5 text-xs font-bold rounded border transition-colors", selectedSubtitle.hasShadow !== false ? "bg-accent border-accent text-white" : "bg-white/5 border-white/10 text-slate-300")}
                        >
                          Shadow
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {/* All Text Layers List */}
                <div className="space-y-3 pt-4 border-t border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">All Text Layers ({videoState.subtitles.length})</span>
                  </div>
                  
                  {videoState.subtitles.length === 0 ? (
                    <div className="text-center py-6 px-4 bg-white/5 rounded-2xl border border-dashed border-white/10 text-slate-500 text-xs">
                      No text layers added yet. Click a preset above to create one.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-[220px] overflow-y-auto custom-scrollbar">
                      {videoState.subtitles.map(sub => {
                        const isSelected = selectedSubtitle?.id === sub.id;
                        return (
                          <div 
                            key={sub.id} 
                            onClick={() => setSelectedSubtitleId(sub.id)}
                            className={cn(
                              "p-3 rounded-xl border flex items-center justify-between group cursor-pointer transition-colors",
                              isSelected ? "bg-accent/15 border-accent/40" : "bg-white/5 border-white/10 hover:bg-white/10"
                            )}
                          >
                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                              <Type className="w-4 h-4 text-accent shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="text-xs font-bold text-slate-200 truncate">{sub.text || 'Untitled Text'}</div>
                                <div className="text-[10px] font-mono text-slate-400">
                                  {sub.start.toFixed(1)}s → {sub.end.toFixed(1)}s ({sub.positionY || 'bottom'})
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  duplicateSubtitle(sub);
                                }}
                                className="p-1 text-slate-400 hover:text-white rounded"
                                title="Duplicate"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeSubtitle(sub.id);
                                }}
                                className="p-1 text-slate-400 hover:text-red-400 rounded"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'watermark' && (
              <div className="space-y-6">
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Watermark / Logo</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">Add a logo or brand mark overlay. Customize its position, scale, and transparency.</p>
                  
                  <div className="flex flex-col gap-4">
                    {!videoState.watermarkUrl ? (
                      <label className="w-full py-8 bg-white/5 hover:bg-white/10 border border-dashed border-white/20 rounded-2xl font-bold flex flex-col items-center justify-center gap-3 cursor-pointer transition-all group">
                        <div className="w-12 h-12 bg-accent/10 rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                          <Upload className="w-6 h-6 text-accent" />
                        </div>
                        <span className="text-sm">Upload Logo</span>
                        <input 
                          type="file" 
                          accept="image/*" 
                          onChange={handleWatermarkUpload}
                          className="hidden"
                        />
                      </label>
                    ) : (
                      <div className="space-y-5">
                        <div className="relative aspect-video bg-black/60 rounded-2xl border border-white/15 overflow-hidden group flex items-center justify-center p-4">
                          <img 
                            src={videoState.watermarkUrl} 
                            alt="Watermark Preview" 
                            onError={() => {
                              setVideoState(prev => ({ ...prev, watermarkUrl: undefined }));
                            }}
                            className="max-h-full max-w-full object-contain p-2"
                            style={{ opacity: (videoState.watermarkOpacity ?? 80) / 100 }}
                            referrerPolicy="no-referrer"
                          />
                          <button 
                            onClick={() => setVideoState(prev => ({ ...prev, watermarkUrl: undefined }))}
                            className="absolute top-2 right-2 p-2 bg-red-500/80 hover:bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-lg"
                            title="Remove Logo"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>

                        <label className="w-full py-2.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold flex items-center justify-center gap-2 cursor-pointer transition-all text-xs">
                          <Upload className="w-4 h-4 text-accent" />
                          <span>Change Logo Image</span>
                          <input 
                            type="file" 
                            accept="image/*" 
                            onChange={handleWatermarkUpload}
                            className="hidden"
                          />
                        </label>

                        {/* Visible Time Range */}
                        <div className="space-y-2 pt-2 border-t border-white/10">
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-slate-300">Visible Time Range</span>
                            <span className="text-[10px] text-slate-500">Full length by default</span>
                          </div>
                          <p className="text-[10px] text-slate-500 leading-relaxed">
                            Limiting this to just the start or end (instead of the whole video) makes export much faster — only the covered stretch needs re-encoding.
                          </p>
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-slate-400">Start Time (s)</label>
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={(videoState.watermarkStart ?? 0).toFixed(1)}
                                onChange={(e) => setVideoState(prev => ({ ...prev, watermarkStart: Math.max(0, parseFloat(e.target.value) || 0) }))}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                              />
                            </div>
                            <div className="space-y-1">
                              <label className="text-[10px] font-medium text-slate-400">End Time (s)</label>
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                value={(videoState.watermarkEnd ?? totalDuration).toFixed(1)}
                                onChange={(e) => setVideoState(prev => ({ ...prev, watermarkEnd: Math.max(0.1, parseFloat(e.target.value) || 0) }))}
                                className="w-full bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs font-mono"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Screen Position Selector Grid */}
                        <div className="space-y-2 pt-2 border-t border-white/10">
                          <div className="flex justify-between items-center">
                            <span className="text-xs font-bold text-slate-300">Logo Position</span>
                            <span className="text-[10px] font-mono text-accent uppercase tracking-wider">{videoState.watermarkPosition || 'top-right'}</span>
                          </div>
                          
                          <div className="grid grid-cols-3 gap-2 p-2 bg-black/50 rounded-xl border border-white/10 aspect-[16/9] relative">
                            {[
                              { id: 'top-left', label: 'Top Left' },
                              { id: 'top-center', label: 'Top Mid' },
                              { id: 'top-right', label: 'Top Right' },
                              { id: 'center', label: 'Center' },
                              { id: 'bottom-left', label: 'Bot Left' },
                              { id: 'bottom-center', label: 'Bot Mid' },
                              { id: 'bottom-right', label: 'Bot Right' },
                            ].map((p) => {
                              const isSelected = (videoState.watermarkPosition || 'top-right') === p.id;
                              let colSpan = "";
                              if (p.id === 'center') colSpan = "col-start-2 row-start-2";
                              else if (p.id === 'bottom-left') colSpan = "col-start-1 row-start-3";
                              else if (p.id === 'bottom-center') colSpan = "col-start-2 row-start-3";
                              else if (p.id === 'bottom-right') colSpan = "col-start-3 row-start-3";

                              return (
                                <button
                                  key={p.id}
                                  onClick={() => setVideoState(prev => ({ ...prev, watermarkPosition: p.id as any }))}
                                  className={cn(
                                    "rounded-lg border text-[9px] font-bold flex items-center justify-center transition-all p-1.5",
                                    colSpan,
                                    isSelected 
                                      ? "bg-accent border-accent text-white shadow-lg shadow-accent/30 font-black scale-105" 
                                      : "bg-white/5 border-white/10 text-slate-400 hover:bg-white/15 hover:text-white"
                                  )}
                                >
                                  {p.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {/* Logo Size Slider */}
                        <div className="space-y-2">
                          <div className="flex justify-between items-center text-xs">
                            <span className="font-medium text-slate-300">Logo Scale</span>
                            <span className="font-mono text-accent font-bold">{videoState.watermarkSize || 15}%</span>
                          </div>
                          <input 
                            type="range"
                            min="5"
                            max="40"
                            step="1"
                            value={videoState.watermarkSize || 15}
                            onChange={(e) => setVideoState(prev => ({ ...prev, watermarkSize: parseInt(e.target.value) }))}
                            className="w-full h-1.5 bg-white/15 rounded-full appearance-none cursor-pointer accent-accent"
                          />
                        </div>

                        {/* Logo Opacity Slider */}
                        <div className="space-y-2">
                          <div className="flex justify-between items-center text-xs">
                            <span className="font-medium text-slate-300">Opacity / Transparency</span>
                            <span className="font-mono text-accent font-bold">{videoState.watermarkOpacity ?? 80}%</span>
                          </div>
                          <input 
                            type="range"
                            min="10"
                            max="100"
                            step="5"
                            value={videoState.watermarkOpacity ?? 80}
                            onChange={(e) => setVideoState(prev => ({ ...prev, watermarkOpacity: parseInt(e.target.value) }))}
                            className="w-full h-1.5 bg-white/15 rounded-full appearance-none cursor-pointer accent-accent"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="p-4 bg-accent/10 rounded-2xl border border-accent/20">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 bg-accent/20 rounded-lg flex items-center justify-center shrink-0">
                      <Save className="w-4 h-4 text-accent" />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-bold text-accent">Pro Tip</div>
                      <div className="text-[10px] text-slate-400 leading-relaxed">
                        Use a high-resolution PNG with transparency. You can click on the logo overlay directly in the video player to jump to these settings!
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function ToolButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center justify-center gap-1 transition-all group flex-1 md:flex-none h-full md:h-auto min-h-11",
        active ? "text-accent" : "text-slate-500 hover:text-slate-300"
      )}
    >
      <div className={cn(
        "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
        active ? "bg-accent/10 shadow-[0_0_20px_rgba(59,130,246,0.2)]" : "group-hover:bg-white/5"
      )}>
        {icon}
      </div>
      <span className="text-[10px] font-bold uppercase tracking-tighter">{label}</span>
    </button>
  );
}

function formatTime(seconds: number) {
  if (!isFinite(seconds)) return "00:00.00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

export default function App() {
  return (
    <AuthGate>
      <VidoCutApp />
    </AuthGate>
  );
}
