import React, { useState, useMemo, useRef, useEffect } from "react";
import { 
  X, 
  Play, 
  Heart, 
  Star, 
  Calendar, 
  ArrowUpDown, 
  Clock, 
  ChevronDown, 
  ChevronLeft,
  ChevronRight,
  BookOpen, 
  Film, 
  Download, 
  CheckCircle, 
  RefreshCw, 
  Sparkles,
  LayoutGrid,
  List,
  Search,
  Tv,
  ArrowDown,
  Flame,
  Check
} from "lucide-react";
import { Anime, Episode, Manga, User } from "../types";
import { getAnimePlaceholder, getProxyImageUrl, recoverCoverImageInHotPath } from "../utils/imageUtils";
import { getAnimesWithEpisodes, getBaseTitle, generateEpisodesForAnime, getAvailableEpisodesCountForAiring } from "../utils/animeDb";
import { getApiUrl } from "../utils/apiConfig";
import { syncEpisodeProgress, PlaybackProgress, syncAllEpisodesProgressFromFirestore, getCanonicalEpisodeKey, normalizeAnimeId, saveEpisodeProgress } from "../utils/progress";
import { saveEpisodeDownload, isEpisodeDownloaded, deleteEpisodeDownload } from "../utils/downloadDb";
import { collection, query, where, orderBy, getDocs, addDoc } from "firebase/firestore";
import { db } from "../lib/firebase";
import CommentSection from "./CommentSection";

interface AnimeDetailProps {
  anime: Anime;
  onClose: () => void;
  onPlayEpisode: (episodeId: string) => void;
  isFavorite: boolean;
  onToggleFavorite: (animeId: string) => void;
  onSelectAnime?: (anime: Anime) => void;
  onSelectManga?: (manga: Manga) => void;
  currentUser?: User | null;
}

export default function AnimeDetail({
  anime: initialAnime,
  onClose,
  onPlayEpisode,
  isFavorite,
  onToggleFavorite,
  onSelectAnime,
  onSelectManga,
  currentUser = null
}: AnimeDetailProps) {
  const [activeTab, setActiveTab] = useState<"capitulos" | "info" | "reseñas">("capitulos");
  const [ascending, setAscending] = useState(true);
  const [currentAnime, setCurrentAnime] = useState<Anime>(initialAnime);
  const [showSeasonSelector, setShowSeasonSelector] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [isSynopsisExpanded, setIsSynopsisExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");
  const [searchQuery, setSearchQuery] = useState("");

  const episodesSectionRef = useRef<HTMLDivElement>(null);
  const chipsContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll active chip into view
  useEffect(() => {
    if (chipsContainerRef.current) {
      const activeEl = chipsContainerRef.current.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    }
  }, [currentPage]);

  // Downloads states
  const [downloadStates, setDownloadStates] = useState<Record<string, "idle" | "downloading" | "downloaded">>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});

  const [playbackProgress, setPlaybackProgress] = useState<PlaybackProgress | null>(null);
  const [allProgress, setAllProgress] = useState<Record<string, PlaybackProgress>>({});

  // Reviews & Comments states
  const [reviews, setReviews] = useState<any[]>([]);
  const [newComment, setNewComment] = useState("");
  const [newRating, setNewRating] = useState(5);
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState("");

  // ESC key listener to close modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Load reviews on anime change
  useEffect(() => {
    async function loadReviews() {
      if (!currentAnime || !currentAnime.id) return;
      try {
        const q = query(
          collection(db, "reviews"),
          where("animeId", "==", currentAnime.id),
          orderBy("createdAt", "desc")
        );
        const snapshot = await getDocs(q);
        const list: any[] = [];
        snapshot.forEach(doc => {
          list.push({ id: doc.id, ...doc.data() });
        });
        setReviews(list);
      } catch (err) {
        console.warn("Firestore reviews load failed, falling back to localStorage:", err);
        try {
          const cached = localStorage.getItem("megaAnime_local_reviews");
          if (cached) {
            const allLocal = JSON.parse(cached);
            const matching = allLocal.filter((r: any) => r.animeId === currentAnime.id);
            setReviews(matching);
          } else {
            setReviews([]);
          }
        } catch (e) {
          setReviews([]);
        }
      }
    }
    loadReviews();
  }, [currentAnime?.id]);

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setReviewError("");
    const commentText = newComment.trim();
    if (!commentText) {
      setReviewError("Por favor escribe un comentario.");
      return;
    }
    if (!currentUser) {
      setReviewError("Debes iniciar sesión para escribir una reseña.");
      return;
    }

    setSubmittingReview(true);
    const newRev = {
      animeId: currentAnime.id,
      userId: currentUser.id,
      username: currentUser.username || currentUser.email.split("@")[0],
      avatarUrl: currentUser.profiles?.find(p => p.id === currentUser.activeProfileId)?.avatarUrl || "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
      comment: commentText,
      rating: newRating,
      createdAt: new Date().toISOString()
    };

    try {
      const docRef = await addDoc(collection(db, "reviews"), newRev);
      const addedReview = { id: docRef.id, ...newRev };
      setReviews(prev => [addedReview, ...prev]);
      setNewComment("");
      setNewRating(5);
    } catch (err) {
      console.warn("Firestore save review failed, saving to localStorage fallback:", err);
      try {
        const addedReview = { id: `local_${Date.now()}`, ...newRev };
        const cached = localStorage.getItem("megaAnime_local_reviews");
        const allLocal = cached ? JSON.parse(cached) : [];
        allLocal.unshift(addedReview);
        localStorage.setItem("megaAnime_local_reviews", JSON.stringify(allLocal));
        setReviews(prev => [addedReview, ...prev]);
        setNewComment("");
        setNewRating(5);
      } catch (e) {
        setReviewError("No se pudo guardar la reseña. Inténtalo de nuevo.");
      }
    } finally {
      setSubmittingReview(false);
    }
  };

  const averageStars = useMemo(() => {
    if (reviews.length === 0) {
      return currentAnime.rating ? Math.round((currentAnime.rating / 2) * 10) / 10 : 4.5;
    }
    const total = reviews.reduce((sum, r) => sum + r.rating, 0);
    return Math.round((total / reviews.length) * 10) / 10;
  }, [reviews, currentAnime.rating]);

  // Sync and load viewing progress
  useEffect(() => {
    async function loadProgress() {
      if (currentAnime && currentAnime.id) {
        const progress = await syncEpisodeProgress(currentAnime.id, currentUser, currentAnime.title);
        setPlaybackProgress(progress);
      }
    }
    loadProgress();
  }, [currentAnime.id, currentUser]);

  // Load all progress to map individual episodes
  useEffect(() => {
    async function loadAllEpisodeProgress() {
      const progressMap = await syncAllEpisodesProgressFromFirestore(currentUser);
      setAllProgress(progressMap);
    }
    loadAllEpisodeProgress();
  }, [currentUser, playbackProgress]);

  // Toggle watched status manually
  const handleToggleWatched = async (e: React.MouseEvent, ep: Episode) => {
    e.stopPropagation();
    const epNum = ep.number || 1;
    const canonKey = getCanonicalEpisodeKey(normalizeAnimeId(currentAnime.id, currentAnime.title), epNum);
    const existing = allProgress[ep.id] || allProgress[canonKey];
    const isCurrentlyWatched = existing && existing.percentage >= 85;

    const newPercentage = isCurrentlyWatched ? 0 : 100;
    const newProgressSeconds = isCurrentlyWatched ? 0 : 1440;
    const durationSeconds = 1440;

    const updatedProg: PlaybackProgress = {
      animeId: currentAnime.id,
      episodeId: ep.id,
      episodeNumber: epNum,
      progressSeconds: newProgressSeconds,
      durationSeconds,
      percentage: newPercentage,
      updatedAt: new Date().toISOString(),
      contentType: isMovie ? "movie" : "anime",
      animeTitle: currentAnime.title,
      animeCoverUrl: currentAnime.coverUrl
    };

    setAllProgress(prev => ({
      ...prev,
      [ep.id]: updatedProg,
      [canonKey]: updatedProg
    }));

    if (currentUser) {
      await saveEpisodeProgress(
        currentAnime.id,
        ep.id,
        epNum,
        newProgressSeconds,
        durationSeconds,
        currentUser,
        true,
        isMovie ? "movie" : "anime",
        currentAnime.title,
        currentAnime.coverUrl
      );
    }
  };

  // Reset page index when anime or order changes
  useEffect(() => {
    setCurrentPage(0);
    setSearchQuery("");
  }, [currentAnime.id, ascending]);

  // Sync state if props change
  useEffect(() => {
    if (initialAnime && initialAnime.title) {
      setCurrentAnime(initialAnime);
    }
  }, [initialAnime]);

  // Fetch fresh details for currentAnime if its episodes are empty
  useEffect(() => {
    if (currentAnime && currentAnime.id && (!currentAnime.episodes || currentAnime.episodes.length === 0)) {
      fetch(getApiUrl(`/api/anime/${currentAnime.id}`), { signal: AbortSignal.timeout(5000) })
        .then(res => res.json())
        .then(data => {
          if (data && !data.error) {
            setCurrentAnime(prev => {
              if (prev.id !== currentAnime.id) return prev;
              const merged = {
                ...prev,
                ...data,
                seasons: prev.seasons || data.seasons,
                episodes: Array.isArray(data.episodes) && data.episodes.length > 0 ? data.episodes : generateEpisodesForAnime(prev)
              };
              return merged;
            });
          }
        })
        .catch(err => {
          console.warn("Failed to fetch season details in AnimeDetail:", err);
          setCurrentAnime(prev => ({
            ...prev,
            episodes: generateEpisodesForAnime(prev)
          }));
        });
    }
  }, [currentAnime.id]);

  // Load all anime once for related seasons matching
  const [allAnime] = useState(() => getAnimesWithEpisodes());

  // Find related seasons
  const relatedSeasons = useMemo(() => {
    if (initialAnime.seasons && initialAnime.seasons.length > 1) {
      return initialAnime.seasons;
    }
    if (currentAnime.seasons && currentAnime.seasons.length > 1) {
      return currentAnime.seasons;
    }
    const baseTitle = getBaseTitle(currentAnime.title).toLowerCase().trim();
    if (baseTitle) {
      const localMatches = allAnime.filter(a => getBaseTitle(a.title).toLowerCase().trim() === baseTitle);
      if (localMatches.length > 1) {
        return localMatches;
      }
    }
    return [];
  }, [currentAnime, initialAnime, allAnime]);

  // Generate episodes list
  const episodeList = useMemo(() => {
    const isAiring = currentAnime.status === "En emisión" || currentAnime.status === "RELEASING" || currentAnime.status === "Ongoing";
    
    const totalCount = isAiring
      ? Math.max(
          getAvailableEpisodesCountForAiring(currentAnime),
          currentAnime.airedEpisodesCount || 0,
          currentAnime.episodesCount || 0,
          currentAnime.episodes?.length || 0
        )
      : (currentAnime.episodesCount || currentAnime.episodes?.length || 12);

    const list: Episode[] = [];
    const realEpisodes = currentAnime.episodes || [];
    const realEpMap = new Map<number, Episode>();
    realEpisodes.forEach(ep => {
      if (ep.number !== undefined) {
        realEpMap.set(ep.number, ep);
      }
    });

    for (let i = 1; i <= totalCount; i++) {
      if (realEpMap.has(i)) {
        list.push(realEpMap.get(i)!);
      } else {
        list.push({
          id: `${currentAnime.id}-ep-${i}`,
          title: `Episodio ${i}`,
          number: i,
          animeId: currentAnime.id,
          animeTitle: currentAnime.title,
          coverUrl: currentAnime.coverUrl,
        });
      }
    }
    return list;
  }, [currentAnime]);

  const filteredEpisodes = useMemo(() => {
    let list = [...episodeList];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(ep => {
        const numStr = String(ep.number);
        const titleStr = (ep.title || "").toLowerCase();
        return numStr === q || numStr.includes(q) || titleStr.includes(q);
      });
    }
    if (!ascending) {
      list.reverse();
    }
    return list;
  }, [episodeList, ascending, searchQuery]);

  const episodesPerPage = 25;
  const totalPages = Math.ceil(filteredEpisodes.length / episodesPerPage);
  const activePage = currentPage >= totalPages ? 0 : currentPage;

  const paginatedEpisodes = useMemo(() => {
    if (searchQuery.trim()) {
      return filteredEpisodes;
    }
    const start = activePage * episodesPerPage;
    const end = start + episodesPerPage;
    return filteredEpisodes.slice(start, end);
  }, [filteredEpisodes, activePage, searchQuery]);

  const getPageLabel = (pageIndex: number) => {
    const startIdx = pageIndex * episodesPerPage;
    const endIdx = Math.min(startIdx + episodesPerPage, filteredEpisodes.length) - 1;
    const firstEp = filteredEpisodes[startIdx];
    const lastEp = filteredEpisodes[endIdx];
    
    if (!firstEp || !lastEp) return `Pág ${pageIndex + 1}`;
    
    const firstNum = firstEp.number;
    const lastNum = lastEp.number;
    
    if (firstNum !== undefined && lastNum !== undefined) {
      if (firstNum === lastNum) return `Cap. ${firstNum}`;
      return `${Math.min(firstNum, lastNum)} - ${Math.max(firstNum, lastNum)}`;
    }
    
    return `${startIdx + 1} - ${endIdx + 1}`;
  };

  // Check download status for visible episodes
  useEffect(() => {
    async function checkDownloads() {
      const states: Record<string, "idle" | "downloading" | "downloaded"> = {};
      for (const ep of paginatedEpisodes) {
        const isDownloaded = await isEpisodeDownloaded(ep.id);
        states[ep.id] = isDownloaded ? "downloaded" : "idle";
      }
      setDownloadStates(prev => ({ ...prev, ...states }));
    }
    checkDownloads();
  }, [paginatedEpisodes]);

  const handleDownloadEpisode = async (e: React.MouseEvent, ep: Episode) => {
    e.stopPropagation();
    const epId = ep.id;
    
    if (downloadStates[epId] === "downloaded") {
      if (confirm(`¿Deseas eliminar la descarga del capítulo ${ep.number}?`)) {
        await deleteEpisodeDownload(epId);
        setDownloadStates(prev => ({ ...prev, [epId]: "idle" }));
      }
      return;
    }

    if (downloadStates[epId] === "downloading") return;

    setDownloadStates(prev => ({ ...prev, [epId]: "downloading" }));
    setDownloadProgress(prev => ({ ...prev, [epId]: 0 }));

    try {
      let downloadUrl = "https://www.w3schools.com/html/mov_bbb.mp4";
      
      try {
        const res = await fetch(`/api/episode/${encodeURIComponent(epId)}`);
        if (res.ok) {
          const data = await res.json();
          const directServer = data.videoServers?.find((s: any) => {
            const lower = s.url.toLowerCase();
            return lower.endsWith(".mp4") || lower.endsWith(".m3u8") || lower.includes("mp4upload") || lower.includes("filemoon") || lower.includes("voe");
          });
          if (directServer) {
            downloadUrl = directServer.url;
          }
        }
      } catch (err) {
        console.warn("Could not retrieve custom video server for download", err);
      }

      const response = await fetch(`/api/download-proxy?url=${encodeURIComponent(downloadUrl)}`);
      if (!response.ok) throw new Error("Network response was not ok");
      
      const contentLength = response.headers.get("content-length");
      const totalBytes = contentLength ? parseInt(contentLength, 10) : 10 * 1024 * 1024;
      
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Could not get response stream reader");

      let receivedBytes = 0;
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value) {
          chunks.push(value);
          receivedBytes += value.length;
          const pct = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
          setDownloadProgress(prev => ({ ...prev, [epId]: pct }));
        }
      }

      const videoBlob = new Blob(chunks, { type: "video/mp4" });
      const sizeMB = Math.round((videoBlob.size / (1024 * 1024)) * 10) / 10;

      await saveEpisodeDownload(
        {
          id: epId,
          animeId: currentAnime.id,
          animeTitle: currentAnime.title,
          episodeNumber: ep.number,
          episodeTitle: ep.title && typeof ep.title === "string" ? ep.title.replace(currentAnime.title || "", "").replace(/^-/, "").trim() : `Episodio ${ep.number}`,
          coverUrl: ep.coverUrl || currentAnime.coverUrl,
          fileSizeMB: sizeMB || 10.5,
          downloadedAt: new Date().toISOString(),
        },
        videoBlob
      );

      setDownloadProgress(prev => ({ ...prev, [epId]: 100 }));
      setDownloadStates(prev => ({ ...prev, [epId]: "downloaded" }));
    } catch (err) {
      console.error("Download failed:", err);
      alert("Error al descargar el episodio. Por favor, inténtalo de nuevo.");
      setDownloadStates(prev => ({ ...prev, [epId]: "idle" }));
    }
  };

  const isMovie = currentAnime.type === "Película" || currentAnime.type === "Movie";

  // Determine smart primary action: Continue watching or Play Ep 1
  const resumeEpisodeNumber = playbackProgress?.episodeNumber || 1;
  const hasWatchedProgress = playbackProgress && (playbackProgress.percentage || 0) > 2;
  const targetPlayId = isMovie
    ? (episodeList[0]?.id || `${currentAnime.id}-ep-1`)
    : (hasWatchedProgress ? (playbackProgress?.episodeId || `${currentAnime.id}-ep-${resumeEpisodeNumber}`) : (episodeList[0]?.id || `${currentAnime.id}-ep-1`));

  const scrollToEpisodes = () => {
    setActiveTab("capitulos");
    setTimeout(() => {
      episodesSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/90 backdrop-blur-md flex justify-center items-start p-0 sm:p-4 md:p-6 lg:p-8 animate-fade-in scrollbar-thin scrollbar-thumb-rose-500/30 scrollbar-track-transparent">
      
      {/* Outer Click Backdrop Dismiss */}
      <div 
        className="fixed inset-0 -z-10 cursor-pointer" 
        onClick={onClose} 
        aria-hidden="true" 
      />

      {/* Main Single-Scroll Modal Container (Netflix / Crunchyroll Architecture) */}
      <div className="relative w-full max-w-5xl lg:max-w-6xl rounded-none sm:rounded-3xl border-0 sm:border border-white/10 bg-neutral-950 text-neutral-100 shadow-2xl overflow-hidden my-0 sm:my-4 flex flex-col min-h-screen sm:min-h-0">
        
        {/* Floating Top Close Button */}
        <button
          onClick={onClose}
          className="fixed sm:absolute top-4 right-4 sm:top-6 sm:right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-black/80 sm:bg-neutral-900/90 backdrop-blur-md border border-white/20 text-neutral-200 hover:text-white hover:bg-rose-600 hover:border-rose-500 transition-all duration-200 cursor-pointer shadow-2xl group hover:scale-105"
          title="Cerrar (Esc)"
        >
          <X className="h-5 w-5 transition-transform group-hover:rotate-90" />
        </button>

        {/* ── CINEMATIC HERO SECTION (Netflix / Crunchyroll Banner) ── */}
        <div className="relative w-full min-h-[420px] sm:min-h-[460px] md:min-h-[500px] flex flex-col justify-end p-6 sm:p-8 md:p-12 overflow-hidden">
          
          {/* Dynamic Backdrop Image with Gradient Scrims */}
          <div className="absolute inset-0 z-0">
            <img
              src={getProxyImageUrl(currentAnime.bannerUrl || currentAnime.coverUrl, currentAnime.title, true)}
              alt={currentAnime.title}
              className="w-full h-full object-cover object-center filter brightness-[0.45] scale-105 transform transition-transform duration-1000"
              referrerPolicy="no-referrer"
              onError={(e) => {
                recoverCoverImageInHotPath(e, currentAnime.title, currentAnime.id);
              }}
            />
            {/* Multi-directional smooth cinematic fades */}
            <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 via-neutral-950/70 to-neutral-950/20" />
            <div className="absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/50 to-transparent" />
          </div>

          {/* Hero Content Overlay */}
          <div className="relative z-10 max-w-3xl space-y-4">
            
            {/* Badges Row */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-black bg-rose-600/90 text-white tracking-wider uppercase backdrop-blur-md shadow-lg shadow-rose-600/30">
                <Flame className="h-3 w-3 fill-white" />
                {isMovie ? "Película de Anime" : "Serie de Anime"}
              </span>

              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-neutral-200 border border-white/15 backdrop-blur-md">
                1080p Full HD
              </span>

              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-neutral-200 border border-white/15 backdrop-blur-md">
                SUB Español
              </span>

              {currentAnime.status === "En emisión" && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40">
                  ● En Emisión
                </span>
              )}
            </div>

            {/* Anime Title */}
            <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black text-white leading-[1.1] tracking-tight drop-shadow-2xl">
              {currentAnime.title}
            </h1>

            {/* Metadata Rating / Year / Seasons Info */}
            <div className="flex flex-wrap items-center gap-3 text-xs sm:text-sm text-neutral-200 font-semibold drop-shadow-md">
              <span className="flex items-center gap-1 text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-lg border border-amber-400/20 font-bold">
                <Star className="h-4 w-4 fill-amber-400 text-amber-400" />
                {(Number(currentAnime.rating) || 0).toFixed(1)} / 10
              </span>

              <span className="text-neutral-400">•</span>
              <span className="text-neutral-300 font-bold">{currentAnime.year}</span>

              <span className="text-neutral-400">•</span>
              <span className="text-neutral-300 font-bold">
                {isMovie ? "Película Completa" : `${episodeList.length} Episodios`}
              </span>
            </div>

            {/* Synopsis with Smooth Expand */}
            <div className="text-neutral-300 text-xs sm:text-sm leading-relaxed max-w-2xl drop-shadow-md">
              <p className={isSynopsisExpanded ? "" : "line-clamp-2 sm:line-clamp-3"}>
                {currentAnime.synopsis || "Explora el maravilloso mundo de este anime. Conoce las historias de sus personajes, batallas y el destino de su gran viaje animado."}
              </p>
              {currentAnime.synopsis && currentAnime.synopsis.length > 160 && (
                <button
                  onClick={() => setIsSynopsisExpanded(!isSynopsisExpanded)}
                  className="text-rose-400 hover:text-rose-300 font-bold mt-1 text-xs cursor-pointer focus:outline-none flex items-center gap-1"
                >
                  <span>{isSynopsisExpanded ? "Ver menos" : "Leer sinopsis completa"}</span>
                </button>
              )}
            </div>

            {/* Main Action Buttons (Netflix & Crunchyroll Hero CTA) */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              
              {/* Primary Play / Continue Button */}
              <button
                onClick={() => onPlayEpisode(targetPlayId)}
                className="inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl bg-gradient-to-r from-rose-600 via-rose-500 to-rose-600 hover:from-rose-500 hover:to-rose-400 text-white font-black text-xs sm:text-sm tracking-wide uppercase transition-all duration-200 shadow-xl shadow-rose-600/30 cursor-pointer hover:scale-[1.03] active:scale-95"
              >
                <Play className="h-5 w-5 fill-white text-white" />
                <span>
                  {isMovie 
                    ? "Ver Película" 
                    : hasWatchedProgress 
                      ? `Continuar Ep. ${resumeEpisodeNumber} (${playbackProgress?.percentage || 0}%)`
                      : "Reproducir Ep. 1"}
                </span>
              </button>

              {/* Add to Favorites Button */}
              <button
                onClick={() => onToggleFavorite(currentAnime.id)}
                className={`inline-flex items-center gap-2 px-5 py-3.5 rounded-2xl border font-bold text-xs sm:text-sm tracking-wide uppercase transition-all duration-200 cursor-pointer active:scale-95 backdrop-blur-md ${
                  isFavorite
                    ? "bg-rose-500/20 border-rose-500/50 text-rose-400 shadow-lg shadow-rose-500/10"
                    : "bg-white/10 border-white/15 text-neutral-200 hover:bg-white/20 hover:text-white"
                }`}
              >
                <Heart className={`h-4.5 w-4.5 ${isFavorite ? "fill-rose-400 text-rose-400" : ""}`} />
                <span>{isFavorite ? "En Mi Lista" : "+ Mi Lista"}</span>
              </button>

              {/* Quick Jump to Episodes Button */}
              {!isMovie && (
                <button
                  onClick={scrollToEpisodes}
                  className="inline-flex items-center gap-2 px-4 py-3.5 rounded-2xl bg-neutral-900/80 hover:bg-neutral-800 border border-white/10 text-neutral-300 hover:text-white font-bold text-xs sm:text-sm tracking-wide transition cursor-pointer backdrop-blur-md"
                  title="Ver lista de episodios"
                >
                  <ArrowDown className="h-4 w-4 text-rose-400" />
                  <span>Ver Capítulos</span>
                </button>
              )}
            </div>

            {/* Running Watch Progress Bar in Hero */}
            {hasWatchedProgress && playbackProgress && (
              <div className="max-w-md pt-1">
                <div className="flex justify-between items-center text-[11px] text-neutral-400 mb-1.5 font-semibold">
                  <span className="text-rose-400 font-bold">Viendo Episodio {playbackProgress.episodeNumber}</span>
                  <span>{Math.round(playbackProgress.position / 60)} min / {Math.round(playbackProgress.duration / 60)} min</span>
                </div>
                <div className="w-full h-1.5 bg-neutral-800 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-gradient-to-r from-rose-600 to-rose-400 rounded-full transition-all duration-300"
                    style={{ width: `${playbackProgress.percentage}%` }}
                  />
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ── GENRES & TAGS BAR ── */}
        <div className="px-6 sm:px-8 md:px-12 py-3 bg-neutral-950/80 border-t border-b border-white/5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold text-neutral-500 uppercase tracking-wider mr-1">Géneros:</span>
          {(currentAnime.genres || []).map((g, idx) => (
            <span
              key={idx}
              className="rounded-full bg-white/5 border border-white/10 px-3 py-1 text-xs text-neutral-300 font-medium hover:bg-rose-500/20 hover:text-rose-300 hover:border-rose-500/30 transition cursor-pointer"
            >
              {g}
            </span>
          ))}
        </div>

        {/* ── MAIN CONTENT TABS (Crunchyroll & Netflix Header) ── */}
        <div ref={episodesSectionRef} className="px-6 sm:px-8 md:px-12 pt-6 pb-12 bg-neutral-950 flex flex-col space-y-6">
          
          {/* Main Tab Navigation Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
            
            <div className="flex items-center space-x-2 sm:space-x-4">
              <button
                onClick={() => setActiveTab("capitulos")}
                className={`pb-2 px-3 sm:px-4 font-black text-sm sm:text-base transition-all relative cursor-pointer flex items-center gap-2 ${
                  activeTab === "capitulos"
                    ? "text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span>{isMovie ? "Película" : "Episodios"}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  activeTab === "capitulos" ? "bg-rose-600 text-white" : "bg-neutral-800 text-neutral-400"
                }`}>
                  {isMovie ? 1 : episodeList.length}
                </span>
                {activeTab === "capitulos" && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-rose-500 rounded-full shadow-lg shadow-rose-500" />
                )}
              </button>

              <button
                onClick={() => setActiveTab("info")}
                className={`pb-2 px-3 sm:px-4 font-black text-sm sm:text-base transition-all relative cursor-pointer flex items-center gap-2 ${
                  activeTab === "info"
                    ? "text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span>Relacionados</span>
                {activeTab === "info" && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-rose-500 rounded-full shadow-lg shadow-rose-500" />
                )}
              </button>

              <button
                onClick={() => setActiveTab("reseñas")}
                className={`pb-2 px-3 sm:px-4 font-black text-sm sm:text-base transition-all relative cursor-pointer flex items-center gap-2 ${
                  activeTab === "reseñas"
                    ? "text-white"
                    : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <span>Reseñas</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                  activeTab === "reseñas" ? "bg-rose-600 text-white" : "bg-neutral-800 text-neutral-400"
                }`}>
                  {reviews.length}
                </span>
                {activeTab === "reseñas" && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-rose-500 rounded-full shadow-lg shadow-rose-500" />
                )}
              </button>
            </div>

            {/* Seasons Dropdown / Selector (If Multiple Seasons Exist) */}
            {relatedSeasons.length > 1 && !isMovie && (
              <div className="relative">
                <button
                  onClick={() => setShowSeasonSelector(!showSeasonSelector)}
                  className="flex items-center space-x-2 text-xs font-bold text-white bg-neutral-900 hover:bg-neutral-800 px-4 py-2.5 rounded-xl border border-white/10 shadow-md transition cursor-pointer"
                >
                  <Tv className="h-3.5 w-3.5 text-rose-400" />
                  <span>
                    {(() => {
                      const activeIndex = relatedSeasons.findIndex(s => s.id === currentAnime.id);
                      const activeSeason = relatedSeasons[activeIndex >= 0 ? activeIndex : 0];
                      if (activeSeason) {
                        const matchTemp = activeSeason.title.match(/(Temporada\s+\d+|Season\s+\d+|Final\s+Season|Part\s+\d+|Parte\s+\d+)/i);
                        if (matchTemp) return matchTemp[1];
                      }
                      return `Temporada ${(activeIndex >= 0 ? activeIndex : 0) + 1}`;
                    })()}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-neutral-400" />
                </button>

                {showSeasonSelector && (
                  <div className="absolute right-0 top-full mt-2 bg-neutral-900 border border-white/15 rounded-2xl shadow-2xl p-2 z-50 w-64 max-h-72 overflow-y-auto animate-fade-in">
                    <div className="text-[10px] font-black uppercase text-neutral-500 px-3 py-1.5 tracking-wider">
                      Temporadas Disponibles
                    </div>
                    {relatedSeasons.map((season, idx) => {
                      const isSelected = season.id === currentAnime.id;
                      let seasonName = `Temporada ${idx + 1}`;
                      const matchTemp = season.title.match(/(Temporada\s+\d+|Season\s+\d+|Final\s+Season|Part\s+\d+|Parte\s+\d+)/i);
                      if (matchTemp) {
                        seasonName = matchTemp[1];
                      }
                      return (
                        <button
                          key={season.id}
                          onClick={() => {
                            setCurrentAnime(season);
                            setShowSeasonSelector(false);
                            if (onSelectAnime) onSelectAnime(season);
                          }}
                          className={`w-full text-left px-3 py-2.5 text-xs rounded-xl transition cursor-pointer flex items-center justify-between ${
                            isSelected
                              ? "bg-rose-600 text-white font-bold shadow"
                              : "text-neutral-300 hover:bg-white/5 hover:text-white"
                          }`}
                        >
                          <span className="truncate pr-2">{seasonName} ({season.year})</span>
                          {isSelected && <Check className="h-3.5 w-3.5 flex-shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>

          {/* ── TAB CONTENT: EPISODIOS ── */}
          {activeTab === "capitulos" && (
            <div className="space-y-6 animate-fade-in">
              
              {/* Episodes Toolbar (Search, Batch pagination, Sort, Grid/List view toggle) */}
              {!isMovie && episodeList.length > 0 && (
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-neutral-900/50 border border-white/5 p-3.5 rounded-2xl">
                  
                  {/* Left: Search input & Batch navigation */}
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    
                    {/* Search Box */}
                    <div className="relative flex items-center flex-shrink-0">
                      <Search className="absolute left-3 h-3.5 w-3.5 text-neutral-500" />
                      <input
                        type="text"
                        placeholder="Buscar episodio (ej: 12)..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-neutral-950 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 w-48 sm:w-56 transition"
                      />
                      {searchQuery && (
                        <button
                          onClick={() => setSearchQuery("")}
                          className="absolute right-2.5 text-neutral-500 hover:text-white text-xs"
                        >
                          ✕
                        </button>
                      )}
                    </div>

                    {/* Batch Chips & Range Navigation */}
                    {totalPages > 1 && !searchQuery && (
                      <div className="flex items-center gap-1.5 min-w-0 flex-1 relative">
                        {/* Scroll Left Button */}
                        <button
                          type="button"
                          onClick={() => chipsContainerRef.current?.scrollBy({ left: -240, behavior: "smooth" })}
                          className="h-7 w-7 rounded-xl bg-neutral-950 border border-white/10 hover:bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center flex-shrink-0 transition cursor-pointer shadow"
                          title="Desplazar capítulos anteriores"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </button>

                        {/* Chips Track */}
                        <div 
                          ref={chipsContainerRef}
                          onWheel={(e) => {
                            if (Math.abs(e.deltaY) > 0) {
                              e.currentTarget.scrollLeft += e.deltaY;
                            }
                          }}
                          className="flex items-center gap-1.5 overflow-x-auto max-w-full pb-1 sm:pb-0 scroll-smooth scrollbar-thin scrollbar-thumb-white/20 scrollbar-track-transparent"
                        >
                          {Array.from({ length: totalPages }).map((_, idx) => {
                            const isActive = idx === activePage;
                            return (
                              <button
                                key={idx}
                                data-page={idx}
                                onClick={() => setCurrentPage(idx)}
                                className={`px-3 py-1 rounded-xl text-xs font-bold border transition cursor-pointer flex-shrink-0 ${
                                  isActive
                                    ? "bg-rose-600 text-white border-rose-500 shadow-md shadow-rose-600/30"
                                    : "bg-neutral-950 border-white/10 text-neutral-400 hover:text-white hover:bg-neutral-800"
                                }`}
                              >
                                {getPageLabel(idx)}
                              </button>
                            );
                          })}
                        </div>

                        {/* Scroll Right Button */}
                        <button
                          type="button"
                          onClick={() => chipsContainerRef.current?.scrollBy({ left: 240, behavior: "smooth" })}
                          className="h-7 w-7 rounded-xl bg-neutral-950 border border-white/10 hover:bg-neutral-800 text-neutral-400 hover:text-white flex items-center justify-center flex-shrink-0 transition cursor-pointer shadow"
                          title="Desplazar capítulos siguientes"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </button>

                        {/* Quick Jump Selector for Series with > 6 Pages */}
                        {totalPages > 6 && (
                          <div className="relative flex-shrink-0">
                            <select
                              value={activePage}
                              onChange={(e) => setCurrentPage(Number(e.target.value))}
                              className="bg-neutral-950 text-neutral-300 border border-white/10 rounded-xl px-2.5 py-1 text-xs font-bold focus:outline-none focus:border-rose-500 cursor-pointer shadow"
                              title="Saltar directo a un bloque de episodios"
                            >
                              {Array.from({ length: totalPages }).map((_, idx) => (
                                <option key={idx} value={idx} className="bg-neutral-900 text-white">
                                  {getPageLabel(idx)}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                    )}

                  </div>

                  {/* Right: Sort Order & View Mode Toggles */}
                  <div className="flex items-center gap-3 self-end md:self-auto">
                    
                    {/* Sort Order Button */}
                    <button
                      onClick={() => setAscending(!ascending)}
                      className="flex items-center gap-1.5 text-xs font-bold text-neutral-400 hover:text-white transition cursor-pointer bg-neutral-950 px-3 py-1.5 rounded-xl border border-white/10"
                      title="Cambiar orden de episodios"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5 text-rose-400" />
                      <span>{ascending ? "1 → N" : "N → 1"}</span>
                    </button>

                    {/* Grid vs List View Switcher */}
                    <div className="flex items-center bg-neutral-950 p-0.5 rounded-xl border border-white/10">
                      <button
                        onClick={() => setViewMode("list")}
                        className={`p-1.5 rounded-lg transition cursor-pointer ${
                          viewMode === "list" ? "bg-rose-600 text-white shadow" : "text-neutral-500 hover:text-white"
                        }`}
                        title="Vista en Lista (Netflix)"
                      >
                        <List className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setViewMode("grid")}
                        className={`p-1.5 rounded-lg transition cursor-pointer ${
                          viewMode === "grid" ? "bg-rose-600 text-white shadow" : "text-neutral-500 hover:text-white"
                        }`}
                        title="Vista en Cuadrícula (Crunchyroll)"
                      >
                        <LayoutGrid className="h-4 w-4" />
                      </button>
                    </div>

                  </div>

                </div>
              )}

              {/* ── EPISODES DISPLAY ── */}
              {paginatedEpisodes.length === 0 ? (
                <div className="text-center py-16 bg-neutral-900/30 border border-white/5 rounded-3xl space-y-2">
                  <p className="text-sm font-bold text-neutral-300">No se encontraron episodios</p>
                  <p className="text-xs text-neutral-500">Prueba con otro número o limpia el filtro de búsqueda.</p>
                </div>
              ) : viewMode === "grid" && !isMovie ? (
                
                /* ── CRUNCHYROLL STYLE GRID VIEW ── */
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {paginatedEpisodes.map((ep) => {
                    const epProg = allProgress[ep.id] 
                      || allProgress[getCanonicalEpisodeKey(normalizeAnimeId(currentAnime.id, currentAnime.title), ep.number || 1)];

                    return (
                      <div
                        key={ep.id}
                        onClick={() => onPlayEpisode(ep.id)}
                        className="group relative flex flex-col rounded-2xl bg-neutral-900/40 border border-white/5 hover:border-rose-500/40 hover:bg-neutral-900/90 transition-all duration-300 cursor-pointer overflow-hidden shadow-md hover:shadow-xl hover:shadow-rose-950/20"
                      >
                        {/* 16:9 Thumbnail */}
                        <div className="relative aspect-video w-full overflow-hidden bg-neutral-900">
                          <img
                            src={getProxyImageUrl(currentAnime.bannerUrl || currentAnime.coverUrl, currentAnime.title, true)}
                            alt={`Episodio ${ep.number}`}
                            className="h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.onerror = null;
                              e.currentTarget.src = getAnimePlaceholder(currentAnime.title, true);
                            }}
                          />
                          
                          {/* Play overlay glow */}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-600 text-white shadow-xl shadow-rose-600/40 transform scale-75 group-hover:scale-100 transition-transform">
                              <Play className="h-6 w-6 fill-white ml-0.5" />
                            </div>
                          </div>

                          {/* Episode Number Badge */}
                          <div className="absolute top-2.5 left-2.5 bg-black/80 backdrop-blur-md px-2.5 py-1 rounded-lg border border-white/10 text-xs font-black text-white">
                            Ep. {ep.number}
                          </div>

                          {/* Watched Status Badge */}
                          {epProg && epProg.percentage >= 85 && (
                            <div className="absolute top-2.5 right-2.5 bg-emerald-950/90 border border-emerald-500/40 text-emerald-400 px-2 py-1 rounded-lg text-[10px] font-black flex items-center gap-1 backdrop-blur-md shadow-md">
                              <Check className="h-3 w-3" />
                              <span>Visto</span>
                            </div>
                          )}

                          {/* Running Progress Bar */}
                          {epProg && epProg.percentage > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-neutral-800">
                              <div 
                                className="h-full bg-gradient-to-r from-rose-600 to-pink-500 transition-all duration-300"
                                style={{ width: `${epProg.percentage}%` }}
                              />
                            </div>
                          )}
                        </div>

                        {/* Card Info */}
                        <div className="p-4 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="font-bold text-sm text-white group-hover:text-rose-400 transition truncate">
                              Capítulo {ep.number}
                            </h4>
                            <p className="text-[11px] text-neutral-400 font-medium truncate mt-0.5">
                              {ep.releaseDate || "Disponible en 1080p HD"}
                            </p>
                          </div>

                          {/* Action Buttons: Mark as Watched & Download */}
                          <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                            {/* Toggle Watched Button */}
                            <button
                              onClick={(e) => handleToggleWatched(e, ep)}
                              className={`h-8 w-8 rounded-xl flex items-center justify-center border transition cursor-pointer ${
                                epProg && epProg.percentage >= 85
                                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30"
                                  : "bg-neutral-900 border-white/10 text-neutral-400 hover:text-white hover:border-neutral-700"
                              }`}
                              title={epProg && epProg.percentage >= 85 ? "Marcar como no visto" : "Marcar como visto"}
                            >
                              <Check className="h-4 w-4" />
                            </button>

                            {/* Download Button */}
                            {downloadStates[ep.id] === "downloaded" ? (
                              <button
                                onClick={(e) => handleDownloadEpisode(e, ep)}
                                className="h-8 w-8 rounded-xl flex items-center justify-center bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500 hover:text-white transition cursor-pointer"
                                title="Descargado"
                              >
                                <CheckCircle className="h-4 w-4" />
                              </button>
                            ) : downloadStates[ep.id] === "downloading" ? (
                              <div className="h-8 w-8 rounded-xl flex items-center justify-center bg-white/5 border border-white/10 text-rose-400">
                                <RefreshCw className="h-4 w-4 animate-spin" />
                              </div>
                            ) : (
                              <button
                                onClick={(e) => handleDownloadEpisode(e, ep)}
                                className="h-8 w-8 rounded-xl flex items-center justify-center bg-white/5 hover:bg-rose-600 text-neutral-400 hover:text-white border border-white/10 transition cursor-pointer"
                                title="Descargar offline"
                              >
                                <Download className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>

                      </div>
                    );
                  })}
                </div>

              ) : (

                /* ── NETFLIX STYLE DETAILED LIST VIEW ── */
                <div className="space-y-3">
                  {paginatedEpisodes.map((ep, idx) => {
                    const epProg = allProgress[ep.id] 
                      || allProgress[getCanonicalEpisodeKey(normalizeAnimeId(currentAnime.id, currentAnime.title), ep.number || 1)];

                    let episodeLabel = isMovie ? `Película Completa` : `Capítulo ${ep.number}`;
                    if (!isMovie && ep.title && typeof ep.title === "string") {
                      const cleanEpTitle = ep.title.replace(currentAnime.title || "", "").replace(/^-/, "").trim();
                      if (cleanEpTitle && !cleanEpTitle.toLowerCase().includes("episodio") && !cleanEpTitle.toLowerCase().includes("capítulo") && !cleanEpTitle.toLowerCase().includes("cap")) {
                        episodeLabel = cleanEpTitle;
                      }
                    }

                    return (
                      <div
                        key={ep.id}
                        onClick={() => onPlayEpisode(ep.id)}
                        className="group flex flex-col sm:flex-row items-start sm:items-center gap-4 p-3.5 sm:p-4 rounded-2xl bg-neutral-900/40 border border-white/5 hover:border-rose-500/30 hover:bg-neutral-900/80 transition-all duration-200 cursor-pointer shadow-sm hover:shadow-md"
                      >
                        {/* Big Episode Number on Desktop */}
                        {!isMovie && (
                          <span className="hidden md:flex items-center justify-center text-2xl lg:text-3xl font-black text-neutral-700 group-hover:text-rose-500/60 transition w-10 flex-shrink-0">
                            {ep.number < 10 ? `0${ep.number}` : ep.number}
                          </span>
                        )}

                        {/* 16:9 Thumbnail Preview */}
                        <div className="relative aspect-video w-full sm:w-44 md:w-48 flex-shrink-0 overflow-hidden rounded-xl bg-neutral-900 border border-white/10 group-hover:border-rose-500/30 transition">
                          <img
                            src={getProxyImageUrl(currentAnime.bannerUrl || currentAnime.coverUrl, currentAnime.title, true)}
                            alt={`Episodio ${ep.number}`}
                            className="h-full w-full object-cover object-center transition-transform duration-500 group-hover:scale-105"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              e.currentTarget.onerror = null;
                              e.currentTarget.src = getAnimePlaceholder(currentAnime.title, true);
                            }}
                          />
                          
                          {/* Play button hover glow */}
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg shadow-rose-600/40 transform scale-75 group-hover:scale-100 transition-transform">
                              <Play className="h-5 w-5 fill-white ml-0.5" />
                            </div>
                          </div>

                          {/* Watched Status Badge on Thumbnail */}
                          {epProg && epProg.percentage >= 85 && (
                            <div className="absolute top-2 left-2 bg-emerald-950/90 border border-emerald-500/40 text-emerald-400 px-2 py-0.5 rounded-lg text-[10px] font-black flex items-center gap-1 backdrop-blur-md shadow-md z-10">
                              <Check className="h-3 w-3" />
                              <span>Visto</span>
                            </div>
                          )}

                          {/* Running Progress Bar */}
                          {epProg && epProg.percentage > 0 && (
                            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-neutral-800">
                              <div 
                                className="h-full bg-gradient-to-r from-rose-600 to-pink-500 transition-all duration-300"
                                style={{ width: `${epProg.percentage}%` }}
                              />
                            </div>
                          )}
                        </div>

                        {/* Episode Info & Synopsis */}
                        <div className="flex-grow min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-bold text-sm sm:text-base text-white group-hover:text-rose-400 transition truncate">
                              {!isMovie && <span className="text-neutral-400 font-extrabold mr-2">Ep. {ep.number}</span>}
                              {episodeLabel}
                            </h4>

                            <div className="flex items-center gap-2">
                              {epProg && epProg.percentage >= 85 && (
                                <span className="inline-flex items-center gap-1 text-[10px] font-black text-emerald-400 bg-emerald-950/40 border border-emerald-500/20 px-2 py-0.5 rounded-md">
                                  <Check className="h-3 w-3" /> Completado
                                </span>
                              )}
                              <span className="text-[11px] font-semibold text-neutral-500 bg-neutral-950 px-2 py-0.5 rounded-md border border-white/5">
                                {ep.releaseDate || "1080p HD"}
                              </span>
                            </div>
                          </div>

                          {epProg && epProg.percentage > 0 && epProg.percentage < 85 && (
                            <span className="inline-block text-[10px] font-bold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                              {epProg.percentage}% visto ({Math.round(epProg.position / 60)} min)
                            </span>
                          )}

                          <p className="text-xs text-neutral-400 leading-relaxed line-clamp-2">
                            {currentAnime.synopsis 
                              ? `Disfruta del capítulo ${ep.number} de ${currentAnime.title}. Sigue el emocionante destino de la historia en esta maravillosa producción.` 
                              : "No hay sinopsis específica disponible para este episodio. Reproduce para comenzar la aventura."}
                          </p>
                        </div>

                        {/* Action Buttons: Mark as Watched & Offline Download */}
                        <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center pt-2 sm:pt-0" onClick={(e) => e.stopPropagation()}>
                          {/* Toggle Watched Button */}
                          <button
                            onClick={(e) => handleToggleWatched(e, ep)}
                            className={`h-10 w-10 rounded-xl flex items-center justify-center border transition cursor-pointer ${
                              epProg && epProg.percentage >= 85
                                ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30"
                                : "bg-white/5 border-white/10 text-neutral-400 hover:text-white hover:border-neutral-700"
                            }`}
                            title={epProg && epProg.percentage >= 85 ? "Marcar como no visto" : "Marcar como visto"}
                          >
                            <Check className="h-4.5 w-4.5" />
                          </button>

                          {/* Offline Download Button */}
                          {downloadStates[ep.id] === "downloaded" ? (
                            <button
                              onClick={(e) => handleDownloadEpisode(e, ep)}
                              className="h-10 w-10 rounded-xl flex items-center justify-center bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500 hover:text-white transition cursor-pointer"
                              title="Descargado. Clic para eliminar."
                            >
                              <CheckCircle className="h-5 w-5" />
                            </button>
                          ) : downloadStates[ep.id] === "downloading" ? (
                            <div className="h-10 w-10 rounded-xl flex items-center justify-center bg-white/5 border border-white/10 text-rose-400 relative">
                              <RefreshCw className="h-4 w-4 animate-spin" />
                              <span className="absolute -bottom-1 text-[8px] font-black bg-rose-600 text-white px-1 rounded">
                                {downloadProgress[ep.id]}%
                              </span>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => handleDownloadEpisode(e, ep)}
                              className="h-10 w-10 rounded-xl flex items-center justify-center bg-white/5 hover:bg-rose-600 text-neutral-400 hover:text-white border border-white/10 hover:border-rose-500 transition cursor-pointer"
                              title="Descargar offline"
                            >
                              <Download className="h-4.5 w-4.5" />
                            </button>
                          )}
                        </div>

                      </div>
                    );
                  })}
                </div>
              )}

            </div>
          )}

          {/* ── TAB CONTENT: RELACIONADOS ── */}
          {activeTab === "info" && (
            <div className="space-y-8 animate-fade-in">
              
              {/* Movies & Specials */}
              {relatedSeasons.filter(s => s.type === "Película" || s.type === "Movie").length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Film className="h-4 w-4 text-rose-500" />
                    <span>Películas y Especiales Relacionados</span>
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {relatedSeasons.filter(s => s.type === "Película" || s.type === "Movie").map((movie) => (
                      <div 
                        key={movie.id}
                        onClick={() => {
                          setCurrentAnime(movie);
                          if (onSelectAnime) onSelectAnime(movie);
                        }}
                        className="group cursor-pointer bg-neutral-900/50 border border-white/5 rounded-2xl overflow-hidden hover:border-rose-500/50 hover:shadow-xl hover:shadow-rose-950/30 transition-all duration-300"
                      >
                        <div className="relative aspect-[3/4] overflow-hidden">
                          <img 
                            src={getProxyImageUrl(movie.coverUrl, movie.title)} 
                            alt={movie.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              recoverCoverImageInHotPath(e, movie.title, movie.id, "ANIME");
                            }}
                          />
                          <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase border border-white/10">
                            Película
                          </div>
                        </div>
                        <div className="p-3">
                          <h5 className="text-xs font-bold text-neutral-200 line-clamp-1 group-hover:text-rose-400 transition-colors">
                            {movie.title}
                          </h5>
                          <span className="text-[10px] text-neutral-500 font-semibold">{movie.year}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Related Mangas */}
              {currentAnime.relatedMangas && currentAnime.relatedMangas.length > 0 && (
                <div className="space-y-4">
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <BookOpen className="h-4 w-4 text-rose-500" />
                    <span>Manga Original</span>
                  </h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {currentAnime.relatedMangas.map((manga) => (
                      <div 
                        key={manga.id}
                        className="group cursor-pointer bg-neutral-900/50 border border-white/5 rounded-2xl overflow-hidden hover:border-rose-500/50 transition-all duration-300"
                        onClick={() => onSelectManga?.(manga)}
                      >
                        <div className="relative aspect-[3/4] overflow-hidden">
                          <img 
                            src={getProxyImageUrl(manga.coverUrl, manga.title)} 
                            alt={manga.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              recoverCoverImageInHotPath(e, manga.title, manga.id, "MANGA");
                            }}
                          />
                          <div className="absolute top-2 right-2 bg-rose-600/90 backdrop-blur-md px-2 py-0.5 rounded text-[10px] font-bold text-white uppercase">
                            Manga
                          </div>
                        </div>
                        <div className="p-3">
                          <h5 className="text-xs font-bold text-neutral-200 line-clamp-1 group-hover:text-rose-400 transition-colors">
                            {manga.title}
                          </h5>
                          <span className="text-[10px] text-neutral-500 font-semibold">{manga.year}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          )}

          {/* ── TAB CONTENT: RESEÑAS & COMUNIDAD ── */}
          {activeTab === "reseñas" && (
            <div className="space-y-8 animate-fade-in">
              
              {/* Community Rating Header */}
              <div className="flex flex-col sm:flex-row items-center justify-between p-6 rounded-2xl bg-neutral-900/50 border border-white/5 gap-6">
                <div className="text-center sm:text-left space-y-1">
                  <h3 className="text-lg font-bold text-white tracking-wide">Puntuación de la Comunidad</h3>
                  <p className="text-xs text-neutral-400">¿Qué opinan otros fanáticos de {currentAnime.title}?</p>
                </div>
                <div className="flex items-center gap-4 bg-neutral-950 px-6 py-4 rounded-2xl border border-white/10 shadow-inner">
                  <div className="flex items-center justify-center h-12 w-12 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 font-black text-xl">
                    {averageStars}
                  </div>
                  <div>
                    <div className="flex text-amber-400">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star 
                          key={i} 
                          className={`h-4 w-4 ${i < Math.round(averageStars) ? 'fill-amber-400 text-amber-400' : 'text-neutral-700'}`} 
                        />
                      ))}
                    </div>
                    <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider block mt-1">
                      {reviews.length} {reviews.length === 1 ? 'reseña' : 'reseñas'} registradas
                    </span>
                  </div>
                </div>
              </div>

              {/* Review Submit Form */}
              <form onSubmit={handleSubmitReview} className="p-6 rounded-2xl bg-neutral-900/50 border border-white/5 space-y-4">
                <h4 className="text-sm font-bold text-white">Escribe tu opinión</h4>
                
                {/* Star rating picker */}
                <div className="flex items-center gap-3">
                  <span className="text-xs text-neutral-400">Tu calificación:</span>
                  <div className="flex gap-1.5">
                    {Array.from({ length: 5 }).map((_, i) => {
                      const starValue = i + 1;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setNewRating(starValue)}
                          className="text-neutral-600 hover:scale-125 transition-transform cursor-pointer"
                        >
                          <Star 
                            className={`h-5 w-5 ${starValue <= newRating ? 'fill-amber-400 text-amber-400' : 'text-neutral-700'}`} 
                          />
                        </button>
                      );
                    })}
                  </div>
                  <span className="text-xs font-bold text-amber-400">{newRating} {newRating === 1 ? 'Estrella' : 'Estrellas'}</span>
                </div>

                <div className="space-y-1.5">
                  <textarea
                    placeholder="¿Qué te pareció este anime? Comparte tu opinión con la comunidad..."
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    className="w-full bg-neutral-950 border border-white/10 rounded-xl px-4 py-3 text-xs text-white placeholder-neutral-500 focus:border-rose-500 outline-none resize-none leading-relaxed"
                  />
                  <div className="flex justify-between items-center text-[10px] text-neutral-500 font-semibold">
                    <span>Máximo 1000 caracteres</span>
                    <span>{newComment.length}/1000</span>
                  </div>
                </div>

                {reviewError && (
                  <p className="text-xs text-rose-400 font-semibold">{reviewError}</p>
                )}

                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={submittingReview}
                    className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 disabled:bg-neutral-800 disabled:text-neutral-500 text-white text-xs font-bold rounded-xl transition cursor-pointer flex items-center gap-2 shadow-lg shadow-rose-600/30"
                  >
                    {submittingReview ? (
                      <>
                        <div className="h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        <span>Publicando...</span>
                      </>
                    ) : (
                      <span>Publicar Reseña</span>
                    )}
                  </button>
                </div>
              </form>

              {/* Reviews List */}
              <div className="space-y-4">
                <h4 className="text-xs font-black text-neutral-400 uppercase tracking-wider">Opiniones de la Comunidad</h4>
                {reviews.length === 0 ? (
                  <div className="text-center py-10 text-neutral-500 text-xs bg-neutral-900/30 border border-white/5 rounded-2xl">
                    Aún no hay reseñas. ¡Sé el primero en calificar este anime!
                  </div>
                ) : (
                  <div className="space-y-3">
                    {reviews.map((rev) => (
                      <div key={rev.id} className="p-4 rounded-xl bg-neutral-900/40 border border-white/5 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <img 
                              src={rev.avatarUrl} 
                              alt={rev.username} 
                              className="h-8 w-8 rounded-full object-cover border border-white/10"
                            />
                            <div>
                              <span className="text-xs font-bold text-white block">{rev.username}</span>
                              <span className="text-[10px] text-neutral-500">
                                {new Date(rev.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </span>
                            </div>
                          </div>
                          <div className="flex text-amber-400 bg-neutral-950 px-2 py-1 rounded-lg border border-white/5">
                            {Array.from({ length: 5 }).map((_, i) => (
                              <Star 
                                key={i} 
                                className={`h-3 w-3 ${i < rev.rating ? 'fill-amber-400 text-amber-400' : 'text-neutral-700'}`} 
                              />
                            ))}
                          </div>
                        </div>
                        <p className="text-xs text-neutral-300 leading-relaxed pl-1">
                          {rev.comment}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

            </div>
          )}

          {/* ── GLOBAL COMMUNITY COMMENTS COMPONENT ── */}
          <div className="pt-8 border-t border-white/10">
            <CommentSection
              targetId={currentAnime.id}
              title={`Discusión General de ${currentAnime.title}`}
              currentUser={currentUser}
            />
          </div>

        </div>

      </div>
    </div>
  );
}
