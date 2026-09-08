import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  X, 
  Server, 
  ArrowLeft, 
  ArrowRight, 
  Info,
  Menu,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  Share2,
  Cast,
  Tv,
  Check,
  Sparkles,
  Globe,
  Flag,
  AlertTriangle,
  Film,
  ThumbsUp,
  ThumbsDown,
  Download,
  MoreVertical,
  ChevronDown,
  ChevronUp,
  Layers,
  SkipBack,
  SkipForward
} from "lucide-react";
import { Episode, User } from "../types";
import Hls from "hls.js";
import { saveEpisodeProgress, getLocalEpisodeProgress, normalizeAnimeId } from "../utils/progress";
import { getProxyImageUrl, getAnimePlaceholder, recoverCoverImageInHotPath } from "../utils/imageUtils";
import { getAnimesWithEpisodes } from "../utils/animeDb";
import { getDownloadedEpisodeBlob } from "../utils/downloadDb";
import CommentSection from "./CommentSection";
import { resolveEmbedUrl } from "../utils/resolvers";
import { sendUserReport } from "../utils/reports";
import { getApiUrl } from "../utils/apiConfig";
import { Capacitor } from "@capacitor/core";

function isEmbedUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();

  // Direct media streams, Cloudflare R2, and raw downloads always use our native <video> player
  if (
    lower.includes(".r2.dev") ||
    lower.includes("/api/gdrive-stream") ||
    lower.includes("/api/proxy-stream") ||
    lower.includes("blob:") ||
    lower.endsWith(".mp4") ||
    lower.endsWith(".m3u8") ||
    lower.endsWith(".webm") ||
    lower.includes(".mp4?") ||
    lower.includes(".m3u8?")
  ) {
    return false;
  }

  if (
    lower.includes("embed") ||
    lower.includes("iframe") ||
    lower.includes("player") ||
    lower.includes("mega.nz") ||
    lower.includes("ok.ru") ||
    lower.includes("fembed") ||
    lower.includes("streamtape") ||
    lower.includes("mixdrop") ||
    lower.includes("rapidcloud") ||
    lower.includes("megacloud") ||
    lower.includes("rapid-cloud") ||
    lower.includes("youtube.com/embed") ||
    lower.includes("dailymotion.com/embed") ||
    lower.includes("vimeo.com/video") ||
    lower.includes("monoschinos") ||
    lower.includes("animeflv")
  ) {
    return true;
  }
  const cleanUrl = url.split("?")[0].split("#")[0].toLowerCase();
  if (cleanUrl.endsWith(".mp4") || cleanUrl.endsWith(".m3u8") || cleanUrl.endsWith(".webm") || cleanUrl.endsWith(".ogg")) {
    return false;
  }
  return true;
}

function injectStartTimeIntoEmbedUrl(url: string, seconds: number): string {
  if (!url || seconds <= 0) return url;
  
  const lower = url.toLowerCase();
  
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}start=${Math.floor(seconds)}`;
  }
  
  if (lower.includes("vimeo.com")) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}t=${Math.floor(seconds)}s`;
  }
  
  if (lower.includes("ok.ru")) {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}start=${Math.floor(seconds)}`;
  }
  
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}start=${Math.floor(seconds)}&t=${Math.floor(seconds)}`;
}

interface VideoPlayerProps {
  animeId: string;
  episodeId: string;
  contentType?: "anime" | "movie";
  animeTitle: string;
  animeCoverUrl: string;
  genres?: string[];
  onClose: () => void;
  onNavigateEpisode: (direction: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
  currentUser?: User | null;
  onOpenAuth?: () => void;
  onProgressSave?: (animeId: string, episodeId: string, episodeNumber: number, progressSeconds: number, durationSeconds: number) => void;
}

export default function VideoPlayer({
  animeId,
  episodeId,
  contentType = "anime",
  animeTitle,
  animeCoverUrl,
  genres = [],
  onClose,
  onNavigateEpisode,
  hasPrev,
  hasNext,
  currentUser = null,
  onOpenAuth,
  onProgressSave
}: VideoPlayerProps) {
  const [episodeData, setEpisodeData] = useState<Partial<Episode> | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeServerIdx, setActiveServerIdx] = useState(0);
  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  
  // Immersive Sidebar Control (Colapsed by default like Crunchyroll/Netflix theater mode)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [postMessageActive, setPostMessageActive] = useState(true);

  // User error reporting states
  const [showReportModal, setShowReportModal] = useState(false);
  const [selectedReportReason, setSelectedReportReason] = useState("El reproductor no carga / Enlace caído");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSubmittedSuccess, setReportSubmittedSuccess] = useState(false);

  // Resolve premium/canonical metadata from local catalog using normalized ID
  const { resolvedTitle, resolvedCover } = React.useMemo(() => {
    const normId = normalizeAnimeId(animeId, animeTitle);
    try {
      const match = getAnimesWithEpisodes().find(a => a.id === normId);
      if (match) {
        return {
          resolvedTitle: match.title,
          resolvedCover: match.coverUrl
        };
      }
    } catch (e) {}
    return {
      resolvedTitle: animeTitle || normId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      resolvedCover: animeCoverUrl || ""
    };
  }, [animeId, animeTitle, animeCoverUrl]);



  // Auto-advance state: tracks if current server failed and we're switching
  const [videoError, setVideoError] = useState<string | null>(null);
  const [isAutoAdvancing, setIsAutoAdvancing] = useState(false);
  const autoAdvanceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerWrapperRef = useRef<HTMLDivElement | null>(null);
  const lastTimeRef = useRef<number>(0);
  const lastDurationRef = useRef<number>(0);

  // Resolver States
  const [resolvedStreamUrl, setResolvedStreamUrl] = useState<string>("");
  const [useResolvedPlayer, setUseResolvedPlayer] = useState<boolean>(false);
  const [resolvedIsHls, setResolvedIsHls] = useState<boolean>(false);
  const [isResolving, setIsResolving] = useState<boolean>(false);

  // Premium Custom Controls States
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showCenterFeedback, setShowCenterFeedback] = useState<"play" | "pause" | null>(null);
  const [showNextEpPrompt, setShowNextEpPrompt] = useState(false);
  const [nextEpCountdown, setNextEpCountdown] = useState(10);
  const [copiedTimestamp, setCopiedTimestamp] = useState(false);

  const [isSynopsisExpanded, setIsSynopsisExpanded] = useState(false);
  const [showAllEpisodesSheet, setShowAllEpisodesSheet] = useState(false);
  const [isDownloadingOffline, setIsDownloadingOffline] = useState(false);
  const [downloadOfflineSuccess, setDownloadOfflineSuccess] = useState(false);

  // YouTube-Style Double Tap / Multi-Click 10s Seek State
  const [seekFeedback, setSeekFeedback] = useState<"rewind" | "forward" | null>(null);
  const [seekSeconds, setSeekSeconds] = useState<number>(10);
  const seekTimeoutRef = useRef<any>(null);
  const lastTapRef = useRef<{ time: number; side: "left" | "right" | "center" }>({ time: 0, side: "center" });

  const handleZoneClick = (side: "left" | "right" | "center") => {
    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current.time < 350 && lastTapRef.current.side === side;
    lastTapRef.current = { time: now, side };

    if (side === "left" && isDoubleTap) {
      // YouTube-style Rewind 10s
      if (videoRef.current) {
        const newTime = Math.max(0, videoRef.current.currentTime - 10);
        videoRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
      setSeekSeconds(prev => (seekFeedback === "rewind" ? prev + 10 : 10));
      setSeekFeedback("rewind");
      if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
      seekTimeoutRef.current = setTimeout(() => {
        setSeekFeedback(null);
        setSeekSeconds(10);
      }, 800);
    } else if (side === "right" && isDoubleTap) {
      // YouTube-style Forward 10s
      if (videoRef.current) {
        const newTime = Math.min(duration, videoRef.current.currentTime + 10);
        videoRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
      setSeekSeconds(prev => (seekFeedback === "forward" ? prev + 10 : 10));
      setSeekFeedback("forward");
      if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
      seekTimeoutRef.current = setTimeout(() => {
        setSeekFeedback(null);
        setSeekSeconds(10);
      }, 800);
    } else if (side === "center" || !isDoubleTap) {
      // Single tap / center tap toggles play
      setTimeout(() => {
        if (Date.now() - lastTapRef.current.time >= 300) {
          togglePlay();
        }
      }, 300);
    }
  };

  const episodeNumber = React.useMemo(() => {
    if (episodeData?.number !== undefined) return episodeData.number;
    const parts = episodeId.split("-");
    const lastPart = parts[parts.length - 1];
    if (!isNaN(Number(lastPart))) return Number(lastPart);
    return 1;
  }, [episodeData, episodeId]);

  const displayTitle = React.useMemo(() => {
    let rawTitle = episodeData?.title || "";
    if (!rawTitle) {
      const parts = episodeId.split("-");
      const lastPart = parts[parts.length - 1];
      if (!isNaN(Number(lastPart))) {
        return `Capítulo ${lastPart}`;
      } else if (episodeId.includes("-ep-")) {
        return `Capítulo ${episodeId.split("-ep-")[1]}`;
      } else {
        let humanized = episodeId.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        if (animeTitle && humanized.toLowerCase().includes(animeTitle.toLowerCase())) {
          const regex = new RegExp(animeTitle, "gi");
          humanized = humanized.replace(regex, "").trim();
        }
        return humanized || `Capítulo ${episodeId}`;
      }
    }
    if (/^\d+$/.test(rawTitle.trim())) {
      return `Capítulo ${rawTitle.trim()}`;
    }
    const lower = rawTitle.toLowerCase();
    if (lower.includes("capítulo") || lower.includes("capitulo") || lower.includes("episodio") || lower.includes("ep ")) {
      return rawTitle;
    }
    return rawTitle;
  }, [episodeData, episodeId, animeTitle]);

  const matchedAnime = React.useMemo(() => {
    const normId = normalizeAnimeId(animeId, animeTitle);
    try {
      return getAnimesWithEpisodes().find(a => a.id === normId) || null;
    } catch (e) {
      return null;
    }
  }, [animeId, animeTitle]);

  const allEpisodes = React.useMemo(() => {
    return matchedAnime?.episodes || [];
  }, [matchedAnime]);

  const nextEpisodeObj = React.useMemo(() => {
    if (!allEpisodes || allEpisodes.length === 0) return null;
    const currIdx = allEpisodes.findIndex(e => e.id === episodeId);
    if (currIdx !== -1 && currIdx < allEpisodes.length - 1) {
      return allEpisodes[currIdx + 1];
    }
    return null;
  }, [allEpisodes, episodeId]);

  const synopsisText = React.useMemo(() => {
    return (
      episodeData?.synopsis ||
      episodeData?.description ||
      matchedAnime?.synopsis ||
      matchedAnime?.description ||
      "Disfruta de este episodio en megaAnime con máxima velocidad de reproducción y calidad nativa Full HD."
    );
  }, [episodeData, matchedAnime]);



  // Check URL query param ?t= for direct timestamp seeking
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const timeParam = params.get("t");
    if (timeParam && !isNaN(parseFloat(timeParam)) && parseFloat(timeParam) > 0) {
      const targetTime = parseFloat(timeParam);
      if (videoRef.current) {
        videoRef.current.currentTime = targetTime;
      }
    }
  }, [episodeId]);

  // Check and load offline downloaded video from IndexedDB
  useEffect(() => {
    let blobUrl: string | null = null;
    async function checkLocalBlob() {
      try {
        const blob = await getDownloadedEpisodeBlob(episodeId);
        if (blob) {
          blobUrl = URL.createObjectURL(blob);
          setLocalVideoUrl(blobUrl);
          setActiveServerIdx(0);
        } else {
          setLocalVideoUrl(null);
        }
      } catch (err) {
        console.warn("Could not retrieve offline video download blob:", err);
        setLocalVideoUrl(null);
      }
    }
    checkLocalBlob();

    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [episodeId]);

  // Load episode details
  useEffect(() => {
    async function fetchEpisodeDetails() {
      setLoading(true);
      try {
        const res = await fetch(getApiUrl(`/api/episode/${encodeURIComponent(episodeId)}`), { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json();
          setEpisodeData(data);
        }
      } catch (err) {
        console.error("Error loading episode players:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchEpisodeDetails();
    
    setActiveServerIdx(0);
  }, [episodeId]);

  const rawServersList = [
    ...(localVideoUrl ? [{ name: "Reproducción Local (Descargado)", url: localVideoUrl }] : []),
    ...(episodeData?.videoServers && episodeData.videoServers.length > 0
      ? episodeData.videoServers
      : [])
  ];

  // Purge dead/seized hosts, YouTube embeds, and copyright-blocked servers
  const filteredServers = rawServersList.filter(s => {
    if (!s || !s.url) return false;
    const u = s.url.toLowerCase();
    const n = (s.name || "").toLowerCase();
    if (u.includes("youtube.com") || u.includes("youtu.be")) return false;
    // Purge dead domain parking / seized hosts (StreamSB, Fembed, etc.)
    if (
      u.includes("streamsb") || u.includes("embedsb") || u.includes("sbembed") ||
      u.includes("sbvideo") || u.includes("watchsb") || u.includes("streamsss") ||
      u.includes("sbfull") || n.includes("streamsb") || n.includes("sb (")
    ) {
      return false;
    }
    if (u.includes("fembed") || u.includes("feurl") || u.includes("femax20") || u.includes("bysekoze")) return false;
    // Purge ok.ru completely if any other server exists (prevents copyright blocked screen)
    if ((u.includes("ok.ru") || n.includes("okru")) && rawServersList.length > 1) {
      return false;
    }

    // ANTI-MISMATCH GUARD: Prevent servers belonging to another anime from being played
    const currentAnimeNormalized = (animeTitle + " " + animeId).toLowerCase().replace(/[^a-z0-9]/g, "");
    const KNOWN_ANIME_DISTINCT_KEYS = [
      "clevatess", "onepiece", "naruto", "bleach", "boruto", "dragonball",
      "jujutsukaisen", "chainsawman", "sololeveling", "frieren",
      "mushokutensei", "shingekinokyojin", "attackontitan", "bokunohero", "myheroacademia",
      "blackclover", "fairytail", "kimetsunoyaiba", "demonslayer", "hunterxhunter",
      "deathnote", "dandadan", "overlord", "spyxfamily", "tokyoghoul", "rezero"
    ];

    const cleanUrl = u.replace(/[^a-z0-9]/g, "");
    const cleanName = n.replace(/[^a-z0-9]/g, "");

    for (const key of KNOWN_ANIME_DISTINCT_KEYS) {
      const isTargetAnime = currentAnimeNormalized.includes(key);
      if (!isTargetAnime) {
        if (cleanUrl.includes(key) || cleanName.includes(key)) {
          console.warn(`[Anti-Mismatch Player Guard] Dropped server ${s.name} (${s.url}) - belongs to ${key}`);
          return false;
        }
      }
    }

    return true;
  });

  // Check if a Cloudflare R2 / Google Drive / MegaAnime Direct server exists in the list
  const hasDriveServer = filteredServers.some(s => {
    const u = (s.url || "").toLowerCase();
    const n = (s.name || "").toLowerCase();
    return u.includes(".r2.dev") || u.includes("drive.google.com") || u.includes("drive.usercontent.google.com") || u.includes("gdrive-stream") || u.includes("google.com/file") ||
           n.includes("megaanime") || n.includes("sin anuncios") || n.includes("exclusivo");
  });

  // Drive server is prioritized first, with external servers available as backups
  const serversBeforeSort = filteredServers;

  // Sort: R2 PRO HD (-1) > Drive/MegaAnime (0) > Direct MP4 (1) > Voe (2) > external
  const servers = [...serversBeforeSort].sort((a, b) => {
    const getScore = (s: { name: string; url: string }) => {
      const u = (s.url || "").toLowerCase();
      const n = (s.name || "").toLowerCase();
      if (u.includes(".r2.dev")) return -1; // Top priority: Cloudflare R2 native stream ($0 egress)
      if (u.includes("drive.google.com") || u.includes("gdrive-stream") || u.includes("google.com/file") || n.includes("drive") || n.includes("megaanime")) return 0;
      if (u.endsWith(".mp4") || u.endsWith(".m3u8") || u.includes(".mp4?") || u.includes(".m3u8?")) return 1;
      if (u.includes("voe") || n.includes("voe")) return 2;
      if (u.includes("streamwish") || u.includes("filelions") || n.includes("wish")) return 3;
      if (u.includes("mp4upload") || n.includes("mp4upload")) return 4;
      if (u.includes("yourupload") || n.includes("yourupload")) return 5;
      if (u.includes("amus") || n.includes("amus") || u.includes("mepu") || n.includes("mepu") || u.includes("tioanime.com/embed") || u.includes("embed.php")) return 6;
      if (u.includes("mega.nz") || u.includes("mega.co.nz") || n.includes("mega")) return 7;
      if (u.includes("hqq.tv") || u.includes("netu") || n.includes("netu")) return 8;
      if (u.includes("ok.ru") || n.includes("okru")) return 99;
      return 10;
    };
    return getScore(a) - getScore(b);
  });

  // Auto-select best direct stream server when servers load so our custom player is used
  useEffect(() => {
    if (!servers || servers.length === 0) return;

    let isMounted = true;

    const findAndSelectCustomPlayerServer = async () => {
      // 0. If Cloudflare R2 / Google Drive / MegaAnime Direct server exists, select it IMMEDIATELY as top priority
      const driveIdx = servers.findIndex(s => s && (
        (s.url && (s.url.includes(".r2.dev") || s.url.includes("drive.google.com") || s.url.includes("gdrive-stream") || s.url.includes("gdrive-token") || s.url.includes("google.com/file"))) ||
        (s.name && (s.name.toLowerCase().includes("megaanime") || s.name.toLowerCase().includes("drive") || s.name.toLowerCase().includes("exclusivo")))
      ));
      if (driveIdx !== -1) {
        if (isMounted) {
          setActiveServerIdx(driveIdx);
          setIsResolving(false);
        }
        return;
      }

      // 1. If any server is ALREADY a direct MP4/M3U8 URL, select it instantly
      const directIdx = servers.findIndex(s => s && s.url && !isEmbedUrl(s.url));
      if (directIdx !== -1) {
        if (isMounted) setActiveServerIdx(directIdx);
        return;
      }

      // 2. Scan ALL servers in PARALLEL to find the first one that resolves to a direct media stream
      setIsResolving(true);
      try {
        const results = await Promise.allSettled(
          servers.map(async (s, idx) => {
            if (!s || !s.url) return { idx, resolved: null };
            const resolved = await resolveEmbedUrl(s.name, s.url);
            return { idx, resolved };
          })
        );

        if (!isMounted) return;

        // 1. Select the first server that successfully resolved to a direct stream (and is NOT dead)
        for (const res of results) {
          if (res.status === "fulfilled" && res.value.resolved && res.value.resolved.url && !res.value.resolved.dead) {
            const { idx } = res.value;
            console.log(`[Auto-Player] Server #${idx + 1} (${servers[idx].name}) resolved to direct media stream! Auto-selecting natively.`);
            setActiveServerIdx(idx);
            return;
          }
        }

        // 2. If no direct stream, select the first ALIVE embed server (skipping dead 404 servers & okru)
        for (const res of results) {
          if (res.status === "fulfilled" && res.value.resolved && !res.value.resolved.dead) {
            const { idx } = res.value;
            const s = servers[idx];
            const u = (s?.url || "").toLowerCase();
            const n = (s?.name || "").toLowerCase();
            if ((u.includes("ok.ru") || n.includes("okru")) && servers.length > 1) continue;
            console.log(`[Auto-Player] Server #${idx + 1} (${servers[idx].name}) is an active embed! Auto-selecting.`);
            setActiveServerIdx(idx);
            return;
          }
        }
      } catch (e) {
        console.error("Error in parallel server scan:", e);
      } finally {
        if (isMounted) setIsResolving(false);
      }
    };

    findAndSelectCustomPlayerServer();
    return () => { isMounted = false; };
  }, [episodeId, servers.length]);

  const activeServer = servers[activeServerIdx] || servers[0];
  const isEmbed = activeServer ? isEmbedUrl(activeServer.url) : false;

  const isDriveServer = Boolean(
    activeServer && (
      (activeServer.name && (
        activeServer.name.toLowerCase().includes("drive") ||
        activeServer.name.toLowerCase().includes("megaanime") ||
        activeServer.name.toLowerCase().includes("exclusivo") ||
        activeServer.name.toLowerCase().includes("sin anuncios")
      )) ||
      (activeServer.url && (
        activeServer.url.includes("drive.google.com") ||
        activeServer.url.includes("google.com/file") ||
        activeServer.url.includes("gdrive-stream")
      ))
    )
  );

  const fallbackServerIdx = servers.findIndex((s, idx) => {
    if (idx === activeServerIdx) return false;
    const name = (s.name || "").toLowerCase();
    const url = (s.url || "").toLowerCase();
    const isDrv = name.includes("drive") || name.includes("megaanime") || name.includes("exclusivo") || name.includes("sin anuncios") || url.includes("drive.google.com") || url.includes("google.com/file");
    return !isDrv;
  });

  // Resolve link dynamically on server selection change (fast & non-blocking)
  useEffect(() => {
    if (!activeServer) return;

    setResolvedStreamUrl("");
    setUseResolvedPlayer(false);
    setResolvedIsHls(false);

    const checkAndResolve = async () => {
      // 0. Cloudflare R2 direct stream ($0 egress, native PRO player)
      const isR2 = (activeServer.url || "").includes(".r2.dev");
      if (isR2) {
        setResolvedStreamUrl(activeServer.url);
        setUseResolvedPlayer(true);
        setResolvedIsHls(false);
        setVideoError(null);
        setIsResolving(false);
        return;
      }

      // Dedicated Google Drive / MegaAnime HD server — use preview iframe fallback
      const isDrive = (activeServer.url || "").includes("drive.google.com") ||
                      (activeServer.url || "").includes("drive.usercontent.google.com") ||
                      (activeServer.url || "").includes("gdrive-stream") ||
                      (activeServer.url || "").includes("gdrive-token") ||
                      (activeServer.name || "").toLowerCase().includes("megaanime") ||
                      (activeServer.name || "").toLowerCase().includes("sin anuncios");

      if (isDrive) {
        // Extract fileId from any URL format
        const fileMatch =
          (activeServer.url || "").match(/[?&]fileId=([a-zA-Z0-9_-]+)/) ||
          (activeServer.url || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
          (activeServer.url || "").match(/\/d\/([a-zA-Z0-9_-]+)/) ||
          (activeServer.url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);

        if (fileMatch) {
          const previewUrl = `https://drive.google.com/file/d/${fileMatch[1]}/preview`;
          setResolvedStreamUrl(previewUrl);
          setUseResolvedPlayer(false);
          setVideoError(null);
          setResolvedIsHls(false);
          setIsResolving(false);
          return;
        }
      }

      const direct = !isEmbedUrl(activeServer.url);
      if (direct) {
        setResolvedStreamUrl(getApiUrl(activeServer.url));
        setUseResolvedPlayer(true);
        setResolvedIsHls(activeServer.url.toLowerCase().split("?")[0].split("#")[0].endsWith(".m3u8"));
        setIsResolving(false);
        return;
      }

      setIsResolving(true);
      try {
        const resolved = await resolveEmbedUrl(activeServer.name, activeServer.url);

        if (resolved && resolved.url) {
          setResolvedStreamUrl(getApiUrl(resolved.url));
          setUseResolvedPlayer(true);
          setResolvedIsHls(resolved.isHls);
        } else {
          // Use direct activeServer URL inside iframe player container
          setResolvedStreamUrl(activeServer.url);
          setUseResolvedPlayer(false);
        }
      } catch (e) {
        console.error("Error resolving server URL:", e);
        setResolvedStreamUrl(activeServer.url);
        setUseResolvedPlayer(false);
      } finally {
        setIsResolving(false);
      }
    };

    checkAndResolve();
  }, [activeServer]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(e => console.log("Play error:", e));
      setIsPlaying(true);
      setShowCenterFeedback("play");
    } else {
      video.pause();
      setIsPlaying(false);
      setShowCenterFeedback("pause");
    }
    setTimeout(() => setShowCenterFeedback(null), 500);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const newMuteState = !video.muted;
    video.muted = newMuteState;
    setIsMuted(newMuteState);
  };

  const handleVolumeChange = (newVal: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = newVal;
    setVolume(newVal);
    if (newVal === 0) {
      video.muted = true;
      setIsMuted(true);
    } else {
      video.muted = false;
      setIsMuted(false);
    }
  };

  const handleSpeedChange = (rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
  };

  const toggleFullscreen = () => {
    const container = playerWrapperRef.current;
    const video = videoRef.current;

    const isFS = !!(
      document.fullscreenElement ||
      (document as any).webkitFullscreenElement ||
      (document as any).mozFullScreenElement ||
      (document as any).msFullscreenElement
    );

    if (!isFS) {
      if (container) {
        if (container.requestFullscreen) {
          container.requestFullscreen().catch(() => {
            if (video && (video as any).webkitEnterFullscreen) {
              (video as any).webkitEnterFullscreen();
            }
          });
        } else if ((container as any).webkitRequestFullscreen) {
          (container as any).webkitRequestFullscreen();
        } else if ((container as any).mozRequestFullScreen) {
          (container as any).mozRequestFullScreen();
        } else if ((container as any).msRequestFullscreen) {
          (container as any).msRequestFullscreen();
        } else if (video && (video as any).webkitEnterFullscreen) {
          (video as any).webkitEnterFullscreen();
        }
      } else if (video && (video as any).webkitEnterFullscreen) {
        (video as any).webkitEnterFullscreen();
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if ((document as any).webkitExitFullscreen) {
        (document as any).webkitExitFullscreen();
      } else if ((document as any).mozCancelFullScreen) {
        (document as any).mozCancelFullScreen();
      } else if ((document as any).msExitFullscreen) {
        (document as any).msExitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Sync fullscreen state if changed externally (e.g. Escape key or native iOS/Android controls)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFS = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      setIsFullscreen(isFS);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
    };
  }, []);

  // Keyboard Hotkeys Integration
  useEffect(() => {
    if (isEmbed) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA")) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      switch (e.key.toLowerCase()) {
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "arrowleft":
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          setCurrentTime(video.currentTime);
          break;
        case "arrowright":
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          setCurrentTime(video.currentTime);
          break;
        case "arrowup":
          e.preventDefault();
          setVolume(prev => {
            const newVol = Math.min(1.0, prev + 0.1);
            video.volume = newVol;
            video.muted = false;
            setIsMuted(false);
            return newVol;
          });
          break;
        case "arrowdown":
          e.preventDefault();
          setVolume(prev => {
            const newVol = Math.max(0, prev - 0.1);
            video.volume = newVol;
            if (newVol === 0) {
              video.muted = true;
              setIsMuted(true);
            }
            return newVol;
          });
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "m":
          e.preventDefault();
          toggleMute();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isEmbed, volume]);

  // Auto-hide controls & mouse cursor when inactive (Fullscreen & Normal viewing)
  useEffect(() => {
    let timer: NodeJS.Timeout;

    const resetControlsTimer = () => {
      setShowControls(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    };

    const container = playerWrapperRef.current;
    if (container) {
      container.addEventListener("mousemove", resetControlsTimer);
      container.addEventListener("touchstart", resetControlsTimer);
      container.addEventListener("pointerdown", resetControlsTimer);
      container.addEventListener("click", resetControlsTimer);
    }

    window.addEventListener("mousemove", resetControlsTimer);
    window.addEventListener("keydown", resetControlsTimer);

    // Initial 3-second timer trigger
    resetControlsTimer();

    return () => {
      clearTimeout(timer);
      if (container) {
        container.removeEventListener("mousemove", resetControlsTimer);
        container.removeEventListener("touchstart", resetControlsTimer);
        container.removeEventListener("pointerdown", resetControlsTimer);
        container.removeEventListener("click", resetControlsTimer);
      }
      window.removeEventListener("mousemove", resetControlsTimer);
      window.removeEventListener("keydown", resetControlsTimer);
    };
  }, [isFullscreen]);

  // Next episode countdown triggers
  useEffect(() => {
    if (isEmbed) return;
    if (hasNext && duration > 0 && duration - currentTime <= 20 && currentTime > 0) {
      setShowNextEpPrompt(true);
    } else {
      setShowNextEpPrompt(false);
    }
  }, [currentTime, duration, hasNext, isEmbed]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (showNextEpPrompt) {
      setNextEpCountdown(10);
      interval = setInterval(() => {
        setNextEpCountdown(prev => {
          if (prev <= 1) {
            clearInterval(interval);
            onNavigateEpisode("next");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [showNextEpPrompt, onNavigateEpisode]);

  function formatTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    const mStr = m < 10 ? `0${m}` : `${m}`;
    const sStr = s < 10 ? `0${s}` : `${s}`;
    
    if (h > 0) {
      const hStr = h < 10 ? `0${h}` : `${h}`;
      return `${hStr}:${mStr}:${sStr}`;
    }
    return `${mStr}:${sStr}`;
  }


  const embedUrlWithTime = React.useMemo(() => {
    const rawTarget = (!useResolvedPlayer && resolvedStreamUrl) ? resolvedStreamUrl : (activeServer?.url || "");
    if (!rawTarget) return "";

    // Check if it's an embed or drive preview
    if (!isEmbedUrl(rawTarget) && !rawTarget.includes("drive.google.com")) return "";
    
    let url = rawTarget;
    const isDrive = url.toLowerCase().includes("drive.google.com/file/d/");
    
    // Drive preview URLs don't accept external start/autoplay params — return as-is
    if (isDrive) return url;

    const saved = getLocalEpisodeProgress(animeId, currentUser, resolvedTitle);
    if (saved && saved.episodeId === episodeId && saved.progressSeconds > 5) {
      const duration = saved.durationSeconds || 1440;
      if (saved.progressSeconds < duration * 0.90) {
        url = injectStartTimeIntoEmbedUrl(url, saved.progressSeconds);
      }
    }
    // Append autoplay parameters so video starts playing immediately on selection
    const connector = url.includes("?") ? "&" : "?";
    if (!url.includes("autoplay=") && !url.includes("autostart=")) {
      url += `${connector}autoplay=1&autostart=true`;
    }
    return url;
  }, [activeServer, resolvedStreamUrl, useResolvedPlayer, episodeId, animeId, currentUser, resolvedTitle]);

  const handleVideoError = useCallback(() => {
    console.warn(`[Auto-Player] Direct stream error on ${activeServer?.name}. Checking fallback options.`);

    // If R2 fails, switch to next available backup server (e.g. Google Drive preview or Voe)
    if (activeServer?.url && activeServer.url.includes(".r2.dev") && fallbackServerIdx !== -1) {
      console.warn("[Auto-Player] R2 video playback failed, falling back to backup server.");
      setActiveServerIdx(fallbackServerIdx);
      return;
    }

    const fileMatch =
      (activeServer?.url || "").match(/[?&]fileId=([a-zA-Z0-9_-]+)/) ||
      (activeServer?.url || "").match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
      (activeServer?.url || "").match(/\/d\/([a-zA-Z0-9_-]+)/) ||
      (activeServer?.url || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);

    const fileId = fileMatch ? fileMatch[1] : null;

    if (fileId) {
      const previewUrl = `https://drive.google.com/file/d/${fileId}/preview`;
      setResolvedStreamUrl(previewUrl);
      setUseResolvedPlayer(false);
      setVideoError(null);
      setIsAutoAdvancing(false);
      return;
    }

    setUseResolvedPlayer(false);
    setResolvedStreamUrl(activeServer?.url || "");
    setVideoError(null);
    setIsAutoAdvancing(false);
  }, [activeServer, fallbackServerIdx]);

  // Direct video load & HLS support with auto-advance on fatal error
  useEffect(() => {
    if (!resolvedStreamUrl || !useResolvedPlayer) return;

    // Reset error state whenever we load a new stream
    setVideoError(null);
    setIsAutoAdvancing(false);
    if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);

    let hls: Hls | null = null;
    const isHls = resolvedIsHls || resolvedStreamUrl.toLowerCase().split("?")[0].split("#")[0].endsWith(".m3u8");

    const startPlayback = (videoEl: HTMLVideoElement) => {
      setIsPlaying(true);
      videoEl.play().catch(e => {
        console.log("Autoplay blocked by browser policy, attempting muted autoplay:", e);
        videoEl.muted = true;
        setIsMuted(true);
        videoEl.play().catch(() => {});
      });
    };

    // Attach to video ref when element is ready
    const attachVideo = () => {
      const video = videoRef.current;
      if (!video) return false;

      if (isHls) {
        if (Hls.isSupported()) {
          hls = new Hls({
            maxMaxBufferLength: 30,
            enableWorker: true,
            fragLoadingTimeOut: 15000,
            manifestLoadingTimeOut: 10000,
            levelLoadingTimeOut: 10000
          });
          hls.loadSource(resolvedStreamUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            startPlayback(video);
          });
          hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (data.fatal) {
              console.warn("HLS fatal error:", data.type, data.details);
              hls?.destroy();
              handleVideoError();
            }
          });
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = resolvedStreamUrl;
          video.load();
          video.addEventListener("error", handleVideoError);
          startPlayback(video);
        }
      } else {
        video.src = resolvedStreamUrl;
        video.load();
        video.addEventListener("error", handleVideoError);
        startPlayback(video);
      }
      return true;
    };

    // Poll until video ref is populated by React rendering
    let pollTimer: any = null;
    if (!attachVideo()) {
      pollTimer = setInterval(() => {
        if (attachVideo()) {
          clearInterval(pollTimer);
        }
      }, 50);
    }

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      if (hls) hls.destroy();
      const video = videoRef.current;
      if (video) video.removeEventListener("error", handleVideoError);
      if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedStreamUrl, useResolvedPlayer, resolvedIsHls, activeServerIdx, servers.length]);


  // Direct video seek progress on loaded
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeServer || (isEmbedUrl(activeServer.url) && !useResolvedPlayer)) return;

    const handleLoadedMetadata = () => {
      const saved = getLocalEpisodeProgress(animeId, currentUser, resolvedTitle);
      if (saved && saved.episodeId === episodeId && saved.progressSeconds > 0) {
        if (saved.progressSeconds < video.duration * 0.95) {
          video.currentTime = saved.progressSeconds;
        }
      }
    };

    video.addEventListener("loadedmetadata", handleLoadedMetadata);
    return () => video.removeEventListener("loadedmetadata", handleLoadedMetadata);
  }, [activeServer, activeServerIdx, episodeId, animeId, currentUser, useResolvedPlayer]);

  // Native HTML5 Video real-time event listeners (timeupdate, pause, seeked)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeServer || (isEmbedUrl(activeServer.url) && !useResolvedPlayer)) return;

    const handleVideoProgress = () => {
      if (video.currentTime > 0 && video.duration > 0) {
        lastTimeRef.current = video.currentTime;
        lastDurationRef.current = video.duration;
        saveEpisodeProgress(
          animeId,
          episodeId,
          episodeNumber,
          video.currentTime,
          video.duration,
          currentUser,
          false,
          "anime",
          resolvedTitle,
          resolvedCover
        );
      }
    };

    const handleForceSave = () => {
      if (video.currentTime > 0 && video.duration > 0) {
        lastTimeRef.current = video.currentTime;
        lastDurationRef.current = video.duration;
        saveEpisodeProgress(
          animeId,
          episodeId,
          episodeNumber,
          video.currentTime,
          video.duration,
          currentUser,
          true,
          "anime",
          resolvedTitle,
          resolvedCover
        );
      }
    };

    video.addEventListener("timeupdate", handleVideoProgress);
    video.addEventListener("pause", handleForceSave);
    video.addEventListener("seeked", handleVideoProgress);

    return () => {
      if (lastTimeRef.current > 0 && lastDurationRef.current > 0) {
        saveEpisodeProgress(
          animeId,
          episodeId,
          episodeNumber,
          lastTimeRef.current,
          lastDurationRef.current,
          currentUser,
          true,
          "anime",
          resolvedTitle,
          resolvedCover
        );
      }
      video.removeEventListener("timeupdate", handleVideoProgress);
      video.removeEventListener("pause", handleForceSave);
      video.removeEventListener("seeked", handleVideoProgress);
    };
  }, [activeServer, activeServerIdx, episodeId, animeId, currentUser, resolvedTitle, resolvedCover]);

  // Simulated timer and postMessage API for iframe embeds
  useEffect(() => {
    if (!activeServer || !isEmbedUrl(activeServer.url)) return;

    const isMovie = genres.includes("Película") || episodeId.toLowerCase().includes("movie") || episodeId.toLowerCase().includes("pelicula");
    const estimatedDuration = isMovie ? 7200 : 1440;
    
    let trackedTime = 1;
    
    const saved = getLocalEpisodeProgress(animeId, currentUser, resolvedTitle);
    if (saved && saved.episodeId === episodeId) {
      trackedTime = Math.max(1, saved.progressSeconds);
    }

    let messageCount = 0;
    
    const checkTimeout = setTimeout(() => {
      if (messageCount === 0) {
        setPostMessageActive(false);
      }
    }, 8000);

    const saveCurrentProgress = (force = false) => {
      if (onProgressSave) {
        onProgressSave(animeId, episodeId, episodeNumber, trackedTime, estimatedDuration);
      } else {
        saveEpisodeProgress(
          animeId,
          episodeId,
          episodeNumber,
          trackedTime,
          estimatedDuration,
          currentUser,
          force,
          contentType,
          resolvedTitle,
          resolvedCover
        );
      }
    };

    if (trackedTime > 30) {
      saveCurrentProgress(true);
    } else {
      const initTimer = setTimeout(() => {
        if (trackedTime > 1) saveCurrentProgress(false);
      }, 15000);
      (saveCurrentProgress as any).__initTimer = initTimer;
    }

    const handleIframeMessage = (event: MessageEvent) => {
      let data: any = null;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch (e) {
        if (typeof event.data === "string") {
          const str = event.data.trim();
          if (str.startsWith("time:") || str.startsWith("progress:")) {
            const val = parseFloat(str.split(":")[1]);
            if (!isNaN(val) && val > 0) {
              messageCount++;
              setPostMessageActive(true);
              trackedTime = val;
              saveCurrentProgress(false);
            }
          }
        }
        return;
      }

      if (!data) return;

      let progress: number | null = null;
      let duration: number | null = null;

      if (data.event === "infoDelivery" && data.info) {
        if (data.info.currentTime !== undefined) progress = data.info.currentTime;
        if (data.info.duration !== undefined) duration = data.info.duration;
      }
      if (data.event === "timeupdate" && data.data) {
        if (data.data.seconds !== undefined) progress = data.data.seconds;
        if (data.data.duration !== undefined) duration = data.data.duration;
      }

      if (data.event === "time" || data.event === "timeupdate" || data.event === "progress") {
        if (data.value !== undefined && typeof data.value === "number") progress = data.value;
        else if (data.time !== undefined && typeof data.time === "number") progress = data.time;
        if (data.duration !== undefined && typeof data.duration === "number") duration = data.duration;
      }

      if (data.type === "timeupdate" || data.event === "timeupdate") {
        if (data.currentTime !== undefined && typeof data.currentTime === "number") progress = data.currentTime;
        if (data.duration !== undefined && typeof data.duration === "number") duration = data.duration;
      }

      if (progress === null) {
        const progressKeys = ["currentTime", "progress", "seconds", "time", "current_time", "value"];
        for (const key of progressKeys) {
          if (data[key] !== undefined && typeof data[key] === "number") {
            progress = data[key];
            break;
          }
        }
      }
      if (duration === null) {
        const durationKeys = ["duration", "totalTime", "length", "total_time"];
        for (const key of durationKeys) {
          if (data[key] !== undefined && typeof data[key] === "number") {
            duration = data[key];
            break;
          }
        }
      }

      if (progress !== null && progress > 0) {
        messageCount++;
        setPostMessageActive(true);
        trackedTime = progress;
        const finalDuration = duration && duration > 0 ? duration : estimatedDuration;
        
        if (onProgressSave) {
          onProgressSave(animeId, episodeId, episodeNumber, progress, finalDuration);
        } else {
          saveEpisodeProgress(
            animeId,
            episodeId,
            episodeNumber,
            progress,
            finalDuration,
            currentUser,
            false,
            contentType,
            resolvedTitle,
            resolvedCover
          );
        }
      }
    };

    const interval = setInterval(() => {
      trackedTime = Math.min(estimatedDuration, trackedTime + 10);
      saveCurrentProgress(false);
    }, 10000);

    const handleBeforeUnload = () => {
      saveCurrentProgress(true);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("message", handleIframeMessage);

    return () => {
      clearTimeout(checkTimeout);
      if ((saveCurrentProgress as any).__initTimer) {
        clearTimeout((saveCurrentProgress as any).__initTimer);
      }
      clearInterval(interval);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("message", handleIframeMessage);
      saveCurrentProgress(true);
    };
  }, [activeServer, activeServerIdx, episodeId, animeId, currentUser, resolvedTitle, resolvedCover]);




  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-neutral-950 text-neutral-100 animate-fade-in pb-[env(safe-area-inset-bottom,0px)]">
      {/* Top Controls Bar with iOS Safe Area Inset Support */}
      <div className={`flex items-center justify-between border-b border-white/5 bg-black/95 px-4 sm:px-6 z-40 flex-shrink-0 transition-all duration-300 pt-[env(safe-area-inset-top,0px)] min-h-[calc(3.5rem+env(safe-area-inset-top,0px))] pb-2 ${
        isFullscreen && !showControls ? "opacity-0 pointer-events-none -translate-y-full" : "opacity-100"
      }`}>
        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 text-neutral-300 hover:text-white hover:bg-neutral-800 transition cursor-pointer"
          title="Volver"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <button
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 text-neutral-300 hover:text-white hover:bg-rose-500/10 hover:text-rose-400 transition cursor-pointer"
          title="Cerrar reproductor"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Main Unified Scrollable Frame (Same on Web and Mobile App) */}
      <div className="flex-grow flex flex-col overflow-y-auto relative w-full bg-neutral-950">
        {/* Top Cinema Player viewport (100% full-width edge-to-edge horizontally, comfortable vertical height) */}
        <div className="w-full aspect-video max-h-[48vh] sm:max-h-[52vh] md:max-h-[56vh] bg-black relative flex items-center justify-center overflow-hidden p-0 shrink-0 sticky top-0 z-30 shadow-2xl">
          {loading ? (
            <div className="flex flex-col items-center justify-center space-y-4 text-center p-6">
              <div className="h-12 w-12 rounded-full border-2 border-t-2 border-neutral-800 border-t-rose-500 animate-spin" />
              <span className="text-xs text-neutral-400 animate-pulse">Invocando reproductor premium...</span>
            </div>
          ) : activeServer ? (
            <div className="w-full h-full flex items-center justify-center bg-black relative">

              {isResolving ? (
                <div className="flex flex-col items-center justify-center space-y-4 text-center p-6">
                  <div className="h-12 w-12 rounded-full border-2 border-t-2 border-neutral-800 border-t-rose-500 animate-spin" />
                  <span className="text-xs text-neutral-400 animate-pulse">Cargando reproductor...</span>
                </div>
              ) : videoError ? (
                <div className="flex flex-col items-center justify-center space-y-5 text-center p-8 max-w-lg">
                  <div className="h-14 w-14 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
                    {isAutoAdvancing ? (
                      <div className="h-7 w-7 rounded-full border-2 border-t-2 border-neutral-700 border-t-rose-500 animate-spin" />
                    ) : (
                      <Info className="h-7 w-7 text-rose-400" />
                    )}
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white mb-1">
                      {isAutoAdvancing ? "Cargando reproductor..." : "Error de reproducción"}
                    </h3>
                    <p className="text-xs text-neutral-400">{videoError}</p>
                  </div>
                  {!isAutoAdvancing && (
                    <div className="flex gap-3">
                      {activeServerIdx < servers.length - 1 && (
                        <button
                          onClick={() => setActiveServerIdx(prev => Math.min(prev + 1, servers.length - 1))}
                          className="px-5 py-2.5 bg-rose-500 hover:bg-rose-400 text-white text-xs font-bold rounded-xl transition cursor-pointer"
                        >
                          Siguiente Servidor
                        </button>
                      )}
                      <button
                        onClick={() => { setVideoError(null); setActiveServerIdx(0); }}
                        className="px-5 py-2.5 bg-white/10 hover:bg-white/20 text-neutral-300 text-xs font-semibold rounded-xl transition cursor-pointer"
                      >
                        Reintentar
                      </button>
                    </div>
                  )}
                </div>
              ) : (isEmbed || Boolean(embedUrlWithTime)) && !useResolvedPlayer ? (
                <div ref={playerWrapperRef} className="w-full h-full relative overflow-hidden shadow-2xl bg-black flex items-center justify-center">
                  <iframe
                    key={embedUrlWithTime}
                    src={embedUrlWithTime}
                    className={`w-full border-0 ${
                      ((embedUrlWithTime || activeServer.url) || "").includes("drive.google.com")
                        ? "h-[calc(100%+56px)] -mt-[56px]"
                        : "h-full"
                    }`}
                    allowFullScreen
                    // @ts-ignore
                    webkitallowfullscreen="true"
                    // @ts-ignore
                    mozallowfullscreen="true"
                    allow="autoplay *; fullscreen *; encrypted-media *; picture-in-picture *; clipboard-write *; accelerometer *; gyroscope *"
                    title={activeServer.name}
                  />

                  {/* Top Header Mask for Drive Preview (Prevents seeing Google Drive header & popout button) */}
                  {((embedUrlWithTime || activeServer.url) || "").includes("drive.google.com") && (
                    <div className="absolute top-0 left-0 right-0 h-14 bg-gradient-to-b from-neutral-950/80 to-transparent pointer-events-none z-10" />
                  )}

                  {/* Solid MegaAnime Floating Watermark Covering Third-Party Watermarks */}
                  <div 
                    className="absolute top-2.5 right-3 sm:top-4 sm:right-5 z-20 pointer-events-none select-none flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-neutral-950/95 border border-white/15 shadow-2xl backdrop-blur-md"
                    style={{ minWidth: "145px" }}
                    title="megaAnime PRO HD"
                  >
                    <span className="text-xs sm:text-sm font-black text-rose-500 tracking-tight drop-shadow-sm">
                      mega<span className="text-white">Anime</span>
                    </span>
                    <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-rose-600 text-white leading-none tracking-wider">
                      PRO HD
                    </span>
                  </div>

                </div>
              ) : (

                 <div 
                  ref={playerWrapperRef}
                  className={`w-full h-full relative overflow-hidden bg-black flex items-center justify-center group ${
                    !showControls ? "cursor-none" : ""
                  }`}
                >
                  <video
                    ref={videoRef}
                    src={resolvedStreamUrl}
                    className={`w-full h-full max-h-full object-contain ${
                      !showControls ? "cursor-none" : "cursor-pointer"
                    }`}
                    controls={false}
                    autoPlay
                    playsInline
                    onClick={togglePlay}
                    onDoubleClick={toggleFullscreen}
                    onTimeUpdate={() => {
                      if (videoRef.current) {
                        const time = videoRef.current.currentTime;
                        setCurrentTime(time);
                        lastTimeRef.current = time;
                      }
                    }}
                    onLoadedMetadata={() => {
                      if (videoRef.current) {
                        const dur = videoRef.current.duration;
                        setDuration(dur);
                        lastDurationRef.current = dur;
                        setIsPlaying(!videoRef.current.paused);
                      }
                    }}
                    onError={() => {
                      console.warn(`[Auto-Player] Direct video stream error on server #${activeServerIdx + 1}. Triggering fallback.`);
                      handleVideoError();
                    }}
                  />
                  
                    {/* Interactive YouTube-style Double Tap & Click Zones */}
                    <div className="absolute inset-0 grid grid-cols-3 z-10">
                      {/* Left Zone: Double tap to Rewind 10s */}
                      <div 
                        onClick={() => handleZoneClick("left")} 
                        className="h-full w-full cursor-pointer active:bg-white/5 transition-colors select-none"
                        title="Doble clic / toque: Retroceder 10s"
                      />
                      {/* Center Zone: Play / Pause */}
                      <div 
                        onClick={() => handleZoneClick("center")} 
                        className="h-full w-full cursor-pointer select-none"
                        title="Pausar / Reproducir"
                      />
                      {/* Right Zone: Double tap to Forward 10s */}
                      <div 
                        onClick={() => handleZoneClick("right")} 
                        className="h-full w-full cursor-pointer active:bg-white/5 transition-colors select-none"
                        title="Doble clic / toque: Adelantar 10s"
                      />
                    </div>

                    {/* YouTube-Style Center Animated Rewind Ripple */}
                    {seekFeedback === "rewind" && (
                      <div className="absolute left-10 sm:left-20 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center p-4 sm:p-5 rounded-full bg-black/80 text-rose-400 border border-rose-500/30 backdrop-blur-md shadow-2xl animate-scale-up pointer-events-none z-30">
                        <RotateCcw className="h-8 w-8 sm:h-10 sm:w-10 animate-spin" />
                        <span className="text-xs sm:text-sm font-black text-white mt-1">-{seekSeconds}s</span>
                      </div>
                    )}

                    {/* YouTube-Style Center Animated Forward Ripple */}
                    {seekFeedback === "forward" && (
                      <div className="absolute right-10 sm:right-20 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center p-4 sm:p-5 rounded-full bg-black/80 text-rose-400 border border-rose-500/30 backdrop-blur-md shadow-2xl animate-scale-up pointer-events-none z-30">
                        <RotateCw className="h-8 w-8 sm:h-10 sm:w-10 animate-spin" />
                        <span className="text-xs sm:text-sm font-black text-white mt-1">+{seekSeconds}s</span>
                      </div>
                    )}
                  
                    {/* Center Play/Pause Animated Feedback */}
                    {showCenterFeedback && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/25 pointer-events-none z-10 animate-ping">
                        <div className="p-5 rounded-full bg-black/60 text-rose-500">
                          {showCenterFeedback === "play" ? (
                            <Play className="h-10 w-10 fill-rose-500" />
                          ) : (
                            <Pause className="h-10 w-10 fill-rose-500" />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Solid MegaAnime Floating Watermark Covering Third-Party Watermarks */}
                    <div 
                      className="absolute top-2.5 right-3 sm:top-4 sm:right-5 z-20 pointer-events-none select-none flex items-center justify-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-neutral-950/95 border border-white/15 shadow-2xl backdrop-blur-md"
                      style={{ minWidth: "145px" }}
                      title="megaAnime PRO HD"
                    >
                      <span className="text-xs sm:text-sm font-black text-rose-500 tracking-tight drop-shadow-sm">
                        mega<span className="text-white">Anime</span>
                      </span>
                      <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-rose-600 text-white leading-none tracking-wider">
                        PRO HD
                      </span>
                    </div>

                    {/* Skip Intro Floating Overlay */}
                    {currentTime >= 85 && currentTime <= 175 && (
                      <button
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = 175;
                            setCurrentTime(175);
                          }
                        }}
                        className="absolute bottom-20 right-6 px-6 py-3 bg-rose-600/90 hover:bg-rose-500 text-white font-extrabold text-xs rounded-xl shadow-2xl border border-rose-500/20 backdrop-blur-md transition hover:scale-105 cursor-pointer z-30"
                      >
                        Omitir Introducción (Skip Intro)
                      </button>
                    )}

                    {/* Modern Floating "Siguiente Episodio" Card (MegaAnime Premium Style) */}
                    {showNextEpPrompt && hasNext && (
                      <div className="absolute bottom-24 right-4 sm:right-6 w-[90vw] sm:w-84 max-w-sm rounded-2xl bg-neutral-950/95 border border-rose-500/40 p-4 shadow-2xl shadow-rose-950/60 backdrop-blur-2xl animate-slide-up z-30 flex flex-col gap-3">
                        {/* Header: Badge & Countdown Timer */}
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-black text-rose-400 uppercase tracking-widest flex items-center gap-1.5">
                            <Sparkles className="h-3.5 w-3.5 text-rose-500 animate-pulse" />
                            Siguiente Capítulo
                          </span>
                          <span className="text-[11px] font-mono font-bold text-white bg-rose-600/30 border border-rose-500/40 px-2 py-0.5 rounded-full">
                            en {nextEpCountdown}s
                          </span>
                        </div>

                        {/* Middle: Episode Thumbnail & Info */}
                        <div className="flex items-center gap-3">
                          <div className="relative w-20 h-14 rounded-xl overflow-hidden bg-neutral-900 border border-white/10 flex-shrink-0">
                            <img
                              src={nextEpisodeObj?.coverUrl || animeCoverUrl}
                              alt="Siguiente episodio"
                              className="w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                              <Play className="h-4 w-4 text-white fill-white/80" />
                            </div>
                          </div>
                          <div className="min-w-0 flex-1 text-left">
                            <p className="text-xs font-black text-white truncate">
                              Capítulo {nextEpisodeObj?.number ?? (episodeNumber ? episodeNumber + 1 : "")}
                            </p>
                            <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                              {nextEpisodeObj?.title || animeTitle}
                            </p>
                            <span className="inline-block text-[9px] font-bold text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded border border-emerald-500/20 mt-1">
                              1080p • Audio Original
                            </span>
                          </div>
                        </div>

                        {/* Linear Progress Countdown Bar */}
                        <div className="w-full bg-neutral-800/80 rounded-full h-1 overflow-hidden">
                          <div
                            className="bg-gradient-to-r from-rose-500 to-pink-500 h-full transition-all duration-1000 ease-linear rounded-full"
                            style={{ width: `${(nextEpCountdown / 10) * 100}%` }}
                          />
                        </div>

                        {/* Action Buttons */}
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => onNavigateEpisode("next")}
                            className="flex-1 py-2 px-3 bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-rose-600/30 transition flex items-center justify-center gap-1.5 cursor-pointer active:scale-95"
                          >
                            <Play className="h-3.5 w-3.5 fill-white" />
                            <span>Ver Ahora</span>
                          </button>
                          <button
                            onClick={() => setShowNextEpPrompt(false)}
                            className="py-2 px-3 bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-white font-bold text-xs rounded-xl border border-white/10 transition cursor-pointer"
                          >
                            ✕ Cancelar
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Premium Custom Control Bar */}
                    <div className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/85 to-transparent px-4 sm:px-6 pb-4 sm:pb-6 pt-16 flex flex-col gap-3 transition-all duration-300 z-20 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                      
                      {/* Scrub Progress Bar with integrated Time Display */}
                      <div className="flex items-center gap-3 w-full">
                        <span className="text-[11px] text-neutral-200 font-mono select-none font-bold">
                          {formatTime(currentTime)}
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={duration || 100}
                          value={currentTime}
                          onChange={(e) => {
                            const time = parseFloat(e.target.value);
                            if (videoRef.current) {
                              videoRef.current.currentTime = time;
                            }
                            setCurrentTime(time);
                          }}
                          className="flex-grow h-1.5 rounded-lg appearance-none bg-neutral-800 accent-rose-500 cursor-pointer focus:outline-none"
                        />
                        <span className="text-[11px] text-neutral-400 font-mono select-none font-medium">
                          {formatTime(duration)}
                        </span>
                      </div>

                      {/* Actions and Indicators Row */}
                      <div className="flex items-center justify-between">
                        {/* Left: Playback controls, Previous/Next Ep, Volume */}
                        <div className="flex items-center gap-2.5 sm:gap-4">
                          {/* Previous Episode Button */}
                          <button
                            onClick={() => onNavigateEpisode("prev")}
                            disabled={!hasPrev}
                            className={`text-neutral-400 hover:text-white cursor-pointer transition ${!hasPrev ? 'opacity-30 cursor-not-allowed' : ''}`}
                            title="Capítulo Anterior"
                          >
                            <SkipBack className="h-4.5 w-4.5" />
                          </button>

                          {/* Play / Pause */}
                          <button
                            onClick={togglePlay}
                            className="text-neutral-400 hover:text-white cursor-pointer transition"
                            title={isPlaying ? "Pausar" : "Reproducir"}
                          >
                            {isPlaying ? <Pause className="h-5 w-5 fill-white text-white" /> : <Play className="h-5 w-5 fill-white text-white" />}
                          </button>

                          {/* Next Episode Button */}
                          <button
                            onClick={() => onNavigateEpisode("next")}
                            disabled={!hasNext}
                            className={`text-neutral-400 hover:text-white cursor-pointer transition ${!hasNext ? 'opacity-30 cursor-not-allowed' : ''}`}
                            title="Capítulo Siguiente"
                          >
                            <SkipForward className="h-4.5 w-4.5" />
                          </button>

                          {/* Rewind / Forward 10s */}
                          <button
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10);
                              }
                            }}
                            className="text-neutral-400 hover:text-white cursor-pointer transition hidden sm:inline-flex"
                            title="Retroceder 10s"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </button>

                          <button
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.currentTime = Math.min(duration, videoRef.current.currentTime + 10);
                              }
                            }}
                            className="text-neutral-400 hover:text-white cursor-pointer transition hidden sm:inline-flex"
                            title="Adelantar 10s"
                          >
                            <RotateCw className="h-4 w-4" />
                          </button>

                          {/* Mute and Volume bar */}
                          <div className="flex items-center gap-2 group/volume">
                            <button
                              onClick={toggleMute}
                              className="text-neutral-400 hover:text-white cursor-pointer transition"
                            >
                              {isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                            </button>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={isMuted ? 0 : volume}
                              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                              className="w-0 group-hover/volume:w-16 h-1 rounded-lg appearance-none bg-neutral-800 accent-rose-500 cursor-pointer focus:outline-none transition-all duration-300 hidden sm:block"
                            />
                          </div>
                        </div>

                        {/* Right: navigation buttons and full-screen */}
                        <div className="flex items-center gap-3 sm:gap-4">
                          {/* Share Exact Timestamp */}
                          <button
                            onClick={() => {
                              const seconds = Math.floor(currentTime);
                              const url = new URL(window.location.href);
                              url.searchParams.set("t", seconds.toString());
                              navigator.clipboard.writeText(url.toString());
                              setCopiedTimestamp(true);
                              setTimeout(() => setCopiedTimestamp(false), 2500);
                            }}
                            className="text-neutral-400 hover:text-white cursor-pointer transition flex items-center gap-1 text-xs"
                            title="Copiar enlace con minuto exacto"
                          >
                            {copiedTimestamp ? (
                              <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                                <Check className="h-4 w-4" />
                                ¡Copiado!
                              </span>
                            ) : (
                              <Share2 className="h-4.5 w-4.5" />
                            )}
                          </button>

                          {/* Chromecast */}
                          <button
                            onClick={() => alert("Chromecast listo: abre esta página en un navegador compatible con Cast para transmitir a tu TV.")}
                            className="text-neutral-400 hover:text-white cursor-pointer transition"
                            title="Transmitir a Chromecast"
                          >
                            <Cast className="h-4.5 w-4.5" />
                          </button>

                          {/* AirPlay */}
                          <button
                            onClick={() => {
                              if (videoRef.current && (videoRef.current as any).webkitShowPlaybackTargetPicker) {
                                (videoRef.current as any).webkitShowPlaybackTargetPicker();
                              } else {
                                alert("AirPlay no está disponible en este navegador/dispositivo.");
                              }
                            }}
                            className="text-neutral-400 hover:text-white cursor-pointer transition"
                            title="Transmitir con AirPlay"
                          >
                            <Tv className="h-4.5 w-4.5" />
                          </button>

                          {/* Report Problem Button */}
                          <button
                            onClick={() => {
                              setReportSubmittedSuccess(false);
                              setShowReportModal(true);
                            }}
                            className="text-neutral-400 hover:text-rose-400 cursor-pointer transition flex items-center gap-1 text-xs"
                            title="Reportar problema con este reproductor"
                          >
                            <Flag className="h-4.5 w-4.5" />
                          </button>

                          {/* Fullscreen Button */}
                          <button
                            onClick={toggleFullscreen}
                            className="text-neutral-400 hover:text-white cursor-pointer transition"
                            title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                          >
                            {isFullscreen ? <Minimize className="h-5 w-5" /> : <Maximize className="h-5 w-5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-8 text-center space-y-4 max-w-md mx-auto my-auto py-16">
              <div className="h-16 w-16 rounded-2xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shadow-xl shadow-rose-500/5 animate-pulse">
                <Sparkles className="h-8 w-8" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-lg font-bold text-white tracking-wide">Próximamente / Servidores en Actualización</h3>
                <p className="text-xs text-neutral-400 leading-relaxed">
                  Este episodio se encuentra en proceso de emisión o actualización en los servidores de transmisión. Te invitamos a consultar nuevamente en breve o seleccionar otro episodio.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-3 pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-all shadow-lg shadow-rose-600/20 cursor-pointer"
                >
                  Volver a la lista de episodios
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 🎬 Unified Details Feed (Designed in MegaAnime Brand Theme for Web & App) */}
        <div className="w-full max-w-5xl mx-auto bg-neutral-950 px-4 sm:px-6 py-6 space-y-5 pb-28 text-left">
          {/* Header Anime & Episode Title */}
          <div>
            <span className="text-xs font-black text-rose-500 tracking-wide uppercase">
              {resolvedTitle}
            </span>
            <h1 className="text-base sm:text-xl font-black text-white mt-0.5 tracking-tight">
              {displayTitle}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400 mt-2 font-medium">
              <span className="px-1.5 py-0.5 rounded bg-neutral-800 text-[10px] font-black text-neutral-300">14+</span>
              <span>•</span>
              <span>Subtitulado</span>
              <span>•</span>
              <span className="text-emerald-400 font-bold flex items-center gap-1">
                <Sparkles className="h-3 w-3" />
                1080p Ultra HD
              </span>
              {hasDriveServer && (
                <>
                  <span>•</span>
                  <span className="text-rose-400 font-semibold">Sin Anuncios</span>
                </>
              )}
            </div>
          </div>

          {/* Quick Episode Navigation Bar (Anterior / Siguiente) */}
          {(() => {
            let currentEpNum = 1;
            const numMatch = (episodeId || "").match(/(?:ep|episodio)-(\d+)/i);
            if (numMatch) currentEpNum = parseInt(numMatch[1], 10);

            const isMovie = contentType === "movie" || (genres && genres.includes("Película"));
            const effectiveHasPrev = hasPrev !== undefined ? (hasPrev || currentEpNum > 1) : currentEpNum > 1;
            const effectiveHasNext = isMovie ? false : (hasNext !== undefined ? (hasNext || true) : true);

            return (
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={() => onNavigateEpisode("prev")}
                  disabled={!effectiveHasPrev}
                  className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-2 ${
                    effectiveHasPrev 
                      ? "bg-neutral-900 border-white/10 text-neutral-200 hover:text-white hover:border-white/20 active:scale-95 cursor-pointer shadow" 
                      : "bg-neutral-950 border-white/5 text-neutral-600 opacity-40 cursor-not-allowed"
                  }`}
                >
                  <SkipBack className="h-4 w-4" />
                  <span>Capítulo Anterior</span>
                </button>

                <button
                  onClick={() => onNavigateEpisode("next")}
                  disabled={!effectiveHasNext}
                  className={`flex-1 py-2.5 px-4 rounded-xl text-xs font-black border transition flex items-center justify-center gap-2 ${
                    effectiveHasNext 
                      ? "bg-rose-600 border-rose-500 text-white shadow-lg shadow-rose-600/20 hover:bg-rose-500 active:scale-95 cursor-pointer" 
                      : "bg-neutral-950 border-white/5 text-neutral-600 opacity-40 cursor-not-allowed"
                  }`}
                >
                  <span>Siguiente Capítulo</span>
                  <SkipForward className="h-4 w-4" />
                </button>
              </div>
            );
          })()}

          {/* Synopsis with Expand Toggle */}
          <div className="space-y-1 text-xs sm:text-sm">
            <p className={`text-neutral-300 leading-relaxed ${isSynopsisExpanded ? "" : "line-clamp-2"}`}>
              {synopsisText}
            </p>
            <button
              onClick={() => setIsSynopsisExpanded(!isSynopsisExpanded)}
              className="font-bold text-rose-500 hover:text-rose-400 text-xs transition cursor-pointer"
            >
              {isSynopsisExpanded ? "... Ver menos" : "... Ver más"}
            </button>
          </div>

          {/* 🎬 Siguiente Episodio Card (Next Episode in MegaAnime theme) */}
          {hasNext && (
            <div className="pt-3 border-t border-white/10 space-y-2">
              <h3 className="text-xs font-extrabold text-neutral-400 uppercase tracking-wider">
                Siguiente Episodio (Next Episode)
              </h3>
              
              <div
                onClick={() => onNavigateEpisode("next")}
                className="w-full p-3 rounded-2xl bg-neutral-900/90 border border-white/10 hover:border-rose-500/40 transition-all flex items-center gap-4 cursor-pointer group shadow-lg active:scale-[0.98]"
              >
                {/* 16:9 Thumbnail preview */}
                <div className="relative w-36 sm:w-44 aspect-video rounded-xl overflow-hidden bg-black flex-shrink-0">
                  <img
                    src={getProxyImageUrl(resolvedCover, resolvedTitle)}
                    alt="Next Episode"
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <div className="h-8 w-8 rounded-full bg-rose-600 text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition">
                      <Play className="h-4 w-4 fill-white ml-0.5" />
                    </div>
                  </div>
                  <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-black text-white">
                    24m
                  </span>
                </div>

                {/* Info */}
                <div className="flex-grow min-w-0">
                  <h4 className="text-xs sm:text-sm font-black text-white truncate group-hover:text-rose-400 transition">
                    {nextEpisodeObj?.title || `Capítulo ${episodeNumber + 1}`}
                  </h4>
                  <p className="text-[11px] text-neutral-400 mt-1">
                    Audio Japonés | Subtitulado al Español
                  </p>
                </div>

                {/* Next button */}
                <div className="h-9 w-9 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 group-hover:bg-rose-500 group-hover:text-white transition flex-shrink-0">
                  <ArrowRight className="h-4.5 w-4.5" />
                </div>
              </div>

              {/* All Episodes button */}
              <div className="text-center pt-2">
                <button
                  onClick={() => setShowAllEpisodesSheet(true)}
                  className="text-xs font-black text-rose-500 hover:text-rose-400 hover:underline cursor-pointer tracking-wide"
                >
                  Ver Todos los Episodios ({allEpisodes.length > 0 ? allEpisodes.length : "Lista Completa"})
                </button>
              </div>
            </div>
          )}

          {/* Estado de Servidores: Servidor Oficial Drive vs Servidores Externos */}
          {hasDriveServer ? (
            <div className="pt-3 border-t border-white/10">
              <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-gradient-to-r from-rose-950/30 to-violet-950/20 border border-rose-500/40 text-rose-300 shadow-lg">
                <Sparkles className="h-4.5 w-4.5 text-rose-400 animate-pulse flex-shrink-0" />
                <div className="text-xs">
                  <span className="font-extrabold text-white block">⚡ Servidor Exclusivo MegaAnime — Sin Anuncios</span>
                  <span className="text-[10px] text-neutral-400">Reproduciendo en 1080p desde nuestros servidores dedicados. Sin anuncios ni interrupciones.</span>
                </div>
              </div>
            </div>
          ) : servers.length > 1 ? (
            <div className="pt-3 border-t border-white/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-extrabold text-neutral-400 uppercase tracking-widest flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-rose-500" />
                  Servidores Disponibles
                </span>
                <span className="text-[11px] text-neutral-500 font-mono">
                  {servers.length} opciones
                </span>
              </div>

              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {servers.map((srv, idx) => (
                  <button
                    key={idx}
                    onClick={() => setActiveServerIdx(idx)}
                    className={`px-3.5 py-2 rounded-xl text-xs font-extrabold whitespace-nowrap border transition cursor-pointer flex items-center gap-1.5 ${
                      activeServerIdx === idx
                        ? "bg-rose-600 border-rose-500 text-white shadow-lg shadow-rose-600/30"
                        : "bg-neutral-900 border-white/10 text-neutral-400 hover:border-neutral-700 hover:text-white"
                    }`}
                  >
                    <Server className="h-3.5 w-3.5" />
                    <span>{srv.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Mobile & Web Comments Section */}
          <div className="pt-4 border-t border-white/10">
            <CommentSection
              targetId={episodeId}
              title={`Comentarios del Capítulo ${episodeNumber}`}
              currentUser={currentUser}
            />
          </div>
        </div>

        {/* All Episodes Bottom Sheet / Modal */}
        {showAllEpisodesSheet && (
          <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-neutral-900 border-t border-white/10 rounded-t-3xl p-5 max-h-[75vh] flex flex-col space-y-4 shadow-2xl animate-slide-up max-w-3xl mx-auto w-full">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <Film className="h-4.5 w-4.5 text-rose-500" />
                  <h3 className="text-sm font-black text-white">Todos los Episodios ({allEpisodes.length})</h3>
                </div>
                <button
                  onClick={() => setShowAllEpisodesSheet(false)}
                  className="p-1 rounded-full bg-white/5 text-neutral-400 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {allEpisodes.map((ep, idx) => {
                  const isCurr = ep.id === episodeId;
                  return (
                    <button
                      key={ep.id || idx}
                      onClick={() => {
                        setShowAllEpisodesSheet(false);
                        const epNum = ep.number || idx + 1;
                        onNavigateEpisode(epNum > episodeNumber ? "next" : "prev");
                      }}
                      className={`p-3 rounded-xl border text-left transition flex items-center justify-between ${
                        isCurr
                          ? "bg-rose-500/15 border-rose-500/40 text-rose-400 font-extrabold"
                          : "bg-neutral-950/60 border-white/5 text-neutral-300 hover:border-white/20"
                      }`}
                    >
                      <span className="text-xs truncate">{ep.title || `Capítulo ${idx + 1}`}</span>
                      {isCurr && <span className="text-[10px] bg-rose-500 text-white px-1.5 py-0.5 rounded-full">Viendo</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* User Report Problem Modal */}
        {showReportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
            <div className="bg-neutral-900 border border-white/10 rounded-2xl p-6 max-w-md w-full shadow-2xl relative space-y-4">
              <button 
                onClick={() => setShowReportModal(false)}
                className="absolute top-4 right-4 text-neutral-400 hover:text-white p-1 rounded-lg transition"
              >
                <X className="h-5 w-5" />
              </button>

              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 border border-rose-500/20">
                  <AlertTriangle className="h-6 w-6" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Reportar problema con el video</h3>
                  <p className="text-xs text-neutral-400">Servidor actual: <span className="text-rose-400 font-semibold">{servers[activeServerIdx]?.name || "Reproductor"}</span></p>
                </div>
              </div>

              {reportSubmittedSuccess ? (
                <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 text-center space-y-2 py-6">
                  <div className="h-10 w-10 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto">
                    <Check className="h-6 w-6" />
                  </div>
                  <h4 className="text-sm font-bold text-emerald-400">¡Reporte Enviado!</h4>
                  <p className="text-xs text-neutral-300">Gracias por informarnos. Nuestro equipo técnico revisará el reproductor en breve.</p>
                  <button
                    onClick={() => setShowReportModal(false)}
                    className="mt-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white font-bold text-xs rounded-xl transition"
                  >
                    Cerrar
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-xs text-neutral-300">Selecciona el inconveniente que estás experimentando para enviarlo a los administradores:</p>
                  
                  <div className="space-y-2">
                    {[
                      "El reproductor no carga / Enlace caído",
                      "El servidor va muy lento o se traba",
                      "Audio o subtítulos desincronizados",
                      "El episodio o video es incorrecto"
                    ].map((reason) => (
                      <label 
                        key={reason}
                        className={`flex items-center gap-3 p-3 rounded-xl border transition cursor-pointer text-xs ${
                          selectedReportReason === reason 
                            ? "bg-rose-500/15 border-rose-500 text-white font-semibold" 
                            : "bg-neutral-800/60 border-white/5 text-neutral-300 hover:bg-neutral-800"
                        }`}
                      >
                        <input 
                          type="radio" 
                          name="reportReason" 
                          value={reason}
                          checked={selectedReportReason === reason}
                          onChange={(e) => setSelectedReportReason(e.target.value)}
                          className="accent-rose-500"
                        />
                        <span>{reason}</span>
                      </label>
                    ))}
                  </div>

                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => setShowReportModal(false)}
                      className="flex-1 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-bold text-xs rounded-xl transition"
                    >
                      Cancelar
                    </button>
                    <button
                      disabled={isSubmittingReport}
                      onClick={async () => {
                        setIsSubmittingReport(true);
                        await sendUserReport({
                          animeId,
                          episodeId,
                          animeTitle: resolvedTitle,
                          episodeNumber: episodeNumber || 1,
                          serverName: servers[activeServerIdx]?.name || "Desconocido",
                          reason: selectedReportReason
                        });
                        setIsSubmittingReport(false);
                        setReportSubmittedSuccess(true);
                      }}
                      className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs rounded-xl transition shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2"
                    >
                      {isSubmittingReport ? "Enviando..." : "Enviar Reporte"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
