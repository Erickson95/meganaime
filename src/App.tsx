import React, { useState, useEffect, Component, ReactNode, ErrorInfo } from "react";
import { useAuth } from "./hooks/useAuth";
import { useAnimeData } from "./hooks/useAnimeData";
import { useAnimeNavigation } from "./hooks/useAnimeNavigation";
import { useCategoryData } from "./hooks/useCategoryData";
import { Anime, Episode, Manga } from "./types";
import Header from "./components/Header";
import AnimeDetail from "./components/AnimeDetail";
import VideoPlayer from "./components/VideoPlayer";
import { MangaDetail } from "./components/MangaDetail";
import AuthModal from "./components/AuthModal";
import AdminPanel from "./components/AdminPanel";
import { HomeSection } from "./components/HomeSection";
import { CategorySection } from "./components/CategorySection";
import { FavoriteSection } from "./components/FavoriteSection";
import { MangaSection } from "./components/MangaSection";
import { MovieSection } from "./components/MovieSection";
import { SearchSection } from "./components/SearchSection";
import { TheatreMode } from "./components/TheatreMode";
import ProfileSelector from "./components/ProfileSelector";
import { getAnimesWithEpisodes, generateEpisodesForAnime } from "./utils/animeDb";
import { safeLocalStorage, safeSessionStorage } from "./utils/safeStorage";
import { syncAllProgressFromFirestore, getAllLocalProgress } from "./utils/progress";
import { DownloadSection } from "./components/DownloadSection";
import { useVisitorTracking } from "./hooks/useVisitorTracking";
import { GlobalBanner } from "./components/GlobalBanner";
import { Footer } from "./components/Footer";
import { App as CapApp } from "@capacitor/app";
import { getDoc, setDoc, doc } from "firebase/firestore";
import { db, OperationType, handleFirestoreError } from "./lib/firebase";


interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  declare props: Readonly<ErrorBoundaryProps>;
  public state: ErrorBoundaryState = {
    hasError: false,
    error: null
  };

  constructor(props: ErrorBoundaryProps) {
    super(props);
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
    // If it's a chunk loading error (common after new deployments), clear session cache and auto-reload once
    if (error?.message?.includes("Failed to fetch dynamically imported module") || error?.message?.includes("Importing a module script failed")) {
      const lastReload = safeSessionStorage.getItem("megaAnime_chunk_reload");
      if (!lastReload || Date.now() - parseInt(lastReload, 10) > 10000) {
        safeSessionStorage.setItem("megaAnime_chunk_reload", Date.now().toString());
        window.location.reload();
      }
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-6 text-center">
          <div className="max-w-md space-y-6">
            <div className="h-20 w-20 bg-rose-500/20 rounded-full flex items-center justify-center mx-auto">
              <span className="text-4xl">⚠️</span>
            </div>
            <h1 className="text-2xl font-black text-white">¡Ups! Algo salió mal</h1>
            <p className="text-neutral-400 text-sm">
              La aplicación ha detectado un cambio de versión o actualización. Haz clic abajo para restaurar la sesión limpia.
            </p>
            <div className="bg-black/50 p-4 rounded-xl border border-white/5 text-left overflow-auto max-h-40">
              <code className="text-xs text-rose-400 font-mono">
                {this.state.error?.message || "Error de versión de cliente React"}
              </code>
            </div>
            <div className="space-y-2">
              <button 
                onClick={() => {
                  try {
                    sessionStorage.clear();
                    localStorage.clear();
                    if ('caches' in window) {
                      caches.keys().then(names => {
                        names.forEach(name => caches.delete(name));
                      });
                    }
                  } catch (e) {}
                  window.location.href = window.location.origin;
                }}
                className="w-full py-3 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-xl transition shadow-lg shadow-rose-600/20 cursor-pointer"
              >
                Recargar y Actualizar Aplicación
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// MegaAnime App - Repositorio Sincronizado v1.0.1
export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  // Navigation & UI States
  const [activeTab, setActiveTab] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab");
      if (tabParam) return tabParam;
      if (window.location.pathname === "/admin") return "admin";
    }
    return "inicio";
  });
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showProfilesModal, setShowProfilesModal] = useState(false);
  
  // Custom Hooks
  const { 
    currentUser, 
    setCurrentUser, 
    loading,
    switchProfile, 
    createProfile, 
    updateProfile, 
    deleteProfile 
  } = useAuth();

  const {
    localFavorites,
    episodes,
    trendingAnimes,
    seasonalAnimes,
    movies,
    categories,
    loadingHome,
    toggleFavorite,
    saveFavorites,
    seasonalPage,
    setSeasonalPage,
    seasonalTotalPages,
    loadingSeasonal
  } = useAnimeData(currentUser, setCurrentUser);

  const {
    selectedAnime,
    setSelectedAnime,
    selectedManga,
    setSelectedManga,
    activeEpisodeId,
    setActiveEpisodeId,
    handleSelectAnime,
    handleNavigateEpisode,
    hasPrevEpisode,
    hasNextEpisode
  } = useAnimeNavigation();

  // Track real visitor session in Firestore and real-time live telemetry
  useVisitorTracking(
    currentUser, 
    selectedAnime?.title, 
    activeEpisodeId ? (activeEpisodeId.includes("-ep-") ? `Capítulo ${activeEpisodeId.split("-ep-")[1]}` : `Capítulo ${activeEpisodeId.split("-").pop()}`) : undefined
  );

  const {
    activeCategory,
    setActiveCategory,
    activeType,
    setActiveType,
    categoryResults,
    loadingCategory,
    categoryPage,
    setCategoryPage,
    totalPages: categoryTotalPages
  } = useCategoryData(activeTab);

  // Profile Selector flow - Netflix/Crunchyroll style
  const [hasSelectedProfile, setHasSelectedProfile] = useState(() => {
    return safeSessionStorage.getItem("megaAnime_profile_selected") === "true";
  });
  const [profileModalTab, setProfileModalTab] = useState<"profiles" | "security" | "preferences">("profiles");

  const [activeMangaChapterId, setActiveMangaChapterId] = useState<string | null>(null);

  // Smart TV D-Pad Remote Control keyboard listener
  useEffect(() => {
    function handleDpadNavigation(e: KeyboardEvent) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const focusable = Array.from(document.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ));
        const active = document.activeElement as HTMLElement;
        if (!active || !focusable.includes(active)) {
          if (focusable.length > 0) focusable[0].focus();
          return;
        }
        const index = focusable.indexOf(active);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          const next = focusable[(index + 1) % focusable.length];
          next?.focus();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          const prev = focusable[(index - 1 + focusable.length) % focusable.length];
          prev?.focus();
        }
      }
    }
    window.addEventListener("keydown", handleDpadNavigation);
    return () => window.removeEventListener("keydown", handleDpadNavigation);
  }, []);

  const handleResumeEpisode = React.useCallback((animeOrId: Anime | string, episodeId: string) => {
    let anime: Anime;
    if (typeof animeOrId === "object" && animeOrId !== null) {
      anime = { ...animeOrId };
    } else {
      const animeId = animeOrId as string;
      const cleanId = animeId.toLowerCase().replace(/^tioanime-/, "");
      const allAnimes = getAnimesWithEpisodes();
      const found = allAnimes.find(a => a.id === animeId || a.id === `tioanime-${cleanId}` || a.id.toLowerCase().replace(/^tioanime-/, "") === cleanId);
      if (found) {
        anime = { ...found };
      } else {
        const allProgress = getAllLocalProgress(currentUser);
        const savedProgress = allProgress.find(p => p.animeId === animeId || p.episodeId === episodeId);
        const cleanTitle = savedProgress?.animeTitle && 
          savedProgress.animeTitle.toLowerCase() !== "consumet" && 
          savedProgress.animeTitle.toLowerCase() !== "hianime"
            ? savedProgress.animeTitle
            : animeId.replace(/^(consumet-|hianime-|tioanime-)/g, "").replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

        anime = {
          id: animeId,
          title: cleanTitle,
          synopsis: "",
          coverUrl: savedProgress?.animeCoverUrl || "",
          bannerUrl: savedProgress?.animeCoverUrl || "",
          genres: savedProgress?.contentType === "movie" ? ["Película"] : ["Anime"],
          status: "En emisión",
          rating: 8.5,
          type: savedProgress?.contentType === "movie" ? "Película" : "Anime",
          episodesCount: Math.max(savedProgress?.episodeNumber || 1, 12),
          year: 2026,
          episodes: []
        };
      }
    }

    if (!anime.episodes || !Array.isArray(anime.episodes) || anime.episodes.length <= 1) {
      anime.episodes = generateEpisodesForAnime(anime);
    }

    const targetEpId = episodeId || (anime.episodes && anime.episodes[0]?.id) || `${anime.id}-ep-1`;

    // 🚀 Open video player IMMEDIATELY with 0ms delay!
    setSelectedAnime(anime);
    setActiveEpisodeId(targetEpId);

    // Non-blocking background fetch to enrich anime details
    fetch(`/api/anime/${anime.id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const apiTitle = data?.title?.toLowerCase()?.trim() || "";
        if (data && !data.error && apiTitle && apiTitle !== "consumet" && apiTitle !== "hianime") {
          setSelectedAnime(prev => {
            if (!prev || prev.id !== anime.id) return prev;
            return {
              ...prev,
              ...data,
              episodes: Array.isArray(data.episodes) && data.episodes.length > 0 ? data.episodes : prev.episodes
            };
          });
        }
      })
      .catch(() => {});
  }, [setSelectedAnime, setActiveEpisodeId, currentUser]);

  const handlePlayDirectEpisode = React.useCallback((animeOrId: Anime | string, episodeId: string) => {
    handleResumeEpisode(animeOrId, episodeId);
  }, [handleResumeEpisode]);

  // Handle direct Deep Links (?anime=SLUG, ?id=SLUG, /anime/SLUG, /ver/SLUG) to open Anime Details modal immediately
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const animeParam = params.get("anime") || params.get("id");
    let targetSlug = animeParam;

    if (!targetSlug && (window.location.pathname.startsWith("/anime/") || window.location.pathname.startsWith("/ver/"))) {
      targetSlug = window.location.pathname.replace(/^\/(anime|ver)\//, "").split("/")[0];
    }

    if (targetSlug) {
      const cleanTarget = decodeURIComponent(targetSlug).toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const allAnimes = getAnimesWithEpisodes();
      const match = allAnimes.find(a => 
        a.id === targetSlug || 
        a.id === `tioanime-${targetSlug}` || 
        a.id.toLowerCase() === targetSlug.toLowerCase() ||
        a.id.toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]+/g, "-") === cleanTarget ||
        a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === cleanTarget ||
        a.title.toLowerCase().includes(cleanTarget.replace(/-/g, " "))
      );
      const epParam = params.get("ep");
      const pathEp = (window.location.pathname.startsWith("/anime/") || window.location.pathname.startsWith("/ver/"))
        ? window.location.pathname.replace(/^\/(anime|ver)\//, "").split("/")[1]
        : null;
      const targetEp = epParam || pathEp;

      if (match) {
        if (targetEp) {
          const numOnly = targetEp.replace(/^(?:ep|episodio)-?/i, "");
          const formattedEpId = targetEp.startsWith(match.id)
            ? targetEp
            : `${match.id}-ep-${numOnly}`;
          handlePlayDirectEpisode(match, formattedEpId);
        } else {
          handleSelectAnime(match);
        }
      } else {
        fetch(`/api/anime/${encodeURIComponent(targetSlug)}`)
          .then(r => r.json())
          .then(data => {
            if (data && !data.error && data.title) {
              if (targetEp) {
                const numOnly = targetEp.replace(/^(?:ep|episodio)-?/i, "");
                const formattedEpId = targetEp.startsWith(data.id)
                  ? targetEp
                  : `${data.id}-ep-${numOnly}`;
                handlePlayDirectEpisode(data, formattedEpId);
              } else {
                handleSelectAnime(data);
              }
            }
          })
          .catch(() => {});
      }
    }
  }, [handleSelectAnime, handlePlayDirectEpisode]);

  // Toggle favorite with event (prompt auth for non-registered guest users)
  const handleToggleFavoriteWithEvent = (e: React.MouseEvent, animeId: string) => {
    e.stopPropagation();
    if (!currentUser) {
      setShowAuthModal(true);
      return;
    }
    toggleFavorite(animeId);
  };

  // Synchronize document title
  useEffect(() => {
    if (selectedAnime && activeEpisodeId) {
      const cleanEp = activeEpisodeId.split("-").pop();
      const epLabel = cleanEp && !isNaN(Number(cleanEp)) ? `Capítulo ${cleanEp}` : `Capítulo ${activeEpisodeId}`;
      document.title = `Reproduciendo ${selectedAnime.title} - ${epLabel} | megaAnime`;
    } else if (selectedAnime) {
      document.title = `${selectedAnime.title} | megaAnime`;
    } else {
      document.title = "megaAnime - Tu Portal de Anime de Alta Calidad";
    }
  }, [selectedAnime, activeEpisodeId]);

  // Sync all playback progress from Firestore when profile changes
  useEffect(() => {
    if (currentUser) {
      syncAllProgressFromFirestore(currentUser);
    }
  }, [currentUser?.id, currentUser?.activeProfileId]);

  // Auth success handler
  const handleAuthSuccess = (user: any) => {
    setCurrentUser(user);
    safeLocalStorage.setItem("megaAnime_user", JSON.stringify(user));
    setShowAuthModal(false);
    setHasSelectedProfile(false); // Trigger profiles overlay on login!
    safeSessionStorage.removeItem("megaAnime_profile_selected");

    // Merge any existing local/guest favorites into user account
    if (localFavorites.length > 0) {
      const mergedFavs = Array.from(new Set([...(user.favorites || []), ...localFavorites]));
      saveFavorites(mergedFavs);
    }
  };

  // Global native deep link listener for OAuth / App launch callbacks
  useEffect(() => {
    const handleAuthDeepLink = async (rawUrl: string) => {
      if (!rawUrl || (!rawUrl.includes("auth-callback") && !rawUrl.includes("megaanime") && !rawUrl.includes("net.megaanime.app"))) return;
      try {
        const getQueryParam = (k: string) => {
          const m = rawUrl.match(new RegExp(`[?&]${k}=([^&]*)`));
          return m ? decodeURIComponent(m[1]) : null;
        };
        const uid = getQueryParam("uid");
        const emailParam = getQueryParam("email");
        const nameParam = getQueryParam("name");
        const photoParam = getQueryParam("photo");

        if (uid && emailParam) {
          const cleanEmail = emailParam.toLowerCase().trim();
          const isAdminUser = cleanEmail === "baezcabrera.j.r@gmail.com";

          let userData: any;
          try {
            const userDoc = await getDoc(doc(db, "users", uid));
            if (userDoc.exists()) {
              userData = userDoc.data();
              userData.isAdmin = isAdminUser;
            } else {
              userData = {
                id: uid,
                username: nameParam || cleanEmail.split("@")[0] || "Usuario Google",
                email: cleanEmail,
                avatarUrl: photoParam || "https://s4.anilist.co/file/anilistcdn/character/large/b127691-9zqh1xpIubn7.png",
                favorites: [],
                history: [],
                isAdmin: isAdminUser,
                createdAt: new Date().toISOString()
              };
              await setDoc(doc(db, "users", uid), userData);
            }
          } catch (dbErr) {
            handleFirestoreError(dbErr, OperationType.GET, `users/${uid}`);
          }

          if (userData) {
            handleAuthSuccess(userData);
          }
        }
      } catch (e) {
        console.error("Error handling auth deep link in App:", e);
      }
    };

    (window as any).handleOpenURL = (url: string) => {
      handleAuthDeepLink(url);
    };

    try {
      if (CapApp && typeof CapApp.addListener === "function") {
        CapApp.addListener("appUrlOpen", (data: any) => {
          if (data && data.url) handleAuthDeepLink(data.url);
        }).catch(() => {});
      }
    } catch (e) {}
  }, []);

  const handleLogout = () => {
    setCurrentUser(null);
    setHasSelectedProfile(false);
    safeSessionStorage.removeItem("megaAnime_profile_selected");
  };

  // Full-screen profile selector overlays
  const showStartupProfiles = currentUser && !hasSelectedProfile;

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center space-y-4">
        <div className="h-12 w-12 border-4 border-rose-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-sm font-black text-white tracking-widest uppercase animate-pulse">Cargando megaAnime...</span>
      </div>
    );
  }

  // First-time users land directly on Homepage in guest mode without full-screen auth wall
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 font-sans selection:bg-rose-500 selection:text-white pb-12">
      
      <Header
        currentUser={currentUser}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenAuth={() => setShowAuthModal(true)}
        onLogout={handleLogout}
        onOpenProfiles={(tab) => {
          setProfileModalTab(tab || "profiles");
          setShowProfilesModal(true);
        }}
        onSwitchProfile={switchProfile}
      />

      <GlobalBanner />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        
        {activeTab === "inicio" && (
          <HomeSection
            trendingAnimes={trendingAnimes}
            seasonalAnimes={seasonalAnimes}
            movies={movies}
            latestEpisodes={episodes.map(e => ({ id: e.animeId, title: e.animeTitle, coverUrl: e.coverUrl } as Anime))}
            loading={loadingHome}
            onSelectAnime={handleSelectAnime}
            onSelectManga={setSelectedManga}
            favorites={localFavorites}
            onToggleFavorite={handleToggleFavoriteWithEvent}
            currentUser={currentUser}
            activeEpisodeId={activeEpisodeId}
            onResumeEpisode={handleResumeEpisode}
            onResumeManga={(manga, chapterId) => {
              setSelectedManga(manga);
              setActiveMangaChapterId(chapterId);
            }}
            seasonalPage={seasonalPage}
            seasonalTotalPages={seasonalTotalPages}
            loadingSeasonal={loadingSeasonal}
            onNavigateTab={setActiveTab}
          />
        )}

        {activeTab === "buscar" && (
          <SearchSection
            categories={categories}
            trendingAnimes={trendingAnimes}
            localFavorites={localFavorites}
            onSelectAnime={handleSelectAnime}
            onToggleFavorite={handleToggleFavoriteWithEvent}
          />
        )}

        {activeTab === "peliculas" && (
          <MovieSection
            onSelectAnime={handleSelectAnime}
            favorites={localFavorites}
            onToggleFavorite={handleToggleFavoriteWithEvent}
            categories={categories}
          />
        )}

        {activeTab === "categorias" && (
          <CategorySection
            categories={categories}
            activeCategory={activeCategory}
            onSelectCategory={setActiveCategory}
            activeType={activeType}
            onSelectType={setActiveType}
            loading={loadingCategory}
            results={categoryResults}
            currentPage={categoryPage}
            totalPages={categoryTotalPages}
            onPageChange={setCategoryPage}
            onSelectAnime={handleSelectAnime}
            favorites={localFavorites}
            onToggleFavorite={handleToggleFavoriteWithEvent}
          />
        )}


        {activeTab === "favoritos" && (
          <FavoriteSection
            currentUser={currentUser}
            favorites={localFavorites}
            trendingAnimes={trendingAnimes}
            seasonalAnimes={seasonalAnimes}
            searchResults={[]}
            onSelectAnime={handleSelectAnime}
            onToggleFavorite={handleToggleFavoriteWithEvent}
            onShowAuth={() => setShowAuthModal(true)}
            onGoToHome={() => setActiveTab("inicio")}
          />
        )}

        {activeTab === "descargas" && (
          <DownloadSection
            onPlayEpisode={(episodeId, animeId) => {
              handleResumeEpisode(animeId, episodeId);
            }}
            onSelectAnimeById={async (animeId) => {
              const allAnimes = getAnimesWithEpisodes();
              let match = allAnimes.find(a => a.id === animeId);
              if (!match) {
                try {
                  const res = await fetch(`/api/anime/${animeId}`);
                  if (res.ok) {
                    const data = await res.json();
                    if (data && !data.error) {
                      match = data;
                    }
                  }
                } catch (e) {}
              }
              if (match) {
                setSelectedAnime(match);
              } else {
                setActiveTab("inicio");
              }
            }}
          />
        )}

        {activeTab === "mangas" && <MangaSection categories={categories} />}

        {activeTab === "admin" && (
          (currentUser?.isAdmin && currentUser?.email?.toLowerCase().trim() === "baezcabrera.j.r@gmail.com") ||
          (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
        ) && (
          <AdminPanel />
        )}

        {/* Global Responsive Footer with Official Contact Email */}
        <Footer />
      </main>

      <TheatreMode
        selectedAnime={selectedAnime}
        selectedManga={selectedManga}
        activeEpisodeId={activeEpisodeId}
        activeMangaChapterId={activeMangaChapterId}
        localFavorites={localFavorites}
        onCloseAnime={() => setSelectedAnime(null)}
        onCloseManga={() => {
          setSelectedManga(null);
          setActiveMangaChapterId(null);
        }}
        onCloseEpisode={() => setActiveEpisodeId(null)}
        onPlayEpisode={(epId) => setActiveEpisodeId(epId)}
        onToggleFavorite={toggleFavorite}
        onNavigateEpisode={handleNavigateEpisode}
        hasPrevEpisode={hasPrevEpisode}
        hasNextEpisode={hasNextEpisode}
        onSelectAnime={setSelectedAnime}
        onSelectManga={setSelectedManga}
        currentUser={currentUser}
        onOpenAuth={() => setShowAuthModal(true)}
      />

      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onSuccess={handleAuthSuccess}
        />
      )}

      {/* Crunchyroll-style Profile Selection on startup/login */}
      {showStartupProfiles && (
        <ProfileSelector
          currentUser={currentUser}
          onSwitchProfile={(profileId) => {
            switchProfile(profileId);
            setHasSelectedProfile(true);
            safeSessionStorage.setItem("megaAnime_profile_selected", "true");
          }}
          onCreateProfile={createProfile}
          onUpdateProfile={updateProfile}
          onDeleteProfile={deleteProfile}
        />
      )}

      {/* Profile Manager triggered manually from Settings/Header dropdown */}
      {showProfilesModal && currentUser && (
        <ProfileSelector
          currentUser={currentUser}
          isSettingsMode={true}
          initialTab={profileModalTab}
          onSwitchProfile={(profileId) => {
            switchProfile(profileId);
            setShowProfilesModal(false);
          }}
          onCreateProfile={createProfile}
          onUpdateProfile={updateProfile}
          onDeleteProfile={deleteProfile}
          onClose={() => setShowProfilesModal(false)}
        />
      )}
    </div>
  );
}
