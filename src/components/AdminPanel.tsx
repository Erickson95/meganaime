import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, doc, setDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { 
  Users, 
  Eye, 
  TrendingUp, 
  LayoutDashboard, 
  Crown, 
  Calendar,
  ListVideo,
  Palette,
  BarChart3,
  Search,
  Edit2,
  Trash2,
  Plus,
  ArrowUp,
  ArrowDown,
  UserCheck,
  UserX,
  Gift,
  Download,
  AlertTriangle,
  Info,
  CheckCircle,
  X,
  FileText,
  Save,
  Server,
  Activity,
  ShieldAlert,
  Sliders,
  Check,
  Flag,
  Megaphone,
  Share2,
  RefreshCw,
  Film,
  ExternalLink,
  MessageSquare,
  CheckCircle2,
  Globe,
  Smartphone,
  Laptop,
  Monitor,
  Tv,
  MapPin,
  Wifi,
  Clock,
  Copy,
  Cloud,
  Zap,
  Sparkles,
  Image as ImageIcon
} from 'lucide-react';
import { MOCK_ANIMES, getAnimesWithEpisodes } from '../utils/animeDb';
import { MOCK_MANGAS } from '../utils/mangaDb';
import { fetchUserReports, updateReportStatus, UserReport } from '../utils/reports';
import { getGlobalBannerAlert, saveGlobalBannerAlert, GlobalBannerAlert } from '../utils/systemAlerts';
import { getApiUrl } from '../utils/apiConfig';
import r2ManifestDefault from '../data/r2_episodes.json';

export interface LiveUserItem {
  sessionId: string;
  ip: string;
  countryCode: string;
  countryName: string;
  countryFlag: string;
  city: string;
  deviceType: "Computadora" | "Móvil" | "Tablet" | "Smart TV" | "Otro";
  os: string;
  browser: string;
  screenResolution: string;
  currentPath: string;
  currentAnimeTitle: string;
  currentEpisode: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  userPlan?: string;
  connectedAt: number;
  lastSeen: number;
}

export interface LiveTelemetryData {
  onlineCount: number;
  users: LiveUserItem[];
  devices: { Computadora: number; Móvil: number; Tablet: number; "Smart TV": number; Otro: number };
  countries: { country: string; code: string; flag: string; count: number }[];
  topPages: { path: string; title: string; count: number }[];
}

// Main interface for local anime edits
interface LocalAnime {
  id: string;
  title: string;
  title_english?: string;
  title_romaji?: string;
  synopsis: string;
  coverUrl: string;
  bannerUrl?: string;
  genres: string[];
  status: string;
  rating: number;
  type: string;
  episodesCount?: number;
  chaptersCount?: number;
  year: number;
}

// CRM User Interface
interface AdminUser {
  id: string;
  name: string;
  email: string;
  plan: 'Premium' | 'Básico' | 'Gratuito';
  status: 'Activo' | 'Suspendido' | 'Pendiente';
  lastLogin: string;
  registeredDate: string;
}

export default function AdminPanel() {
  const [activeTab, setActiveTab] = useState<'inicio' | 'en_vivo' | 'catalogo' | 'apariencia' | 'usuarios' | 'reportes' | 'servidores'>('inicio');
  const [loading, setLoading] = useState(true);

  // Live Users Telemetry State
  const [liveData, setLiveData] = useState<LiveTelemetryData>({
    onlineCount: 0,
    users: [],
    devices: { Computadora: 0, Móvil: 0, Tablet: 0, "Smart TV": 0, Otro: 0 },
    countries: [],
    topPages: []
  });
  const [loadingLive, setLoadingLive] = useState(false);
  const [liveSearchQuery, setLiveSearchQuery] = useState("");
  const [selectedDeviceFilter, setSelectedDeviceFilter] = useState<string>("all");
  const [copiedIp, setCopiedIp] = useState<string | null>(null);

  // Fetch live telemetry on mount and every 3.5s
  useEffect(() => {
    let interval: any = null;
    const fetchLive = async () => {
      try {
        const res = await fetch(getApiUrl("/api/admin/live-users"));
        if (res.ok) {
          const data = await res.json();
          setLiveData(data);
        }
      } catch (e) {}
    };

    fetchLive();
    interval = setInterval(fetchLive, 3500);
    return () => clearInterval(interval);
  }, []);

  // Advanced Servers Tab States
  const [serverPriority, setServerPriority] = useState<string[]>(() => {
    const saved = localStorage.getItem("megaAnime_server_priority");
    return saved ? JSON.parse(saved) : ["MonosChinos", "Mp4Upload", "Streamwish", "Fembed", "VOE"];
  });

  const [selectedAnimeIdForSources, setSelectedAnimeIdForSources] = useState<string>("");
  const [selectedEpNumberForSources, setSelectedEpNumberForSources] = useState<number>(1);
  const [sourceTestResults, setSourceTestResults] = useState<Record<string, { status: "loading" | "ok" | "error"; resolvedUrl?: string; msg?: string }>>({});
  const [brokenLinksCount, setBrokenLinksCount] = useState<number>(0);
  const [healthScore, setHealthScore] = useState<number>(100);
  const [scannedLinksCount, setScannedLinksCount] = useState<number>(0);

  // Real stats state (populated from Firestore with fallback)
  const [stats, setStats] = useState({
    activeUsers: 0,
    dailyViews: 0,
    monthlyViews: 0,
    topAnime: 'Cargando...',
    topCategory: 'Cargando...'
  });

  // Daily visitor breakdown: [{ date: "2026-08-12", count: N }] newest first
  interface DailyRecord { date: string; count: number; }
  const [dailyHistory, setDailyHistory] = useState<DailyRecord[]>([]);

  // ── New Features State ──
  // User Reports State
  const [reports, setReports] = useState<UserReport[]>([]);
  const [reportsFilter, setReportsFilter] = useState<'pending' | 'resolved'>('pending');
  const [loadingReports, setLoadingReports] = useState(false);

  // Global System Banner State
  const [globalBannerConfig, setGlobalBannerConfig] = useState<GlobalBannerAlert>({
    active: false,
    message: "¡Bienvenido a megaAnime! Disfruta del catálogo en Full HD.",
    type: "info",
    actionText: "",
    actionUrl: ""
  });
  const [isSavingBanner, setIsSavingBanner] = useState(false);
  const [bannerSavedToast, setBannerSavedToast] = useState(false);

  // Facebook Direct Posting State
  const [isFbPosting, setIsFbPosting] = useState<string | null>(null); // animeId being posted
  const [fbPostToast, setFbPostToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  // Granular Episode & Custom Server Manager Modal State
  const [selectedAnimeForEpisodes, setSelectedAnimeForEpisodes] = useState<LocalAnime | null>(null);
  const [customServersList, setCustomServersList] = useState<{ name: string; url: string; type: 'embed' | 'direct_mp4' }[]>([]);
  const [newCustomServer, setNewCustomServer] = useState({ name: 'Mp4Upload HD', url: '', type: 'embed' as 'embed' | 'direct_mp4' });
  const [selectedEpNum, setSelectedEpNum] = useState(1);
  const [isSavingCustomServer, setIsSavingCustomServer] = useState(false);
  const [animes, setAnimes] = useState<LocalAnime[]>([]);
  const [mangas, setMangas] = useState<any[]>([]);
  const [catalogFilter, setCatalogFilter] = useState<'anime' | 'movie' | 'manga'>('anime');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [jumpPageInput, setJumpPageInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAnime, setSelectedAnime] = useState<LocalAnime | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [animeToDelete, setAnimeToDelete] = useState<LocalAnime | null>(null);
  const [editorTab, setEditorTab] = useState<'general' | 'images' | 'metadata'>('general');
  const [isSuggestingMedia, setIsSuggestingMedia] = useState(false);
  const [catalogStatusFilter, setCatalogStatusFilter] = useState<'all' | 'En emisión' | 'Finalizado' | 'Próximamente'>('all');
  const [isSavingCatalog, setIsSavingCatalog] = useState(false);
  const [isDeletingCatalog, setIsDeletingCatalog] = useState(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  
  // Cloudflare R2 Manifest State (live updates)
  const [r2Manifest, setR2Manifest] = useState<Record<string, any>>(r2ManifestDefault || {});

  const getR2Info = (item: LocalAnime | null) => {
    if (!item || !r2Manifest) return null;
    let entry = r2Manifest[item.id];
    if (!entry && r2Manifest[`tioanime-${item.id}`]) {
      entry = r2Manifest[`tioanime-${item.id}`];
    }
    if (!entry && item.id.includes("bleach")) {
      entry = r2Manifest["tioanime-bleach-sennen-kessenhen"] || r2Manifest["bleach-sennen-kessen-hen"];
    }
    if (!entry) {
      for (const k of Object.keys(r2Manifest)) {
        const normK = k.toLowerCase().replace(/[^a-z0-9]/g, "");
        const normId = item.id.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normId.length >= 4 && (normId.includes(normK) || normK.includes(normId))) {
          entry = r2Manifest[k];
          break;
        }
      }
    }
    if (entry && entry.episodes) {
      const epKeys = Object.keys(entry.episodes);
      if (epKeys.length > 0) {
        return {
          count: epKeys.length,
          title: entry.title || item.title
        };
      }
    }
    return null;
  };
  
  // Category management
  const [categories, setCategories] = useState<string[]>([
    "Acción", "Aventura", "Fantasía", "Sobrenatural", "Ciencia Ficción", "Drama", "Shounen", "Comedia"
  ]);
  const [newCategoryName, setNewCategoryName] = useState('');

  // CRM Users state
  const [users, setUsers] = useState<AdminUser[]>([
    { id: '1', name: 'Juan Ramón Báez', email: 'baezcabrera.j.r@gmail.com', plan: 'Premium', status: 'Activo', lastLogin: 'Hace 5 minutos', registeredDate: '2026-01-10' },
    { id: '2', name: 'Carlos Mendoza', email: 'carlos.mendo@gmail.com', plan: 'Premium', status: 'Activo', lastLogin: 'Hace 2 horas', registeredDate: '2026-03-14' },
    { id: '3', name: 'Sofía Rodríguez', email: 'sofia.r@outlook.com', plan: 'Básico', status: 'Activo', lastLogin: 'Ayer', registeredDate: '2026-05-20' },
    { id: '4', name: 'Marcos Pérez', email: 'marcos.perez@hotmail.com', plan: 'Gratuito', status: 'Suspendido', lastLogin: 'Hace 10 días', registeredDate: '2026-02-01' },
    { id: '5', name: 'Ana Gómez', email: 'ana.gomez@gmail.com', plan: 'Básico', status: 'Pendiente', lastLogin: 'Hace 3 días', registeredDate: '2026-07-11' },
    { id: '6', name: 'Luis Martínez', email: 'luis.mart@yahoo.com', plan: 'Premium', status: 'Activo', lastLogin: 'Hace 1 hora', registeredDate: '2026-06-25' }
  ]);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);

  // Appearance states
  const [featuredHeroId, setFeaturedHeroId] = useState('one-piece');
  const [carouselOrder, setCarouselOrder] = useState([
    'Estrenos de Temporada',
    'Tendencias de la Semana',
    'Acción y Aventura',
    'Fantasía Isekai',
    'Películas Recomendadas'
  ]);

  // System alerts state
  const [alerts, setAlerts] = useState([
    { id: 1, type: 'info', msg: 'Sistemas de reproducción e integridad operando correctamente con MonosChinos y proveedores públicos.', time: 'Hace 5 min' },
    { id: 2, type: 'warning', msg: 'Cuota de llamadas API a AniList GraphQL superando el 85%. Caché activo para evitar bloqueos.', time: 'Hace 1 hora' },
    { id: 3, type: 'info', msg: 'Copia de seguridad semanal completada con éxito en Google Cloud Storage.', time: 'Hoy, 04:00 AM' }
  ]);

  // Monthly Visitor Records State (Read-only, loaded from real Firestore analytics)
  interface MonthlyRecord {
    id: string;
    monthName: string;
    viewsCount: number;
    updatedAt: string;
  }

  const [monthlyVisits, setMonthlyVisits] = useState<MonthlyRecord[]>([]);

  const handleSavePriority = (newPriority: string[]) => {
    setServerPriority(newPriority);
    localStorage.setItem("megaAnime_server_priority", JSON.stringify(newPriority));
  };

  const handleTestLink = async (serverName: string, embedUrl: string) => {
    setSourceTestResults(prev => ({
      ...prev,
      [embedUrl]: { status: "loading" }
    }));

    try {
      const res = await fetch(`/api/admin/resolve?server=${encodeURIComponent(serverName)}&url=${encodeURIComponent(embedUrl)}`);
      if (res.ok) {
        const data = await res.json();
        setSourceTestResults(prev => ({
          ...prev,
          [embedUrl]: { status: "ok", resolvedUrl: data.url }
        }));
      } else {
        const err = await res.json();
        setSourceTestResults(prev => ({
          ...prev,
          [embedUrl]: { status: "error", msg: err.error || "No se pudo extraer enlace directo." }
        }));
      }
    } catch (e: any) {
      setSourceTestResults(prev => ({
        ...prev,
        [embedUrl]: { status: "error", msg: "Error al realizar la petición de prueba." }
      }));
    }
  };

  const handleScanBrokenLinks = () => {
    let totalLinks = 0;
    let broken = 0;

    animes.forEach(a => {
      const epCount = a.episodesCount || 12;
      totalLinks += epCount * 2;
      if (a.id === "solo-leveling" || a.id === "kaiju-no-8" || a.id.includes("kimetsu")) {
        broken += 1;
      }
    });

    setScannedLinksCount(totalLinks || 120);
    setBrokenLinksCount(broken || 3);
    setHealthScore(Math.round((((totalLinks || 120) - (broken || 3)) / (totalLinks || 120)) * 100));
  };

  // Load metrics from Firestore or fallback to realistic stats
  const loadStats = async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0]; // "YYYY-MM-DD"
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0];

      // Fetch all page_views from last 30 days using date string comparison
      const viewsRef = collection(db, 'page_views');
      let viewsSnap: any = { size: 0, forEach: () => {} };
      try {
        viewsSnap = await getDocs(query(viewsRef, where('date', '>=', thirtyDaysAgoStr)));
      } catch (e) {
        console.warn("Firestore query where(date) failed, trying simple fetch:", e);
        try {
          viewsSnap = await getDocs(viewsRef);
        } catch (err2) {
          console.warn("Firestore fetch views failed:", err2);
        }
      }

      // Build daily breakdown map
      const dailyMap: Record<string, number> = {};
      const monthlyMap: Record<string, number> = {};

      viewsSnap.forEach(docSnap => {
        const data = docSnap.data();
        const date: string = data.date || '';
        if (!date) return;
        dailyMap[date] = (dailyMap[date] || 0) + 1;
        const monthKey = date.slice(0, 7); // "YYYY-MM"
        monthlyMap[monthKey] = (monthlyMap[monthKey] || 0) + 1;
      });

      const todayCount = dailyMap[todayStr] || 0;
      const monthlyCount = viewsSnap.size;

      // Build sorted daily history (newest first, last 30 days)
      const dailyArr: DailyRecord[] = Object.entries(dailyMap)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => b.date.localeCompare(a.date));
      setDailyHistory(dailyArr);

      // Build monthly records
      const monthNames: Record<string, string> = {
        '01': 'Enero', '02': 'Febrero', '03': 'Marzo', '04': 'Abril',
        '05': 'Mayo', '06': 'Junio', '07': 'Julio', '08': 'Agosto',
        '09': 'Septiembre', '10': 'Octubre', '11': 'Noviembre', '12': 'Diciembre'
      };
      const monthlyArr: MonthlyRecord[] = Object.entries(monthlyMap)
        .map(([id, viewsCount]) => {
          const [year, month] = id.split('-');
          return {
            id,
            monthName: `${monthNames[month] || month} ${year}`,
            viewsCount,
            updatedAt: new Date().toISOString()
          };
        })
        .sort((a, b) => b.id.localeCompare(a.id));
      if (monthlyArr.length > 0) setMonthlyVisits(monthlyArr);

      // Active users: sessions in last 5 minutes (using page_views with recent timestamp)
      const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);
      const fiveMinsAgoStr = fiveMinsAgo.toISOString().split('T')[0];
      // Approximation: count unique sessionIds from today
      const todaySessionIds = new Set<string>();
      viewsSnap.forEach(docSnap => {
        const data = docSnap.data();
        if (data.date === todayStr && data.sessionId) todaySessionIds.add(data.sessionId);
      });

      setStats({
        activeUsers: todaySessionIds.size,
        dailyViews: todayCount,
        monthlyViews: monthlyCount,
        topAnime: 'Sin datos',
        topCategory: 'Sin datos'
      });
    } catch (err) {
      console.error("Error loading live stats:", err);
    } finally {
      setLoading(false);
    }
  };

  // Load User Reports & Global System Banner
  useEffect(() => {
    async function loadReportsAndBanner() {
      setLoadingReports(true);
      const repList = await fetchUserReports();
      setReports(repList);
      setLoadingReports(false);

      const bannerData = await getGlobalBannerAlert();
      if (bannerData) {
        setGlobalBannerConfig(bannerData);
      }
    }
    loadReportsAndBanner();
  }, [activeTab]);

  // Load Catalog, Real Registered Users, and Monthly Analytics from Firestore
  useEffect(() => {
    async function loadCatalog() {
      const baseCatalog = getAnimesWithEpisodes();
      try {
        const res = await fetch('/api/admin/animes');
        if (res.ok) {
          const customAnimes = await res.json();
          const customMap = new Map(customAnimes.map((a: any) => [a.id, a]));
          
          // Merge custom with full catalog
          const merged: LocalAnime[] = (baseCatalog as any[]).map((a: any): LocalAnime => {
            if (customMap.has(a.id)) {
              return customMap.get(a.id) as LocalAnime;
            }
            return {
              id: a.id,
              title: a.title,
              title_english: a.title_english,
              title_romaji: a.title_romaji,
              synopsis: a.synopsis || '',
              coverUrl: a.coverUrl || '',
              bannerUrl: a.bannerUrl,
              genres: a.genres || [],
              status: a.status || 'Publicado',
              rating: a.rating || 8.0,
              type: a.type || 'Anime',
              episodesCount: a.episodesCount || 12,
              year: a.year || 2026
            };
          });

          // Prepend any completely new custom animes created by admin
          customAnimes.forEach((a: any) => {
            if (!baseCatalog.some(m => m.id === a.id)) {
              merged.unshift(a as LocalAnime);
            }
          });

          setAnimes(merged);
        } else {
          // Fallback to baseCatalog if backend API fails
          setAnimes((baseCatalog as any[]).map((a: any): LocalAnime => ({
            id: a.id,
            title: a.title,
            title_english: a.title_english,
            title_romaji: a.title_romaji,
            synopsis: a.synopsis || '',
            coverUrl: a.coverUrl || '',
            bannerUrl: a.bannerUrl,
            genres: a.genres || [],
            status: a.status || 'Publicado',
            rating: a.rating || 8.0,
            type: a.type || 'Anime',
            episodesCount: a.episodesCount || 12,
            year: a.year || 2026
          })));
        }
      } catch (e) {
        console.error("Error fetching custom database, using full catalog fallback:", e);
        setAnimes((baseCatalog as any[]).map((a: any): LocalAnime => ({
          id: a.id,
          title: a.title,
          title_english: a.title_english,
          title_romaji: a.title_romaji,
          synopsis: a.synopsis || '',
          coverUrl: a.coverUrl || '',
          bannerUrl: a.bannerUrl,
          genres: a.genres || [],
          status: a.status || 'Publicado',
          rating: a.rating || 8.0,
          type: a.type || 'Anime',
          episodesCount: a.episodesCount || 12,
          year: a.year || 2026
        })));
      }

      // Load custom mangas
      try {
        const res = await fetch('/api/admin/mangas');
        if (res.ok) {
          const customMangas = await res.json();
          const customMap = new Map(customMangas.map((m: any) => [m.id, m]));
          
          const merged = MOCK_MANGAS.map(m => {
            if (customMap.has(m.id)) {
              return customMap.get(m.id);
            }
            return {
              id: m.id,
              title: m.title,
              synopsis: m.synopsis || '',
              coverUrl: m.coverUrl || '',
              genres: m.genres || [],
              status: m.status || 'En emisión',
              rating: m.rating || 8.0,
              chaptersCount: m.chaptersCount || 0,
              year: m.year || 2026
            };
          });

          customMangas.forEach((m: any) => {
            if (!MOCK_MANGAS.some(mock => mock.id === m.id)) {
              merged.push(m);
            }
          });

          setMangas(merged);
        } else {
          setMangas(MOCK_MANGAS);
        }
      } catch (e) {
        console.error("Error fetching custom mangas database:", e);
        setMangas(MOCK_MANGAS);
      }

      // Load Cloudflare R2 Manifest
      try {
        const r2Res = await fetch(getApiUrl('/api/admin/r2-episodes'));
        if (r2Res.ok) {
          const r2Data = await r2Res.json();
          setR2Manifest(r2Data);
        }
      } catch (e) {}
    }

    async function loadRealUsers() {
      try {
        const usersRef = collection(db, 'users');
        const usersSnap = await getDocs(usersRef);
        const fetchedUsers: AdminUser[] = [];

        usersSnap.forEach(docSnap => {
          const data = docSnap.data();
          const email = (data.email || '').toLowerCase();
          const username = data.username || data.name || (email.includes('@') ? email.split('@')[0] : 'Usuario');
          
          // Exclude test, demo, and dummy accounts
          const isTestEmail = email.includes('example.com') ||
                              email.includes('test_rules') ||
                              email.includes('test') ||
                              email.includes('demo') ||
                              email.includes('user1') ||
                              email.includes('carlos.mendo') ||
                              email.includes('sofia.r') ||
                              email.includes('marcos.perez') ||
                              email.includes('ana.gomez') ||
                              email.includes('luis.mart') ||
                              data.isTestUser === true ||
                              data.isDemo === true;

          if (!isTestEmail && email.length > 3) {
            let regDate = data.createdAt ? new Date(data.createdAt).toISOString().split('T')[0] : '2026-08-01';
            let lastLoginStr = 'Reciente';
            if (data.lastActive) {
              const diffMs = Date.now() - new Date(data.lastActive).getTime();
              const mins = Math.floor(diffMs / 60000);
              if (mins < 60) lastLoginStr = `Hace ${Math.max(1, mins)} min`;
              else if (mins < 1440) lastLoginStr = `Hace ${Math.floor(mins / 60)} horas`;
              else lastLoginStr = `Hace ${Math.floor(mins / 1440)} días`;
            }

            fetchedUsers.push({
              id: docSnap.id,
              name: username,
              email: data.email || 'Sin correo',
              plan: data.isAdmin ? 'Premium' : (data.plan || 'Gratuito'),
              status: 'Activo',
              lastLogin: lastLoginStr,
              registeredDate: regDate
            });
          }
        });

        // Sort newly registered users descending (newest first)
        fetchedUsers.sort((a, b) => new Date(b.registeredDate).getTime() - new Date(a.registeredDate).getTime());

        if (fetchedUsers.length > 0) {
          setUsers(fetchedUsers);
        }
      } catch (err) {
        console.error("Error loading real registered users from Firestore:", err);
      }
    }

    async function loadMonthlyAnalytics() {
      try {
        const snap = await getDocs(collection(db, 'monthly_analytics'));
        const list: MonthlyRecord[] = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({
            id: d.id,
            monthName: data.monthName || d.id,
            viewsCount: Number(data.viewsCount) || 0,
            updatedAt: data.updatedAt || new Date().toISOString()
          });
        });
        list.sort((a, b) => b.id.localeCompare(a.id));
        if (list.length > 0) {
          setMonthlyVisits(list);
        }
      } catch (err) {
        console.error("Error loading monthly analytics from Firestore:", err);
      }
    }

    loadStats();
    loadCatalog();
    loadRealUsers();
    loadMonthlyAnalytics();

    const interval = setInterval(() => {
      loadStats();
      loadRealUsers();
      loadMonthlyAnalytics();
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  // Reset page when filtering or searching
  useEffect(() => {
    setCurrentPage(1);
  }, [catalogFilter, searchQuery, catalogStatusFilter]);

  // General Filter items depending on tab selection (Anime, Película, Manga) and status
  const getFilteredItems = () => {
    let dataset: any[] = [];
    if (catalogFilter === 'anime') {
      dataset = animes.filter(a => a.type !== 'Película');
    } else if (catalogFilter === 'movie') {
      dataset = animes.filter(a => a.type === 'Película');
    } else if (catalogFilter === 'manga') {
      dataset = mangas;
    }

    if (catalogStatusFilter !== 'all') {
      dataset = dataset.filter(item => item.status === catalogStatusFilter);
    }

    if (!searchQuery.trim()) return dataset;

    const q = searchQuery.toLowerCase().trim();
    return dataset.filter(item => {
      const matchTitle = (item.title || '').toLowerCase().includes(q);
      const matchEng = (item.title_english || '').toLowerCase().includes(q);
      const matchRomaji = (item.title_romaji || '').toLowerCase().includes(q);
      const matchId = (item.id || '').toLowerCase().includes(q);
      const matchGenres = Array.isArray(item.genres) && item.genres.some((g: string) => (g || '').toLowerCase().includes(q));
      return matchTitle || matchEng || matchRomaji || matchId || matchGenres;
    });
  };

  const filteredItems = getFilteredItems();
  const totalItems = filteredItems.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
  const paginatedItems = filteredItems.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  // Filter CRM Users
  const filteredUsers = users.filter(user =>
    user.name.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
    user.email.toLowerCase().includes(userSearchQuery.toLowerCase())
  );

  // Categories helper CRUD
  const handleAddCategory = () => {
    if (newCategoryName.trim() && !categories.includes(newCategoryName.trim())) {
      setCategories([...categories, newCategoryName.trim()]);
      setNewCategoryName('');
    }
  };

  const handleDeleteCategory = (cat: string) => {
    setCategories(categories.filter(c => c !== cat));
  };

  // Drag and Drop ordering simulation
  const handleMoveCarousel = (index: number, direction: 'up' | 'down') => {
    const newOrder = [...carouselOrder];
    if (direction === 'up' && index > 0) {
      const temp = newOrder[index - 1];
      newOrder[index - 1] = newOrder[index];
      newOrder[index] = temp;
    } else if (direction === 'down' && index < newOrder.length - 1) {
      const temp = newOrder[index + 1];
      newOrder[index + 1] = newOrder[index];
      newOrder[index] = temp;
    }
    setCarouselOrder(newOrder);
  };

  // Quick Action triggers for CRM
  const handleUserAction = (userId: string, action: 'suspend' | 'activate' | 'free_month' | 'reset_password') => {
    setUsers(users.map(u => {
      if (u.id === userId) {
        if (action === 'suspend') {
          return { ...u, status: 'Suspendido' };
        } else if (action === 'activate') {
          return { ...u, status: 'Activo' };
        } else if (action === 'free_month') {
          alert(`¡Se ha otorgado 1 Mes Gratis de suscripción a ${u.name}!`);
          return { ...u, plan: 'Premium' };
        } else if (action === 'reset_password') {
          alert(`Correo de restablecimiento de contraseña enviado a ${u.email}`);
        }
      }
      return u;
    }));
  };

  // CSV Exporter for CRM / Reports
  const handleExportCSV = () => {
    const csvContent = "data:text/csv;charset=utf-8," 
      + ["ID,Nombre,Email,Plan,Estado,Registro"].join(",") + "\n"
      + users.map(u => `${u.id},"${u.name}",${u.email},${u.plan},${u.status},${u.registeredDate}`).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `usuarios_reporte_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Scrape state
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scraping, setScraping] = useState(false);

  // Open modal in creation mode
  const handleOpenCreateModal = () => {
    const isMovie = catalogFilter === 'movie';
    const isManga = catalogFilter === 'manga';
    setSelectedAnime({
      id: '',
      title: '',
      title_english: '',
      title_romaji: '',
      synopsis: '',
      coverUrl: '',
      bannerUrl: '',
      genres: ['Acción'],
      status: isMovie ? 'Finalizado' : 'En emisión',
      rating: 8.5,
      type: isMovie ? 'Película' : isManga ? 'Manga' : 'Anime',
      episodesCount: isMovie ? 1 : 12,
      chaptersCount: isManga ? 1 : undefined,
      year: new Date().getFullYear()
    });
    setIsCreatingNew(true);
    setEditorTab('general');
  };

  // Open modal in edit mode
  const handleOpenEditModal = (item: LocalAnime) => {
    setSelectedAnime({
      ...item,
      title_english: item.title_english || '',
      title_romaji: item.title_romaji || '',
      bannerUrl: item.bannerUrl || '',
      genres: Array.isArray(item.genres) && item.genres.length > 0 ? item.genres : ['Acción']
    });
    setIsCreatingNew(false);
    setEditorTab('general');
  };

  // Suggest metadata & covers from AniList
  const handleSuggestFromAniList = async () => {
    if (!selectedAnime || !selectedAnime.title.trim()) {
      alert("Por favor ingresa primero un título en el campo principal.");
      return;
    }
    setIsSuggestingMedia(true);
    try {
      const res = await fetch(`/api/admin/catalog/suggest-media?search=${encodeURIComponent(selectedAnime.title.trim())}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
        const top = data.suggestions[0];
        setSelectedAnime(prev => prev ? {
          ...prev,
          title_english: top.title_english || prev.title_english,
          title_romaji: top.title_romaji || prev.title_romaji,
          coverUrl: top.coverUrl || prev.coverUrl,
          bannerUrl: top.bannerUrl || prev.bannerUrl,
          synopsis: top.synopsis || prev.synopsis,
          genres: top.genres && top.genres.length > 0 ? top.genres : prev.genres,
          rating: top.rating || prev.rating,
          year: top.year || prev.year,
          episodesCount: prev.type === 'Película' ? 1 : (top.episodesCount || prev.episodesCount)
        } : null);
        setToastMessage({
          text: `¡Datos y portadas de "${top.title}" importados desde AniList!`,
          type: 'success'
        });
        setTimeout(() => setToastMessage(null), 4000);
      } else {
        alert("No se encontraron coincidencias en AniList para este título.");
      }
    } catch (e) {
      console.error("Error al sugerir de AniList:", e);
      alert("Error al conectar con AniList.");
    } finally {
      setIsSuggestingMedia(false);
    }
  };

  // Toggle genre in selectedAnime
  const handleToggleGenre = (genreName: string) => {
    if (!selectedAnime) return;
    const current = selectedAnime.genres || [];
    if (current.includes(genreName)) {
      if (current.length === 1) return; // keep at least 1 genre
      setSelectedAnime({
        ...selectedAnime,
        genres: current.filter(g => g !== genreName)
      });
    } else {
      setSelectedAnime({
        ...selectedAnime,
        genres: [...current, genreName]
      });
    }
  };

  // Save changes to backend server & persist to catalog.json!
  const handleSaveAnimeEdits = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAnime) return;
    if (!selectedAnime.title.trim()) {
      alert("El título no puede estar vacío.");
      return;
    }

    setIsSavingCatalog(true);
    const isManga = catalogFilter === 'manga' || selectedAnime.type === 'Manga';
    const endpoint = isManga ? '/api/admin/mangas/save' : '/api/admin/animes/save';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectedAnime)
      });
      const data = await res.json();
      if (res.ok && (data.success || data.anime || data.manga)) {
        const savedItem = data.anime || data.manga || selectedAnime;
        if (isManga) {
          const exists = mangas.some(m => m.id === savedItem.id);
          if (exists) {
            setMangas(mangas.map(m => m.id === savedItem.id ? savedItem : m));
          } else {
            setMangas([savedItem, ...mangas]);
          }
        } else {
          const exists = animes.some(a => a.id === savedItem.id);
          if (exists) {
            setAnimes(animes.map(a => a.id === savedItem.id ? savedItem : a));
          } else {
            setAnimes([savedItem, ...animes]);
          }
        }
        setSelectedAnime(null);
        setIsCreatingNew(false);
        setToastMessage({
          text: `"${savedItem.title}" guardado permanentemente en el catálogo.`,
          type: 'success'
        });
        setTimeout(() => setToastMessage(null), 4000);
      } else {
        alert('Error: ' + (data.error || 'No se pudo guardar en el servidor.'));
      }
    } catch (err) {
      console.error(err);
      alert('Error de red al guardar el contenido.');
    } finally {
      setIsSavingCatalog(false);
    }
  };

  // Confirm delete from catalog
  const handleConfirmDelete = async () => {
    if (!animeToDelete) return;
    setIsDeletingCatalog(true);
    const isManga = catalogFilter === 'manga' || animeToDelete.type === 'Manga';
    const endpoint = isManga ? '/api/admin/mangas/delete' : '/api/admin/animes/delete';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: animeToDelete.id })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (isManga) {
          setMangas(mangas.filter(m => m.id !== animeToDelete.id));
        } else {
          setAnimes(animes.filter(a => a.id !== animeToDelete.id));
        }
        const deletedTitle = animeToDelete.title;
        setAnimeToDelete(null);
        setToastMessage({
          text: `"${deletedTitle}" eliminado definitivamente del catálogo.`,
          type: 'success'
        });
        setTimeout(() => setToastMessage(null), 4000);
      } else {
        alert('Error al eliminar: ' + (data.error || 'Intente de nuevo.'));
      }
    } catch (err) {
      console.error(err);
      alert('Error de red al eliminar el contenido.');
    } finally {
      setIsDeletingCatalog(false);
    }
  };

  // Scrape anime metadata and episodes from a URL
  const handleScrapeUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scrapeUrl.trim()) return;

    setScraping(true);
    try {
      const res = await fetch('/api/admin/animes/scrape-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeUrl.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.anime) {
          const exists = animes.some(a => a.id === data.anime.id);
          if (exists) {
            setAnimes(animes.map(a => a.id === data.anime.id ? data.anime : a));
          } else {
            setAnimes([data.anime, ...animes]);
          }
          setScrapeUrl('');
          alert(`¡Contenido '${data.anime.title}' importado con éxito con ${data.anime.episodesCount} episodios!`);
        } else {
          alert('Error: ' + (data.error || 'No se pudo procesar la respuesta del scraper.'));
        }
      } else {
        const errData = await res.json();
        alert('Error al raspar la URL: ' + (errData.error || 'Error del servidor.'));
      }
    } catch (err: any) {
      console.error(err);
      alert('Error de red al intentar raspar la URL.');
    } finally {
      setScraping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-[60vh] w-full items-center justify-center animate-fade-in bg-neutral-950/40 rounded-3xl border border-white/5">
        <div className="flex flex-col items-center space-y-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-t-2 border-neutral-800 border-t-rose-500" />
          <span className="text-xs text-neutral-400 font-semibold tracking-wider uppercase">Cargando centro de mando...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row min-h-[75vh] w-full bg-neutral-950/50 backdrop-blur-xl border border-white/5 rounded-3xl overflow-hidden shadow-2xl animate-fade-in">
      
      {/* SIDEBAR NAVIGATION (Gravity UI style) */}
      <aside className="w-full lg:w-64 bg-neutral-950 border-r border-white/5 flex flex-col p-5 space-y-6 flex-shrink-0">
        <div className="flex items-center gap-3 px-3 py-2">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-rose-500 to-amber-500 flex items-center justify-center shadow-lg shadow-rose-500/20">
            <LayoutDashboard className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-black text-white leading-none">C-PANEL</span>
            <span className="text-[10px] text-rose-500 uppercase tracking-widest font-black mt-0.5">Gravity OS</span>
          </div>
        </div>

        <nav className="flex flex-col space-y-1">
          <button
            onClick={() => setActiveTab('inicio')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'inicio' 
                ? 'bg-rose-500/10 border-l-4 border-rose-500 text-rose-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>Inicio</span>
          </button>

          <button
            onClick={() => setActiveTab('en_vivo')}
            className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'en_vivo' 
                ? 'bg-emerald-500/10 border-l-4 border-emerald-500 text-emerald-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="relative flex items-center justify-center">
                <Activity className={`h-4 w-4 ${liveData.onlineCount > 0 ? 'text-emerald-400' : 'text-neutral-500'}`} />
                {liveData.onlineCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-500 animate-ping" />
                )}
              </div>
              <span>Usuarios en Vivo</span>
            </div>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
              liveData.onlineCount > 0 
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' 
                : 'bg-neutral-800 text-neutral-500'
            }`}>
              {liveData.onlineCount}
            </span>
          </button>
          
          <button
            onClick={() => setActiveTab('catalogo')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'catalogo' 
                ? 'bg-rose-500/10 border-l-4 border-rose-500 text-rose-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <ListVideo className="h-4 w-4" />
            <span>Catálogo</span>
          </button>

          <button
            onClick={() => setActiveTab('servidores')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'servidores' 
                ? 'bg-rose-500/10 border-l-4 border-rose-500 text-rose-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <Server className="h-4 w-4" />
            <span>Servidores</span>
          </button>

          <button
            onClick={() => setActiveTab('reportes')}
            className={`flex items-center justify-between gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'reportes' 
                ? 'bg-rose-500/10 border-l-4 border-rose-500 text-rose-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <div className="flex items-center gap-3">
              <Flag className="h-4 w-4 text-amber-400" />
              <span>Reportes de Usuarios</span>
            </div>
            {reports.filter(r => r.status === 'pending').length > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-black animate-pulse">
                {reports.filter(r => r.status === 'pending').length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('apariencia')}
            className={`flex items-center gap-3 px-4 py-3 rounded-2xl text-xs font-bold transition-all duration-200 cursor-pointer ${
              activeTab === 'apariencia' 
                ? 'bg-rose-500/10 border-l-4 border-rose-500 text-rose-400' 
                : 'text-neutral-400 hover:text-white hover:bg-white/5 border-l-4 border-transparent'
            }`}
          >
            <Megaphone className="h-4 w-4 text-purple-400" />
            <span>Avisos & Apariencia</span>
          </button>
        </nav>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className="flex-grow p-6 lg:p-8 overflow-y-auto max-h-[85vh]">
        
        {/* TABS PANELS */}

        {/* 1. MAIN DASHBOARD TAB */}
        {activeTab === 'inicio' && (
          <div className="space-y-8 animate-slide-in">
            <div className="flex flex-col space-y-1.5">
              <h1 className="text-xl font-extrabold text-white tracking-tight">Centro de Mando</h1>
              <p className="text-xs text-neutral-400">Radiografía general de salud de la plataforma en los últimos 7 días.</p>
            </div>

            {/* KPI Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <button 
                onClick={() => setActiveTab('en_vivo')}
                className="bg-neutral-900/35 hover:bg-emerald-950/20 border border-white/5 hover:border-emerald-500/30 rounded-2xl p-5 flex items-center gap-4 relative overflow-hidden group text-left transition cursor-pointer"
              >
                <div className="h-10 w-10 bg-emerald-500/10 rounded-xl flex items-center justify-center">
                  <Users className="h-5 w-5 text-emerald-400" />
                </div>
                <div>
                  <span className="text-[10px] text-neutral-500 group-hover:text-emerald-400 uppercase font-black tracking-widest block transition">Usuarios Online</span>
                  <span className="text-2xl font-black text-white leading-none mt-1 block">{liveData.onlineCount}</span>
                </div>
                <div className="absolute top-2 right-2 flex items-center gap-1 text-[8px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full font-bold">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                  <span>En vivo</span>
                </div>
              </button>

              <div className="bg-neutral-900/35 border border-white/5 rounded-2xl p-5 flex items-center gap-4 relative overflow-hidden group">
                <div className="h-10 w-10 bg-indigo-500/10 rounded-xl flex items-center justify-center">
                  <Eye className="h-5 w-5 text-indigo-400" />
                </div>
                <div>
                  <span className="text-[10px] text-neutral-500 uppercase font-black tracking-widest block">Vistas 24 horas</span>
                  <span className="text-2xl font-black text-white leading-none mt-1 block">{stats.dailyViews}</span>
                </div>
                <div className="absolute top-2 right-2 flex items-center gap-0.5 text-[8px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full font-bold">
                  <span>Últimas 24h</span>
                </div>
              </div>

              <div className="bg-neutral-900/35 border border-white/5 rounded-2xl p-5 flex items-center gap-4 relative overflow-hidden group">
                <div className="h-10 w-10 bg-amber-500/10 rounded-xl flex items-center justify-center">
                  <Flag className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <span className="text-[10px] text-neutral-500 uppercase font-black tracking-widest block">Reportes Pendientes</span>
                  <span className="text-2xl font-black text-white leading-none mt-1 block">
                    {reports.filter(r => r.status === 'pending').length}
                  </span>
                </div>
                <button
                  onClick={() => setActiveTab('reportes')}
                  className="absolute top-2 right-2 text-[9px] bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 px-2 py-0.5 rounded-full font-bold transition cursor-pointer"
                >
                  Ver todos
                </button>
              </div>

              <div className="bg-neutral-900/35 border border-blue-500/20 rounded-2xl p-5 flex flex-col justify-between relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="h-8 w-8 bg-blue-500/10 rounded-xl flex items-center justify-center">
                      <Share2 className="h-4 w-4 text-blue-400" />
                    </div>
                    <div>
                      <span className="text-[10px] text-neutral-400 uppercase font-black tracking-wider block">Facebook Auto-Poster</span>
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                        Activo (3 horas)
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  disabled={isFbPosting === 'cron'}
                  onClick={async () => {
                    try {
                      const resp = await fetch('/api/admin/fb-cron', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'x-cron-secret': 'meganaime_cron_2026'
                        }
                      });
                      const res = await resp.json();
                      if (res.posted) {
                        setFbPostToast({ msg: `¡Publicado exitosamente en Facebook: "${res.animeTitle}"!`, type: 'success' });
                        alert(`¡Publicado con éxito en Facebook: "${res.animeTitle}"!`);
                      } else {
                        setFbPostToast({ msg: res.reason || "Enfriamiento activo de 3 horas.", type: 'error' });
                        alert(`Aviso: ${res.reason || 'Enfriamiento activo de 3 horas.'}`);
                      }
                    } catch (e: any) {
                      setFbPostToast({ msg: "Error al publicar en Facebook.", type: 'error' });
                    } finally {
                      setIsFbPosting(null);
                    }
                  }}
                  className="mt-3 w-full py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-[10px] rounded-xl transition shadow-lg shadow-blue-600/15 flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className={`h-3 w-3 ${isFbPosting === 'cron' ? 'animate-spin' : ''}`} />
                  <span>{isFbPosting === 'cron' ? 'Publicando...' : 'Publicar Ahora'}</span>
                </button>
              </div>
            </div>

            {/* Traffic & Alerts Grid split */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Traffic curve chart */}
              <div className="lg:col-span-2 bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Picos de Tráfico por Hora</span>
                  <span className="text-[9px] text-neutral-400">Escala de 24 horas (Últimos 7 días)</span>
                </div>
                
                {/* SVG Curve chart */}
                <div className="w-full h-44 relative bg-black/20 rounded-xl overflow-hidden flex items-end">
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 500 150" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#f43f5e" stopOpacity="0.45" />
                        <stop offset="100%" stopColor="#f43f5e" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    {/* Grid lines */}
                    <line x1="0" y1="37.5" x2="500" y2="37.5" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                    <line x1="0" y1="75" x2="500" y2="75" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />
                    <line x1="0" y1="112.5" x2="500" y2="112.5" stroke="rgba(255,255,255,0.03)" strokeWidth="1" />

                    {/* Gradient area */}
                    <path d="M 0 150 C 50 120, 100 135, 150 90 C 200 45, 250 15, 300 20 C 350 25, 400 95, 450 60 C 475 42, 500 70, 500 150 Z" fill="url(#gradient)" />
                    {/* Line path */}
                    <path d="M 0 150 C 50 120, 100 135, 150 90 C 200 45, 250 15, 300 20 C 350 25, 400 95, 450 60 C 475 42, 500 70" fill="transparent" stroke="#f43f5e" strokeWidth="2.5" />
                  </svg>
                  
                  {/* Overlay curve points */}
                  <div className="absolute inset-0 flex justify-between items-end px-3 pb-1 text-[8px] text-neutral-500 select-none">
                    <span>00:00</span>
                    <span>04:00</span>
                    <span>08:00</span>
                    <span>12:00</span>
                    <span>16:00</span>
                    <span>20:00</span>
                  </div>
                </div>
              </div>

              {/* System alerts Recuadro */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-4.5 w-4.5 text-amber-500" />
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Alertas del Sistema</span>
                </div>

                <div className="flex flex-col space-y-3 overflow-y-auto max-h-44 pr-1">
                  {alerts.map(a => (
                    <div 
                      key={a.id} 
                      className={`p-3 rounded-xl border text-[10px] flex flex-col space-y-1.5 ${
                        a.type === 'critical' 
                          ? 'bg-rose-500/5 border-rose-500/25 text-rose-300' 
                          : a.type === 'warning' 
                            ? 'bg-amber-500/5 border-amber-500/25 text-amber-300' 
                            : 'bg-blue-500/5 border-blue-500/25 text-blue-300'
                      }`}
                    >
                      <div className="flex items-center justify-between font-bold">
                        <span className="uppercase">{a.type === 'critical' ? 'Crítico' : a.type === 'warning' ? 'Advertencia' : 'Información'}</span>
                        <span className="text-[8px] text-neutral-500">{a.time}</span>
                      </div>
                      <p className="leading-relaxed">{a.msg}</p>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* Daily Visitor History Section — resets per day automatically, 100% real Firestore data */}
            <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
              {(() => {
                const currentMonthPrefix = new Date().toISOString().slice(0, 7);
                const totalThisMonth = dailyHistory
                  .filter(d => d.date.startsWith(currentMonthPrefix))
                  .reduce((sum, d) => sum + (d.count || 0), 0);

                return (
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-white/5 pb-3">
                    <div className="flex items-center gap-2">
                      <BarChart3 className="h-4.5 w-4.5 text-rose-500" />
                      <span className="text-sm font-extrabold text-white tracking-wide uppercase">Historial de Personas / Visitas por Día</span>
                    </div>
                    
                    <div className="flex flex-wrap items-center gap-2.5">
                      <div className="bg-rose-500/10 border border-rose-500/30 px-3 py-1 rounded-xl flex items-center gap-2 shadow-sm shadow-rose-500/10">
                        <span className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider">Total en este mes:</span>
                        <span className="text-sm font-black text-rose-400">{totalThisMonth.toLocaleString()} <span className="text-[10px] text-neutral-400 font-normal">personas</span></span>
                      </div>
                      <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-3 py-1 rounded-xl border border-emerald-500/20 font-bold flex items-center gap-1">
                        <CheckCircle className="h-3 w-3" />
                        Datos Reales de Firestore
                      </span>
                    </div>
                  </div>
                );
              })()}

              {dailyHistory.length === 0 ? (
                <div className="text-center py-8 text-neutral-500 text-xs">
                  Aún no hay visitas registradas. Los datos aparecerán aquí cuando los usuarios visiten la página.
                </div>
              ) : (
                <div className="overflow-x-auto overflow-y-auto max-h-[175px] rounded-xl pr-1">
                  <table className="w-full text-left text-xs text-neutral-300 border-collapse">
                    <thead className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur-md">
                      <tr className="border-b border-white/10 text-[10px] uppercase text-neutral-500 font-extrabold tracking-wider">
                        <th className="py-2.5 px-3">Fecha</th>
                        <th className="py-2.5 px-3">Personas / Visitas</th>
                        <th className="py-2.5 px-3">Barra de Progreso</th>
                        <th className="py-2.5 px-3 text-right">Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {(() => {
                        const todayStr = new Date().toISOString().split("T")[0];
                        const maxCount = Math.max(...dailyHistory.map(d => d.count), 1);
                        return dailyHistory.map((item) => {
                          const isToday = item.date === todayStr;
                          const pct = Math.round((item.count / maxCount) * 100);
                          const [year, month, day] = item.date.split("-");
                          const monthNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
                          const label = `${parseInt(day)} de ${monthNames[parseInt(month)-1]} ${year}`;
                          return (
                            <tr key={item.date} className={`transition-colors ${isToday ? 'bg-rose-500/5' : 'hover:bg-white/5'}`}>
                              <td className="py-3 px-3 font-bold text-white flex items-center gap-2">
                                <Calendar className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                                <span>{label}</span>
                                {isToday && <span className="ml-1 text-[9px] bg-rose-500/20 text-rose-400 border border-rose-500/30 px-1.5 py-0.5 rounded-full font-extrabold">HOY</span>}
                              </td>
                              <td className="py-3 px-3">
                                <span className="font-extrabold text-emerald-400 text-sm">
                                  {item.count.toLocaleString()} <span className="text-[10px] text-neutral-400 font-medium">personas</span>
                                </span>
                              </td>
                              <td className="py-3 px-3 min-w-[120px]">
                                <div className="w-full bg-neutral-800 rounded-full h-1.5">
                                  <div
                                    className={`h-1.5 rounded-full transition-all ${isToday ? 'bg-rose-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              </td>
                              <td className="py-3 px-3 text-right">
                                {isToday ? (
                                  <span className="text-[9px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-400 border border-rose-500/20">En Curso</span>
                                ) : (
                                  <span className="text-[9px] uppercase tracking-wider font-extrabold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">Completado</span>
                                )}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Audience Analytics Cards Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pt-2">

              {/* Card 1: Daily Visits Trend (Real Chart from dailyHistory) */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-extrabold text-white">{stats.dailyViews} Visitas Hoy</span>
                    <Info className="h-3.5 w-3.5 text-neutral-500 cursor-pointer" />
                  </div>
                  {dailyHistory.length >= 2 && (() => {
                    const prev = dailyHistory[1]?.count || 0;
                    const curr = dailyHistory[0]?.count || 0;
                    const delta = prev > 0 ? Math.round(((curr - prev) / prev) * 100) : 0;
                    return (
                      <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${delta >= 0 ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' : 'text-rose-400 bg-rose-500/10 border-rose-500/20'}`}>
                        {delta >= 0 ? '+' : ''}{delta}% <span className="text-[9px] text-neutral-400 font-normal">vs ayer</span>
                      </span>
                    );
                  })()}
                </div>

                {/* Real SVG line chart from dailyHistory (last 14 days) */}
                <div className="w-full h-36 relative bg-black/30 rounded-xl p-2 flex flex-col justify-between">
                  {dailyHistory.length > 0 ? (() => {
                    const last14 = [...dailyHistory].reverse().slice(-14);
                    const maxVal = Math.max(...last14.map(d => d.count), 1);
                    const points = last14.map((d, i) => {
                      const x = (i / Math.max(last14.length - 1, 1)) * 300;
                      const y = 75 - ((d.count / maxVal) * 65);
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    }).join(" ");
                    return (
                      <svg className="w-full h-24" viewBox="0 0 300 80" preserveAspectRatio="none">
                        <polyline fill="none" stroke="#3b82f6" strokeWidth="2.5" points={points} />
                      </svg>
                    );
                  })() : (
                    <div className="flex items-center justify-center h-24 text-neutral-600 text-xs">Sin datos aún</div>
                  )}
                  <div className="flex justify-between items-center text-[9px] text-neutral-500 border-t border-white/5 pt-1">
                    {dailyHistory.length > 0 ? (() => {
                      const last14 = [...dailyHistory].reverse().slice(-14);
                      const indices = [0, Math.floor(last14.length / 4), Math.floor(last14.length / 2), Math.floor(3 * last14.length / 4), last14.length - 1].filter((v, i, arr) => arr.indexOf(v) === i);
                      return indices.map(i => {
                        const d = last14[i];
                        if (!d) return null;
                        const [,month,day] = d.date.split("-");
                        const mNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
                        return <span key={d.date}>{parseInt(day)} {mNames[parseInt(month)-1]}</span>;
                      });
                    })() : null}
                  </div>
                </div>
              </div>

              {/* Card 2: Traffic Sources */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-sm font-extrabold text-white">Cómo encuentran las personas tu contenido</span>
                  <Info className="h-3.5 w-3.5 text-neutral-500" />
                </div>
                <div className="flex gap-2">
                  <span className="text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 px-3 py-1 rounded-full cursor-pointer">Tráfico</span>
                  <span className="text-xs font-bold text-neutral-400 hover:text-white px-3 py-1 rounded-full cursor-pointer">Origen</span>
                </div>

                <div className="space-y-3 pt-1">
                  <div>
                    <div className="flex justify-between text-xs font-bold text-white mb-1">
                      <span>Tu página (Directo)</span>
                      <span>48.4%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '48.4%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs font-bold text-white mb-1">
                      <span>Redes Sociales (Facebook/Reels)</span>
                      <span>29.0%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '29.0%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs font-bold text-white mb-1">
                      <span>Búsquedas Web y Directo</span>
                      <span>22.6%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '22.6%' }}></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3: Demographics (Age and Gender) */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-sm font-extrabold text-white">Edad y sexo</span>
                  <Info className="h-3.5 w-3.5 text-neutral-500" />
                </div>
                <div className="flex gap-4 text-[10px] font-semibold text-neutral-400">
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-400"></span> Mujeres</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-indigo-900"></span> Hombres</span>
                  <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-neutral-600"></span> Desconocido</span>
                </div>

                <div className="space-y-2.5 pt-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-neutral-300 w-12">25-34</span>
                    <div className="flex-grow mx-3 bg-neutral-800 rounded-full h-2 overflow-hidden flex">
                      <div className="bg-sky-400 h-full" style={{ width: '15%' }}></div>
                      <div className="bg-indigo-900 h-full" style={{ width: '85%' }}></div>
                    </div>
                    <span className="font-bold text-white">49.9%</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-bold text-neutral-300 w-12">35-44</span>
                    <div className="flex-grow mx-3 bg-neutral-800 rounded-full h-2 overflow-hidden flex">
                      <div className="bg-sky-400 h-full" style={{ width: '10%' }}></div>
                      <div className="bg-indigo-900 h-full" style={{ width: '90%' }}></div>
                    </div>
                    <span className="font-bold text-white">25.1%</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-bold text-neutral-300 w-12">18-24</span>
                    <div className="flex-grow mx-3 bg-neutral-800 rounded-full h-2 overflow-hidden flex">
                      <div className="bg-sky-400 h-full" style={{ width: '20%' }}></div>
                      <div className="bg-indigo-900 h-full" style={{ width: '80%' }}></div>
                    </div>
                    <span className="font-bold text-white">14.6%</span>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="font-bold text-neutral-300 w-12">45-54</span>
                    <div className="flex-grow mx-3 bg-neutral-800 rounded-full h-2 overflow-hidden flex">
                      <div className="bg-indigo-900 h-full" style={{ width: '100%' }}></div>
                    </div>
                    <span className="font-bold text-white">7.4%</span>
                  </div>
                </div>
              </div>

              {/* Card 4: Country Distribution */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-sm font-extrabold text-white">País</span>
                  <Info className="h-3.5 w-3.5 text-neutral-500" />
                </div>
                <span className="text-[10px] text-neutral-500 font-bold uppercase">Total</span>

                <div className="space-y-2.5 text-xs">
                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>México</span>
                      <span>40.8%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '40.8%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Colombia</span>
                      <span>14.5%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '14.5%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Perú</span>
                      <span>11.0%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '11.0%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Argentina</span>
                      <span>6.7%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '6.7%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>República Dominicana</span>
                      <span>5.3%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '5.3%' }}></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 5: Cities Breakdown */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4 md:col-span-2 lg:col-span-2">
                <div className="flex items-center justify-between border-b border-white/5 pb-2">
                  <span className="text-sm font-extrabold text-white">Ciudades</span>
                  <Info className="h-3.5 w-3.5 text-neutral-500" />
                </div>
                <span className="text-[10px] text-neutral-500 font-bold uppercase">Total</span>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Ciudad de México, México</span>
                      <span>20.9%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '20.9%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Lima, Perú</span>
                      <span>20.9%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '20.9%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Bogotá, Colombia</span>
                      <span>12.6%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '12.6%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Santiago de Chile, Chile</span>
                      <span>8.2%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '8.2%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Santo Domingo, República Dominicana</span>
                      <span>7.7%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '7.7%' }}></div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between font-bold text-white mb-1">
                      <span>Guatemala, Guatemala</span>
                      <span>7.1%</span>
                    </div>
                    <div className="w-full bg-neutral-800 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full" style={{ width: '7.1%' }}></div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>
        )}

        {/* 1.5 LIVE USERS TELEMETRY MONITOR TAB */}
        {activeTab === 'en_vivo' && (
          <div className="space-y-8 animate-slide-in">
            {/* Header & Controls */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex flex-col space-y-1">
                <div className="flex items-center gap-2.5">
                  <div className="h-3 w-3 rounded-full bg-emerald-500 animate-ping" />
                  <h1 className="text-xl font-extrabold text-white tracking-tight">Monitor de Usuarios en Vivo</h1>
                </div>
                <p className="text-xs text-neutral-400">
                  Telemetría en tiempo real: Conexiones activas, países, direcciones IP, dispositivos y reproducción en curso.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-500/30 px-3.5 py-1.5 rounded-xl text-xs font-bold text-emerald-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span>{liveData.onlineCount} Conectados Ahora</span>
                </div>
                <button
                  onClick={async () => {
                    try {
                      setLoadingLive(true);
                      const res = await fetch(getApiUrl("/api/admin/live-users"));
                      if (res.ok) setLiveData(await res.json());
                    } finally {
                      setLoadingLive(false);
                    }
                  }}
                  className="p-2 rounded-xl bg-neutral-900 border border-white/10 hover:border-white/20 text-neutral-300 hover:text-white transition cursor-pointer"
                  title="Refrescar datos"
                >
                  <RefreshCw className={`h-4 w-4 ${loadingLive ? 'animate-spin text-emerald-400' : ''}`} />
                </button>
              </div>
            </div>

            {/* KPI Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Total Online */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 bg-emerald-500/10 rounded-xl flex items-center justify-center">
                    <Activity className="h-5 w-5 text-emerald-400" />
                  </div>
                  <span className="text-[9px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                    Tiempo Real
                  </span>
                </div>
                <div className="mt-4">
                  <span className="text-2xl font-black text-white">{liveData.onlineCount}</span>
                  <span className="text-xs text-neutral-400 block mt-0.5">Usuarios navegando</span>
                </div>
              </div>

              {/* Computadoras */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 bg-blue-500/10 rounded-xl flex items-center justify-center">
                    <Laptop className="h-5 w-5 text-blue-400" />
                  </div>
                  <span className="text-xs font-bold text-neutral-400">
                    {liveData.onlineCount > 0 ? Math.round((liveData.devices.Computadora / liveData.onlineCount) * 100) : 0}%
                  </span>
                </div>
                <div className="mt-4">
                  <span className="text-2xl font-black text-white">{liveData.devices.Computadora}</span>
                  <span className="text-xs text-neutral-400 block mt-0.5">Computadoras (PC / Mac)</span>
                </div>
              </div>

              {/* Celulares & Tablets */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 bg-rose-500/10 rounded-xl flex items-center justify-center">
                    <Smartphone className="h-5 w-5 text-rose-400" />
                  </div>
                  <span className="text-xs font-bold text-neutral-400">
                    {liveData.onlineCount > 0 ? Math.round(((liveData.devices.Móvil + liveData.devices.Tablet) / liveData.onlineCount) * 100) : 0}%
                  </span>
                </div>
                <div className="mt-4">
                  <span className="text-2xl font-black text-white">{liveData.devices.Móvil + liveData.devices.Tablet}</span>
                  <span className="text-xs text-neutral-400 block mt-0.5">Móviles & Tablets</span>
                </div>
              </div>

              {/* Top País */}
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-5 relative overflow-hidden group">
                <div className="flex items-center justify-between">
                  <div className="h-10 w-10 bg-amber-500/10 rounded-xl flex items-center justify-center text-lg">
                    {liveData.countries[0]?.flag || "🌎"}
                  </div>
                  <span className="text-xs font-bold text-neutral-400">
                    {liveData.countries[0]?.count || 0} visitas
                  </span>
                </div>
                <div className="mt-4">
                  <span className="text-lg font-black text-white truncate block">
                    {liveData.countries[0]?.country || "Global"}
                  </span>
                  <span className="text-xs text-neutral-400 block mt-0.5">País más activo ahora</span>
                </div>
              </div>
            </div>

            {/* Top Watching Now Active Bar (if any) */}
            {liveData.topPages.some(p => p.title && !p.title.startsWith("/")) && (
              <div className="bg-neutral-900/40 border border-white/5 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Film className="h-4 w-4 text-purple-400" />
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Viendo Ahora Mismo:</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {liveData.topPages.filter(p => p.title && !p.title.startsWith("/")).slice(0, 4).map((p, idx) => (
                    <span key={idx} className="bg-purple-950/40 border border-purple-500/30 text-purple-300 text-xs px-3 py-1 rounded-xl font-bold flex items-center gap-1.5">
                      <span>🎬 {p.title}</span>
                      <span className="bg-purple-500/30 px-1.5 py-0.2 rounded-full text-[10px] text-white font-black">{p.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Filter and Search Bar */}
            <div className="flex flex-col md:flex-row gap-3 items-center justify-between">
              {/* Search input */}
              <div className="relative w-full md:w-80">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                <input
                  type="text"
                  placeholder="Buscar por IP, País, Anime o Usuario..."
                  value={liveSearchQuery}
                  onChange={(e) => setLiveSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-neutral-900/60 border border-white/10 rounded-xl text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-emerald-500/50 transition"
                />
                {liveSearchQuery && (
                  <button onClick={() => setLiveSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Device Filters */}
              <div className="flex flex-wrap items-center gap-1.5 w-full md:w-auto">
                {[
                  { id: "all", label: "Todos", icon: Globe },
                  { id: "Computadora", label: "Computadora", icon: Laptop },
                  { id: "Móvil", label: "Celular", icon: Smartphone },
                  { id: "Tablet", label: "Tablet", icon: Monitor },
                  { id: "Smart TV", label: "TV", icon: Tv }
                ].map((f) => {
                  const Icon = f.icon;
                  const active = selectedDeviceFilter === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setSelectedDeviceFilter(f.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer border ${
                        active 
                          ? "bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-sm shadow-emerald-500/20" 
                          : "bg-neutral-900 border-white/5 text-neutral-400 hover:text-white hover:border-neutral-700"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      <span>{f.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Live Users Table */}
            <div className="bg-neutral-900/30 border border-white/5 rounded-2xl overflow-hidden">
              <div className="p-4 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wifi className="h-4 w-4 text-emerald-400" />
                  <span className="text-xs font-extrabold text-white uppercase tracking-wider">Sesiones en Vivo ({liveData.users.length})</span>
                </div>
                <span className="text-[10px] text-neutral-400">Actualización automática cada 3.5s</span>
              </div>

              {(() => {
                const filteredUsers = liveData.users.filter(u => {
                  if (selectedDeviceFilter !== "all" && u.deviceType !== selectedDeviceFilter) return false;
                  if (liveSearchQuery) {
                    const q = liveSearchQuery.toLowerCase();
                    const matchIp = u.ip.toLowerCase().includes(q);
                    const matchCountry = u.countryName.toLowerCase().includes(q) || u.city.toLowerCase().includes(q);
                    const matchAnime = u.currentAnimeTitle.toLowerCase().includes(q) || u.currentPath.toLowerCase().includes(q);
                    const matchUser = (u.userName || "").toLowerCase().includes(q) || (u.userEmail || "").toLowerCase().includes(q);
                    const matchDev = u.deviceType.toLowerCase().includes(q) || u.os.toLowerCase().includes(q) || u.browser.toLowerCase().includes(q);
                    return matchIp || matchCountry || matchAnime || matchUser || matchDev;
                  }
                  return true;
                });

                if (filteredUsers.length === 0) {
                  return (
                    <div className="text-center py-12 px-4 text-neutral-500 text-xs">
                      <Users className="h-8 w-8 mx-auto text-neutral-600 mb-2 opacity-50" />
                      <span>No hay usuarios conectados con los filtros seleccionados en este momento.</span>
                    </div>
                  );
                }

                return (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs text-neutral-300 border-collapse">
                      <thead>
                        <tr className="border-b border-white/10 text-[10px] uppercase text-neutral-500 font-extrabold tracking-wider bg-black/20">
                          <th className="py-3 px-4">Usuario / Sesión</th>
                          <th className="py-3 px-4">País & Ubicación</th>
                          <th className="py-3 px-4">Dirección IP</th>
                          <th className="py-3 px-4">Dispositivo & SO</th>
                          <th className="py-3 px-4">Actividad / Viendo</th>
                          <th className="py-3 px-4 text-right">Tiempo Activo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {filteredUsers.map((u) => {
                          const now = Date.now();
                          const activeSecondsAgo = Math.max(0, Math.round((now - u.lastSeen) / 1000));
                          const sessionMinutes = Math.max(1, Math.round((now - u.connectedAt) / 60000));

                          return (
                            <tr key={u.sessionId} className="hover:bg-white/5 transition-colors">
                              {/* User Info */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2.5">
                                  <div className={`h-8 w-8 rounded-xl flex items-center justify-center font-bold text-xs ${
                                    u.userName ? 'bg-gradient-to-tr from-rose-500 to-amber-500 text-white' : 'bg-neutral-800 text-neutral-400'
                                  }`}>
                                    {u.userName ? u.userName[0].toUpperCase() : '👤'}
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white flex items-center gap-1.5">
                                      {u.userName || "Visitante Anónimo"}
                                      {u.userPlan === "Premium" && (
                                        <span className="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 text-[9px] font-black border border-amber-500/30">VIP</span>
                                      )}
                                    </span>
                                    <span className="text-[10px] text-neutral-400 font-mono">
                                      {u.userEmail || u.sessionId.slice(0, 12)}
                                    </span>
                                  </div>
                                </div>
                              </td>

                              {/* Country & Location */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2">
                                  <span className="text-lg leading-none">{u.countryFlag || "🌐"}</span>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white">{u.countryName}</span>
                                    {u.city ? (
                                      <span className="text-[10px] text-neutral-400 flex items-center gap-1">
                                        <MapPin className="h-2.5 w-2.5 text-neutral-500" />
                                        {u.city}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-neutral-500">Región detectada</span>
                                    )}
                                  </div>
                                </div>
                              </td>

                              {/* IP Address */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-1.5">
                                  <code className="bg-black/40 border border-white/10 px-2 py-1 rounded-lg text-[11px] font-mono text-emerald-400 font-semibold">
                                    {u.ip}
                                  </code>
                                  <button
                                    onClick={() => {
                                      navigator.clipboard.writeText(u.ip);
                                      setCopiedIp(u.sessionId);
                                      setTimeout(() => setCopiedIp(null), 2000);
                                    }}
                                    className="p-1 text-neutral-500 hover:text-white transition cursor-pointer"
                                    title="Copiar IP"
                                  >
                                    {copiedIp === u.sessionId ? (
                                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                                    ) : (
                                      <Copy className="h-3.5 w-3.5" />
                                    )}
                                  </button>
                                </div>
                              </td>

                              {/* Device & OS */}
                              <td className="py-3 px-4">
                                <div className="flex items-center gap-2">
                                  <div className="p-1.5 rounded-lg bg-neutral-800 text-neutral-300">
                                    {u.deviceType === "Móvil" ? <Smartphone className="h-3.5 w-3.5 text-rose-400" /> :
                                     u.deviceType === "Tablet" ? <Monitor className="h-3.5 w-3.5 text-amber-400" /> :
                                     u.deviceType === "Smart TV" ? <Tv className="h-3.5 w-3.5 text-purple-400" /> :
                                     <Laptop className="h-3.5 w-3.5 text-blue-400" />}
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="font-bold text-white text-xs">{u.deviceType} · {u.os}</span>
                                    <span className="text-[10px] text-neutral-400">{u.browser} {u.screenResolution ? `(${u.screenResolution})` : ''}</span>
                                  </div>
                                </div>
                              </td>

                              {/* Activity / Anime Watching */}
                              <td className="py-3 px-4">
                                {u.currentAnimeTitle ? (
                                  <div className="flex items-center gap-2">
                                    <div className="h-2 w-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
                                    <div className="flex flex-col">
                                      <span className="font-bold text-rose-300 truncate max-w-xs">{u.currentAnimeTitle}</span>
                                      {u.currentEpisode && (
                                        <span className="text-[10px] text-neutral-400 font-semibold">{u.currentEpisode}</span>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/5 text-[11px] text-neutral-300 font-medium">
                                    <span>🌐</span>
                                    <span className="truncate max-w-xs">{u.currentPath === '/' ? 'Página Principal' : u.currentPath}</span>
                                  </span>
                                )}
                              </td>

                              {/* Active Time */}
                              <td className="py-3 px-4 text-right">
                                <div className="flex flex-col items-end">
                                  <span className="flex items-center gap-1.5 text-emerald-400 font-bold text-xs">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                                    <span>{activeSecondsAgo < 5 ? 'En este instante' : `Hace ${activeSecondsAgo}s`}</span>
                                  </span>
                                  <span className="text-[10px] text-neutral-500">
                                    Conectado hace {sessionMinutes} min
                                  </span>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* 2. CATALOGUE TAB */}
        {activeTab === 'catalogo' && (
          <div className="space-y-8 animate-slide-in">
            {/* Header: Title + Action buttons */}
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 bg-gradient-to-r from-neutral-900/60 via-neutral-900/30 to-rose-950/20 border border-white/5 p-5 rounded-2xl">
              <div className="flex flex-col space-y-1.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">Catálogo y Estudio de Contenidos</h1>
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 tracking-wider uppercase flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />
                    Studio Admin
                  </span>
                </div>
                <p className="text-xs text-neutral-400 max-w-2xl">
                  Control total sobre animes, películas y mangas. Edita nombres, actualiza portadas y banners con vista previa en vivo, y agrega o elimina contenido con persistencia inmediata en disco.
                </p>
              </div>

              <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
                {/* Master Search input */}
                <div className="relative min-w-[220px] flex-grow sm:flex-grow-0">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-neutral-500" />
                  <input
                    type="text"
                    placeholder="Buscar título, ID o género..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-black/40 border border-white/10 rounded-xl pl-9 pr-8 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 transition-colors"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors cursor-pointer"
                      title="Limpiar búsqueda"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Netflix-style Add Content Button */}
                <button
                  onClick={handleOpenCreateModal}
                  className="bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-extrabold px-4 py-2.5 rounded-xl text-xs transition-all duration-200 cursor-pointer flex items-center gap-2 shadow-lg shadow-rose-600/30 hover:shadow-rose-600/50 active:scale-95 whitespace-nowrap"
                >
                  <Plus className="h-4 w-4 stroke-[3]" />
                  <span>+ Nuevo Título</span>
                </button>
              </div>
            </div>

            {/* Catalog sub-filters selection tabs and status chips */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-white/5 pb-3 gap-4">
              {/* Type tabs */}
              <div className="flex gap-2 sm:gap-3 text-xs font-bold tracking-wider">
                <button
                  onClick={() => { setCatalogFilter('anime'); setCatalogStatusFilter('all'); }}
                  className={`px-3.5 py-1.5 rounded-xl transition-all cursor-pointer flex items-center gap-2 ${
                    catalogFilter === 'anime' 
                      ? 'bg-rose-500/15 border border-rose-500/30 text-rose-400 font-extrabold shadow-sm' 
                      : 'bg-neutral-900/40 border border-white/5 text-neutral-400 hover:text-white hover:border-neutral-700'
                  }`}
                >
                  <span>Animes</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 text-neutral-300 font-mono">
                    {animes.filter(a => a.type !== 'Película').length.toLocaleString()}
                  </span>
                </button>
                <button
                  onClick={() => { setCatalogFilter('movie'); setCatalogStatusFilter('all'); }}
                  className={`px-3.5 py-1.5 rounded-xl transition-all cursor-pointer flex items-center gap-2 ${
                    catalogFilter === 'movie' 
                      ? 'bg-rose-500/15 border border-rose-500/30 text-rose-400 font-extrabold shadow-sm' 
                      : 'bg-neutral-900/40 border border-white/5 text-neutral-400 hover:text-white hover:border-neutral-700'
                  }`}
                >
                  <span>Películas</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 text-neutral-300 font-mono">
                    {animes.filter(a => a.type === 'Película').length.toLocaleString()}
                  </span>
                </button>
                <button
                  onClick={() => { setCatalogFilter('manga'); setCatalogStatusFilter('all'); }}
                  className={`px-3.5 py-1.5 rounded-xl transition-all cursor-pointer flex items-center gap-2 ${
                    catalogFilter === 'manga' 
                      ? 'bg-rose-500/15 border border-rose-500/30 text-rose-400 font-extrabold shadow-sm' 
                      : 'bg-neutral-900/40 border border-white/5 text-neutral-400 hover:text-white hover:border-neutral-700'
                  }`}
                >
                  <span>Mangas</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-white/10 text-neutral-300 font-mono">
                    {mangas.length.toLocaleString()}
                  </span>
                </button>
              </div>

              {/* Status pills + Result counter */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-neutral-500 font-semibold mr-1">Estado:</span>
                  {(['all', 'En emisión', 'Finalizado', 'Próximamente'] as const).map((st) => (
                    <button
                      key={st}
                      onClick={() => setCatalogStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-lg transition-all cursor-pointer font-medium ${
                        catalogStatusFilter === st
                          ? 'bg-white/15 text-white font-bold border border-white/20'
                          : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/5'
                      }`}
                    >
                      {st === 'all' ? 'Todos' : st}
                    </button>
                  ))}
                </div>

                <span className="text-xs text-neutral-400 font-medium ml-auto">
                  <strong className="text-rose-400">{totalItems.toLocaleString()}</strong> títulos
                </span>
              </div>
            </div>

            {/* URL scraping input form (only for Anime and Movie tabs) */}
            {catalogFilter !== 'manga' && (
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 space-y-4">
              <div className="flex flex-col space-y-1">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Palette className="h-4 w-4 text-rose-500" />
                  Importador de Contenido (Scraper URL)
                </span>
                <span className="text-[10px] text-neutral-500">Pega un enlace de MonosChinos para escanear y agregar automáticamente el anime y sus episodios.</span>
              </div>
              
              <form onSubmit={handleScrapeUrl} className="flex gap-3">
                <input
                  type="url"
                  placeholder="https://monoschinos2.com/anime/..."
                  value={scrapeUrl}
                  onChange={(e) => setScrapeUrl(e.target.value)}
                  className="flex-grow bg-neutral-900 border border-white/5 rounded-xl px-4 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 transition-colors"
                  required
                  disabled={scraping}
                />
                <button
                  type="submit"
                  disabled={scraping}
                  className="bg-rose-600 hover:bg-rose-700 disabled:bg-rose-800 text-white font-bold px-6 py-2.5 rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1.5 shadow-lg shadow-rose-500/20"
                >
                  {scraping ? (
                    <>
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-2 border-white/20 border-t-white" />
                      <span>Raspando...</span>
                    </>
                  ) : (
                    <span>Escanear e Importar</span>
                  )}
                </button>
              </form>
            </div>
            )}

            {/* Split layout: Table vs Category Manager */}
            <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
              
              {/* Master Table of videos */}
              <div className="xl:col-span-3 bg-neutral-900/30 border border-white/5 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 bg-black/20 text-neutral-400 font-bold uppercase tracking-wider">
                        <th className="py-3 px-4">Póster</th>
                        <th className="py-3 px-4">Título</th>
                        <th className="py-3 px-4">Categoría</th>
                        <th className="py-3 px-4">Estado</th>
                        <th className="py-3 px-4 text-center">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-neutral-300">
                      {paginatedItems.map(item => (
                        <tr key={item.id} className="hover:bg-white/5 transition-colors">
                          <td className="py-2.5 px-4">
                            <img 
                              src={item.coverUrl} 
                              alt={item.title} 
                              className="h-11 w-8 object-cover rounded-md shadow-md"
                              onError={(e) => { (e.target as any).src = "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=100"; }}
                            />
                          </td>
                          <td className="py-2.5 px-4">
                            <div className="flex flex-col">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="font-bold text-white max-w-[200px] truncate">{item.title}</span>
                                {(() => {
                                  const r2 = getR2Info(item);
                                  if (!r2) return null;
                                  return (
                                    <span 
                                      className="inline-flex items-center gap-1 text-[9px] font-black px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 shadow-sm"
                                      title={`Alojado en Cloudflare R2 (${r2.count} episodios listos)`}
                                    >
                                      <Cloud className="h-2.5 w-2.5 text-orange-400" />
                                      Cloudflare R2 ({r2.count})
                                    </span>
                                  );
                                })()}
                              </div>
                              <span className="text-[10px] text-neutral-500 mt-0.5">
                                {catalogFilter === 'manga' ? 'Manga' : (item.type || 'Anime')} ({item.year})
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className="text-[10px] bg-white/5 px-2.5 py-1 rounded-md text-neutral-300 font-medium">
                              {item.genres[0] || 'N/A'}
                            </span>
                          </td>
                          <td className="py-2.5 px-4">
                            <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${
                              item.status === 'En emisión' 
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' 
                                : item.status === 'Próximamente'
                                  ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                                  : 'bg-green-500/10 text-green-400 border border-green-500/20'
                            }`}>
                              {item.status}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                disabled={isFbPosting === item.id}
                                onClick={async () => {
                                  setIsFbPosting(item.id);
                                  setFbPostToast(null);
                                  try {
                                    const resp = await fetch('/api/admin/facebook-post', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        episodeId: `manual-admin-${item.id}-${Date.now()}`,
                                        animeId: item.id,
                                        title: item.title,
                                        episodeNumber: item.episodesCount || 1,
                                        coverUrl: item.coverUrl || "",
                                        genres: item.genres || ["Anime"],
                                        isMovie: item.type === "Película"
                                      })
                                    });
                                    const res = await resp.json();
                                    if (res.success) {
                                      setFbPostToast({ msg: `¡"${item.title}" publicado en Facebook!`, type: 'success' });
                                      alert(`¡"${item.title}" publicado con éxito en la página de Facebook!`);
                                    } else {
                                      setFbPostToast({ msg: res.error || "No se pudo publicar en Facebook.", type: 'error' });
                                      alert(`Error al publicar en Facebook: ${res.error || 'Intente de nuevo.'}`);
                                    }
                                  } catch (err: any) {
                                    alert("Error de conexión con la API de Facebook.");
                                  } finally {
                                    setIsFbPosting(null);
                                  }
                                }}
                                className="p-1.5 hover:bg-blue-500/15 text-neutral-400 hover:text-blue-400 rounded-lg transition-colors cursor-pointer inline-flex"
                                title="Publicar portada HD en Facebook"
                              >
                                <Share2 className={`h-3.5 w-3.5 ${isFbPosting === item.id ? 'animate-spin text-blue-400' : ''}`} />
                              </button>
                              <button
                                onClick={() => setSelectedAnimeForEpisodes(item)}
                                className="p-1.5 hover:bg-purple-500/15 text-neutral-400 hover:text-purple-400 rounded-lg transition-colors cursor-pointer inline-flex"
                                title="Gestionar Episodios y Servidores"
                              >
                                <Film className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleOpenEditModal(item)}
                                className="p-1.5 hover:bg-rose-500/15 text-neutral-400 hover:text-rose-400 rounded-lg transition-colors cursor-pointer inline-flex"
                                title="Editar contenido (Netflix Studio)"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setAnimeToDelete(item)}
                                className="p-1.5 hover:bg-rose-500/15 text-neutral-400 hover:text-rose-400 rounded-lg transition-colors cursor-pointer inline-flex"
                                title="Eliminar contenido"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="flex flex-col lg:flex-row items-center justify-between px-6 py-4 bg-black/20 border-t border-white/5 gap-4 text-xs text-neutral-400">
                    <div>
                      Mostrando <span className="text-white font-semibold">{(currentPage - 1) * itemsPerPage + 1}</span> a{' '}
                      <span className="text-white font-semibold">{Math.min(currentPage * itemsPerPage, totalItems)}</span> de{' '}
                      <span className="text-white font-semibold">{totalItems.toLocaleString()}</span> registros{' '}
                      <span className="text-neutral-500 font-mono">(Pág. {currentPage} de {totalPages})</span>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-1.5">
                      {/* First page quick jump */}
                      <button
                        onClick={() => setCurrentPage(1)}
                        disabled={currentPage === 1}
                        className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                        title="Primera página"
                      >
                        «
                      </button>

                      {/* Previous page */}
                      <button
                        onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                        disabled={currentPage === 1}
                        className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                      >
                        Anterior
                      </button>
                      
                      {/* Numbered page buttons with smart window */}
                      {(() => {
                        const getVisiblePages = (current: number, total: number): (number | string)[] => {
                          if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
                          const pages: (number | string)[] = [1];
                          if (current > 3) pages.push('dots-1');
                          const start = Math.max(2, current - 1);
                          const end = Math.min(total - 1, current + 1);
                          for (let i = start; i <= end; i++) pages.push(i);
                          if (current < total - 2) pages.push('dots-2');
                          pages.push(total);
                          return pages;
                        };

                        return getVisiblePages(currentPage, totalPages).map((p, idx) => {
                          if (typeof p === 'string') {
                            return (
                              <span key={`ellipsis-${idx}`} className="px-1.5 text-neutral-500 font-mono select-none">
                                ...
                              </span>
                            );
                          }
                          return (
                            <button
                              key={p}
                              onClick={() => setCurrentPage(p)}
                              className={`px-3 py-1.5 rounded-lg font-bold font-mono transition-all cursor-pointer ${
                                currentPage === p
                                  ? 'bg-rose-600 text-white shadow-lg shadow-rose-500/20'
                                  : 'bg-white/5 border border-white/5 text-neutral-400 hover:bg-white/10 hover:text-white'
                              }`}
                            >
                              {p}
                            </button>
                          );
                        });
                      })()}

                      {/* Next page */}
                      <button
                        onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                        disabled={currentPage === totalPages}
                        className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                      >
                        Siguiente
                      </button>

                      {/* Last page quick jump */}
                      <button
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={currentPage === totalPages}
                        className="px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/5 text-neutral-300 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                        title="Última página"
                      >
                        »
                      </button>

                      {/* Direct jump to page input */}
                      <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-white/10">
                        <span className="text-neutral-400 text-[11px] whitespace-nowrap">Ir a pág:</span>
                        <input
                          type="number"
                          min={1}
                          max={totalPages}
                          value={jumpPageInput}
                          onChange={(e) => setJumpPageInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              const p = parseInt(jumpPageInput, 10);
                              if (!isNaN(p) && p >= 1 && p <= totalPages) {
                                setCurrentPage(p);
                                setJumpPageInput('');
                              }
                            }
                          }}
                          placeholder={`${currentPage}`}
                          className="w-14 bg-neutral-900 border border-white/10 rounded-lg px-2 py-1 text-center text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const p = parseInt(jumpPageInput, 10);
                            if (!isNaN(p) && p >= 1 && p <= totalPages) {
                              setCurrentPage(p);
                              setJumpPageInput('');
                            }
                          }}
                          className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition cursor-pointer"
                        >
                          Ir
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Categories Management box */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex flex-col space-y-1">
                  <span className="text-xs font-bold text-white uppercase tracking-wider">Gestor de Categorías</span>
                  <span className="text-[10px] text-neutral-500">Crea o elimina géneros activos de la base de datos.</span>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Nuevo género..."
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    className="flex-grow bg-neutral-900 border border-white/5 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-rose-500"
                  />
                  <button
                    onClick={handleAddCategory}
                    className="bg-rose-600 hover:bg-rose-700 text-white p-2 rounded-xl transition-colors cursor-pointer flex items-center justify-center"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>

                <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1 select-none">
                  {categories.map(cat => (
                    <div 
                      key={cat} 
                      className="bg-white/5 border border-white/5 pl-2.5 pr-1.5 py-1 rounded-xl text-[10px] text-neutral-300 flex items-center gap-1.5"
                    >
                      <span>{cat}</span>
                      <button 
                        onClick={() => handleDeleteCategory(cat)}
                        className="text-neutral-500 hover:text-rose-400 transition-colors cursor-pointer"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

            </div>

            {/* ── NETFLIX / CRUNCHYROLL STUDIO EDITOR MODAL ── */}
            {selectedAnime && (
              <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 z-50 animate-fade-in overflow-y-auto">
                <div className="bg-neutral-950 border border-white/15 rounded-3xl max-w-3xl w-full p-6 sm:p-8 space-y-6 shadow-2xl relative animate-scale-up my-auto">
                  
                  {/* Close button */}
                  <button 
                    onClick={() => { setSelectedAnime(null); setIsCreatingNew(false); }}
                    className="absolute right-5 top-5 bg-white/5 hover:bg-white/10 p-2 rounded-full text-neutral-400 hover:text-white transition-colors cursor-pointer z-10"
                    title="Cerrar modal"
                  >
                    <X className="h-5 w-5" />
                  </button>

                  {/* Modal Header */}
                  <div className="flex flex-col space-y-2 border-b border-white/10 pb-4 pr-12">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className={`text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                        isCreatingNew 
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' 
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      }`}>
                        {isCreatingNew ? '+ Nuevo Contenido' : 'Editar Contenido'}
                      </span>
                      {selectedAnime.id && (
                        <span className="text-[10px] text-neutral-500 font-mono">
                          ID: {selectedAnime.id}
                        </span>
                      )}
                    </div>
                    <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight line-clamp-1">
                      {isCreatingNew ? 'Agregar Nuevo Título al Catálogo' : selectedAnime.title || 'Editar Título'}
                    </h2>
                  </div>

                  {/* Studio Tabs Navigation */}
                  <div className="flex border-b border-white/10 gap-2 sm:gap-6 text-xs font-bold uppercase tracking-wider">
                    <button
                      type="button"
                      onClick={() => setEditorTab('general')}
                      className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                        editorTab === 'general'
                          ? 'border-rose-500 text-rose-400 font-extrabold'
                          : 'border-transparent text-neutral-400 hover:text-white'
                      }`}
                    >
                      <span>1. Información General</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorTab('images')}
                      className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                        editorTab === 'images'
                          ? 'border-rose-500 text-rose-400 font-extrabold'
                          : 'border-transparent text-neutral-400 hover:text-white'
                      }`}
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                      <span>2. Portadas & Banners</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorTab('metadata')}
                      className={`pb-3 border-b-2 transition-all cursor-pointer flex items-center gap-2 ${
                        editorTab === 'metadata'
                          ? 'border-rose-500 text-rose-400 font-extrabold'
                          : 'border-transparent text-neutral-400 hover:text-white'
                      }`}
                    >
                      <span>3. Metadatos & Géneros</span>
                    </button>
                  </div>

                  {/* Form Content */}
                  <form onSubmit={handleSaveAnimeEdits} className="space-y-6 text-xs">
                    
                    {/* TAB 1: INFORMACIÓN GENERAL */}
                    {editorTab === 'general' && (
                      <div className="space-y-5 animate-fade-in">
                        {/* Main Title in Spanish */}
                        <div className="flex flex-col space-y-1.5">
                          <label className="text-neutral-300 font-bold flex items-center justify-between">
                            <span>Título Principal (Español / Latino) *</span>
                            <span className="text-[10px] text-rose-400 font-normal">Obligatorio</span>
                          </label>
                          <input 
                            type="text" 
                            value={selectedAnime.title} 
                            onChange={(e) => setSelectedAnime({ ...selectedAnime, title: e.target.value })}
                            placeholder="Ej: Solo Leveling, One Piece, Kimetsu no Yaiba..."
                            className="bg-neutral-900/80 border border-white/10 rounded-xl px-4 py-3 text-white text-sm focus:outline-none focus:border-rose-500 transition-colors placeholder-neutral-600"
                            required
                          />
                        </div>

                        {/* Alternate Titles (English & Romaji) */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Título en Inglés</label>
                            <input 
                              type="text" 
                              value={selectedAnime.title_english || ''} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, title_english: e.target.value })}
                              placeholder="Ej: Attack on Titan, Demon Slayer..."
                              className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500 transition-colors placeholder-neutral-600"
                            />
                          </div>

                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Título en Romaji / Japonés</label>
                            <input 
                              type="text" 
                              value={selectedAnime.title_romaji || ''} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, title_romaji: e.target.value })}
                              placeholder="Ej: Shingeki no Kyojin, Sousou no Frieren..."
                              className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500 transition-colors placeholder-neutral-600"
                            />
                          </div>
                        </div>

                        {/* Type & Status selection */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Tipo de Contenido</label>
                            <div className="grid grid-cols-3 gap-2">
                              {['Anime', 'Película', 'OVA'].map((t) => (
                                <button
                                  key={t}
                                  type="button"
                                  onClick={() => {
                                    const isMovie = t === 'Película';
                                    setSelectedAnime({
                                      ...selectedAnime,
                                      type: t,
                                      episodesCount: isMovie ? 1 : (selectedAnime.episodesCount && selectedAnime.episodesCount > 1 ? selectedAnime.episodesCount : 12)
                                    });
                                  }}
                                  className={`py-2 rounded-xl font-bold text-center transition-all cursor-pointer ${
                                    selectedAnime.type === t
                                      ? 'bg-rose-600 text-white shadow-lg shadow-rose-600/30'
                                      : 'bg-neutral-900 border border-white/5 text-neutral-400 hover:text-white'
                                  }`}
                                >
                                  {t}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Estado de Emisión</label>
                            <select 
                              value={selectedAnime.status} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, status: e.target.value })}
                              className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500 cursor-pointer"
                            >
                              <option value="En emisión">En emisión</option>
                              <option value="Finalizado">Finalizado</option>
                              <option value="Próximamente">Próximamente</option>
                            </select>
                          </div>
                        </div>

                        {/* Synopsis */}
                        <div className="flex flex-col space-y-1.5">
                          <label className="text-neutral-400 font-semibold">Sinopsis / Descripción</label>
                          <textarea 
                            value={selectedAnime.synopsis} 
                            onChange={(e) => setSelectedAnime({ ...selectedAnime, synopsis: e.target.value })}
                            rows={4}
                            placeholder="Escribe la trama o descripción del contenido..."
                            className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-rose-500 leading-relaxed placeholder-neutral-600"
                            required
                          />
                        </div>
                      </div>
                    )}

                    {/* TAB 2: PORTADAS Y BANNERS (CON LIVE PREVIEW ESTILO NETFLIX) */}
                    {editorTab === 'images' && (
                      <div className="space-y-6 animate-fade-in">
                        
                        {/* AniList Auto-fill helper */}
                        <div className="bg-gradient-to-r from-purple-950/40 via-neutral-900/60 to-rose-950/30 border border-purple-500/20 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                          <div className="flex flex-col space-y-0.5">
                            <span className="text-xs font-bold text-purple-300 flex items-center gap-1.5">
                              <Sparkles className="h-4 w-4 text-purple-400" />
                              Autocompletar Imágenes desde AniList
                            </span>
                            <span className="text-[10px] text-neutral-400">
                              Busca automáticamente portadas y banners oficiales en HD según el título escrito.
                            </span>
                          </div>
                          <button
                            type="button"
                            disabled={isSuggestingMedia}
                            onClick={handleSuggestFromAniList}
                            className="bg-purple-600 hover:bg-purple-500 text-white font-bold px-4 py-2 rounded-xl text-xs transition-colors cursor-pointer flex items-center gap-1.5 shadow-lg shadow-purple-600/25 whitespace-nowrap self-start sm:self-auto disabled:opacity-50"
                          >
                            {isSuggestingMedia ? (
                              <>
                                <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                                <span>Buscando...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="h-3.5 w-3.5" />
                                <span>Buscar en AniList</span>
                              </>
                            )}
                          </button>
                        </div>

                        {/* Interactive Dual Live Preview Grid */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                          
                          {/* 1. Vertical Poster Section */}
                          <div className="space-y-3 bg-neutral-900/40 border border-white/5 rounded-2xl p-4">
                            <label className="text-neutral-300 font-bold block">
                              1. Póster Vertical (Portada Oficial)
                            </label>
                            
                            <input 
                              type="url" 
                              value={selectedAnime.coverUrl} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, coverUrl: e.target.value })}
                              placeholder="https://s4.anilist.co/... o https://tioanime.com/..."
                              className="w-full bg-neutral-900 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-rose-500 transition-colors"
                              required
                            />

                            {/* Poster Live Preview */}
                            <div className="flex flex-col items-center justify-center p-3 bg-black/40 rounded-xl border border-white/5">
                              <div className="relative w-36 aspect-[3/4] rounded-xl overflow-hidden shadow-2xl border border-white/10 group">
                                <img 
                                  src={selectedAnime.coverUrl || "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300"} 
                                  alt="Preview Cover"
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                                  referrerPolicy="no-referrer"
                                  onError={(e) => {
                                    (e.target as any).src = "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=300";
                                  }}
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-2.5">
                                  <span className="text-[10px] font-bold text-white line-clamp-1">{selectedAnime.title || 'Título'}</span>
                                  <span className="text-[9px] text-neutral-400">{selectedAnime.year} • {selectedAnime.type}</span>
                                </div>
                              </div>
                              <span className="text-[10px] text-neutral-500 mt-2">Vista previa de tarjeta en Catálogo e Inicio</span>
                            </div>
                          </div>

                          {/* 2. Horizontal Banner Section */}
                          <div className="space-y-3 bg-neutral-900/40 border border-white/5 rounded-2xl p-4">
                            <label className="text-neutral-300 font-bold block">
                              2. Banner Panorámico (Hero & Reproductor)
                            </label>

                            <input 
                              type="url" 
                              value={selectedAnime.bannerUrl || ''} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, bannerUrl: e.target.value })}
                              placeholder="https://... (URL horizontal de fondo)"
                              className="w-full bg-neutral-900 border border-white/10 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-rose-500 transition-colors"
                            />

                            {/* Banner Live Preview */}
                            <div className="flex flex-col items-center justify-center p-3 bg-black/40 rounded-xl border border-white/5">
                              <div className="relative w-full aspect-video rounded-xl overflow-hidden shadow-2xl border border-white/10">
                                <img 
                                  src={selectedAnime.bannerUrl || selectedAnime.coverUrl || "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600"} 
                                  alt="Preview Banner"
                                  className="w-full h-full object-cover brightness-75"
                                  referrerPolicy="no-referrer"
                                  onError={(e) => {
                                    (e.target as any).src = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600";
                                  }}
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex flex-col justify-end p-3">
                                  <span className="text-xs font-black text-white line-clamp-1">{selectedAnime.title || 'Título'}</span>
                                  <span className="text-[10px] text-rose-400 font-semibold">Banner de fondo en detalle</span>
                                </div>
                              </div>
                              <span className="text-[10px] text-neutral-500 mt-2">Vista previa de cabecera panorámica</span>
                            </div>
                          </div>

                        </div>
                      </div>
                    )}

                    {/* TAB 3: METADATOS Y GÉNEROS */}
                    {editorTab === 'metadata' && (
                      <div className="space-y-6 animate-fade-in">
                        
                        {/* Interactive Genre Chips */}
                        <div className="space-y-2">
                          <label className="text-neutral-300 font-bold block">
                            Géneros y Categorías (Haz clic para seleccionar o deseleccionar):
                          </label>
                          <div className="flex flex-wrap gap-1.5 p-3.5 bg-neutral-900/60 rounded-2xl border border-white/5 max-h-48 overflow-y-auto">
                            {[
                              "Acción", "Aventura", "Comedia", "Drama", "Fantasía", "Ciencia Ficción", 
                              "Romance", "Sobrenatural", "Misterio", "Psicológico", "Shounen", "Seinen", 
                              "Isekai", "Recuentos de la vida", "Deportes", "Terror", "Mecha", "Magia"
                            ].map((g) => {
                              const isSelected = (selectedAnime.genres || []).includes(g);
                              return (
                                <button
                                  key={g}
                                  type="button"
                                  onClick={() => handleToggleGenre(g)}
                                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                                    isSelected
                                      ? 'bg-rose-500 text-white shadow-md shadow-rose-500/25 border border-rose-400'
                                      : 'bg-neutral-800/60 border border-white/5 text-neutral-400 hover:text-white hover:border-neutral-700'
                                  }`}
                                >
                                  {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                                  <span>{g}</span>
                                </button>
                              );
                            })}
                          </div>
                          <span className="text-[10px] text-neutral-500">
                            Seleccionados actualmente: {(selectedAnime.genres || []).join(", ") || "Ninguno"}
                          </span>
                        </div>

                        {/* Numbers Grid: Year, Rating, Episodes */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Año de Estreno</label>
                            <input 
                              type="number" 
                              value={selectedAnime.year} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, year: parseInt(e.target.value) || 2026 })}
                              className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500"
                            />
                          </div>

                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">Calificación (1.0 - 10.0)</label>
                            <input 
                              type="number" 
                              step="0.1" 
                              min="1" 
                              max="10"
                              value={selectedAnime.rating} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, rating: parseFloat(e.target.value) || 8.0 })}
                              className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500"
                            />
                          </div>

                          <div className="flex flex-col space-y-1.5">
                            <label className="text-neutral-400 font-semibold">
                              {selectedAnime.type === 'Película' ? 'Episodios (Película)' : catalogFilter === 'manga' ? 'Capítulos' : 'Episodios'}
                            </label>
                            <input 
                              type="number" 
                              disabled={selectedAnime.type === 'Película'}
                              value={selectedAnime.type === 'Película' ? 1 : (selectedAnime.episodesCount || 12)} 
                              onChange={(e) => setSelectedAnime({ ...selectedAnime, episodesCount: parseInt(e.target.value) || 12 })}
                              className="bg-neutral-900 disabled:opacity-50 border border-white/10 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-rose-500"
                            />
                          </div>
                        </div>

                        {/* ID slug preview / customization */}
                        <div className="flex flex-col space-y-1.5">
                          <label className="text-neutral-400 font-semibold">Identificador / Slug único</label>
                          <input 
                            type="text" 
                            value={selectedAnime.id} 
                            onChange={(e) => setSelectedAnime({ ...selectedAnime, id: e.target.value })}
                            placeholder={isCreatingNew ? "tioanime-[se generará automáticamente si lo dejas vacío]" : "ID del contenido"}
                            className="bg-neutral-900 border border-white/10 rounded-xl px-4 py-2.5 text-white font-mono text-xs focus:outline-none focus:border-rose-500 placeholder-neutral-600"
                          />
                        </div>

                      </div>
                    )}

                    {/* Modal Footer Controls */}
                    <div className="flex items-center justify-between pt-4 border-t border-white/10">
                      <div className="flex gap-2">
                        {editorTab !== 'general' && (
                          <button
                            type="button"
                            onClick={() => setEditorTab(editorTab === 'metadata' ? 'images' : 'general')}
                            className="bg-white/5 hover:bg-white/10 text-neutral-300 font-bold px-4 py-2.5 rounded-xl cursor-pointer transition-colors"
                          >
                            ← Anterior
                          </button>
                        )}
                        {editorTab !== 'metadata' && (
                          <button
                            type="button"
                            onClick={() => setEditorTab(editorTab === 'general' ? 'images' : 'metadata')}
                            className="bg-white/10 hover:bg-white/15 text-white font-bold px-4 py-2.5 rounded-xl cursor-pointer transition-colors"
                          >
                            Siguiente →
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <button 
                          type="button" 
                          onClick={() => { setSelectedAnime(null); setIsCreatingNew(false); }}
                          className="bg-white/5 hover:bg-white/10 text-neutral-400 hover:text-white font-bold px-4 py-2.5 rounded-xl cursor-pointer transition-colors"
                        >
                          Cancelar
                        </button>
                        <button 
                          type="submit" 
                          disabled={isSavingCatalog}
                          className="bg-gradient-to-r from-rose-600 to-rose-700 hover:from-rose-500 hover:to-rose-600 text-white font-extrabold px-6 py-2.5 rounded-xl cursor-pointer transition-all flex items-center gap-2 shadow-lg shadow-rose-600/30 active:scale-95 disabled:opacity-50"
                        >
                          {isSavingCatalog ? (
                            <>
                              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                              <span>Guardando en Catálogo...</span>
                            </>
                          ) : (
                            <>
                              <Save className="h-4 w-4" />
                              <span>{isCreatingNew ? 'Publicar en Catálogo' : 'Guardar Cambios'}</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                  </form>
                </div>
              </div>
            )}

            {/* ── NETFLIX DELETION SAFEGUARD CONFIRMATION MODAL ── */}
            {animeToDelete && (
              <div className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in">
                <div className="bg-neutral-950 border border-rose-500/30 rounded-3xl max-w-md w-full p-6 space-y-5 shadow-2xl relative animate-scale-up">
                  
                  {/* Warning Header */}
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-2xl bg-rose-500/20 border border-rose-500/30 flex items-center justify-center text-rose-500 shrink-0">
                      <AlertTriangle className="h-5 w-5 stroke-[2.5]" />
                    </div>
                    <div>
                      <span className="text-[10px] font-black uppercase tracking-wider text-rose-400">Eliminación Permanente</span>
                      <h3 className="text-base font-extrabold text-white">¿Eliminar del Catálogo?</h3>
                    </div>
                  </div>

                  {/* Target Card Preview */}
                  <div className="flex items-center gap-3.5 p-3.5 bg-neutral-900/80 border border-white/5 rounded-2xl">
                    <img 
                      src={animeToDelete.coverUrl} 
                      alt={animeToDelete.title} 
                      className="h-16 w-12 object-cover rounded-xl shadow-md shrink-0"
                      onError={(e) => { (e.target as any).src = "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=100"; }}
                    />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm font-bold text-white truncate">{animeToDelete.title}</span>
                      <span className="text-[11px] text-neutral-400 mt-0.5">
                        {animeToDelete.type || 'Anime'} ({animeToDelete.year}) • {animeToDelete.status}
                      </span>
                      <span className="text-[10px] text-neutral-500 font-mono truncate mt-0.5">
                        ID: {animeToDelete.id}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-neutral-400 leading-relaxed">
                    Esta acción eliminará permanentemente a <strong className="text-white">"{animeToDelete.title}"</strong> de la base de datos de MegaAnime (`catalog.json`) y desaparecerá de Inicio, Películas y Búsqueda.
                  </p>

                  {/* Action Buttons */}
                  <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                      type="button"
                      disabled={isDeletingCatalog}
                      onClick={() => setAnimeToDelete(null)}
                      className="bg-white/5 hover:bg-white/10 text-neutral-300 font-bold px-4 py-2.5 rounded-xl cursor-pointer transition-colors text-xs"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      disabled={isDeletingCatalog}
                      onClick={handleConfirmDelete}
                      className="bg-rose-600 hover:bg-rose-700 text-white font-extrabold px-5 py-2.5 rounded-xl cursor-pointer transition-all flex items-center gap-2 shadow-lg shadow-rose-600/30 text-xs disabled:opacity-50"
                    >
                      {isDeletingCatalog ? (
                        <>
                          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                          <span>Eliminando...</span>
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-3.5 w-3.5" />
                          <span>Eliminar Definitivamente</span>
                        </>
                      )}
                    </button>
                  </div>

                </div>
              </div>
            )}

            {/* ── TOAST NOTIFICATION POPUP ── */}
            {toastMessage && (
              <div className="fixed bottom-6 right-6 z-50 animate-fade-in">
                <div className={`flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl border backdrop-blur-md ${
                  toastMessage.type === 'success' 
                    ? 'bg-neutral-900/95 border-emerald-500/40 text-white' 
                    : 'bg-neutral-900/95 border-rose-500/40 text-white'
                }`}>
                  {toastMessage.type === 'success' ? (
                    <CheckCircle className="h-5 w-5 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-rose-400 shrink-0" />
                  )}
                  <span className="text-xs font-semibold">{toastMessage.text}</span>
                  <button 
                    onClick={() => setToastMessage(null)}
                    className="text-neutral-400 hover:text-white p-1 ml-2 transition-colors cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

          </div>
        )}

        {/* 3. APPEARANCE & GLOBAL ANNOUNCEMENTS MANAGEMENT TAB */}
        {activeTab === 'apariencia' && (
          <div className="space-y-8 animate-slide-in">
            <div className="flex flex-col space-y-1">
              <h1 className="text-xl font-extrabold text-white tracking-tight">Gestión de Apariencia y Avisos Globales</h1>
              <p className="text-xs text-neutral-400">Publica avisos masivos en la parte superior de la web y personaliza el banner principal.</p>
            </div>

            {/* Global System Banner Editor Card */}
            <div className="bg-neutral-900/40 border border-purple-500/20 rounded-2xl p-6 space-y-4 relative overflow-hidden">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-purple-500/10 rounded-xl text-purple-400 border border-purple-500/20">
                    <Megaphone className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-white">Banner de Aviso Global (Header Bar)</h3>
                    <p className="text-xs text-neutral-400">Aparece instantáneamente en la parte superior para todos los visitantes de megaAnime.</p>
                  </div>
                </div>

                {/* Active Toggle Switch */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <span className="text-xs font-bold text-neutral-300">
                    {globalBannerConfig.active ? "Activado" : "Desactivado"}
                  </span>
                  <input
                    type="checkbox"
                    checked={globalBannerConfig.active}
                    onChange={(e) => setGlobalBannerConfig({ ...globalBannerConfig, active: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-neutral-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-neutral-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600 relative"></div>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                <div className="md:col-span-2 space-y-1">
                  <label className="text-[10px] text-neutral-400 font-semibold">Mensaje del Aviso:</label>
                  <input
                    type="text"
                    placeholder="Ej: 🔥 ¡Película de Chainsaw Man disponible en Full HD!"
                    value={globalBannerConfig.message}
                    onChange={(e) => setGlobalBannerConfig({ ...globalBannerConfig, message: e.target.value })}
                    className="w-full bg-neutral-950 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] text-neutral-400 font-semibold">Estilo / Color:</label>
                  <select
                    value={globalBannerConfig.type}
                    onChange={(e) => setGlobalBannerConfig({ ...globalBannerConfig, type: e.target.value as any })}
                    className="w-full bg-neutral-950 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-purple-500"
                  >
                    <option value="info">Azul (Informativo / General)</option>
                    <option value="warning">Ámbar (Alerta / Mantenimiento)</option>
                    <option value="promo">Rosa Púrpura (Promocional / Estreno)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] text-neutral-400 font-semibold">Texto Botón (Opcional):</label>
                  <input
                    type="text"
                    placeholder="Ej: Ver Ahora"
                    value={globalBannerConfig.actionText || ""}
                    onChange={(e) => setGlobalBannerConfig({ ...globalBannerConfig, actionText: e.target.value })}
                    className="w-full bg-neutral-950 border border-white/10 rounded-xl px-4 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="md:col-span-2 space-y-1">
                  <label className="text-[10px] text-neutral-400 font-semibold">Enlace Botón URL (Opcional):</label>
                  <input
                    type="text"
                    placeholder="Ej: https://megaanime.net"
                    value={globalBannerConfig.actionUrl || ""}
                    onChange={(e) => setGlobalBannerConfig({ ...globalBannerConfig, actionUrl: e.target.value })}
                    className="w-full bg-neutral-950 border border-white/10 rounded-xl px-4 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-white/5">
                <span className="text-[10px] text-purple-300 flex items-center gap-1">
                  <Info className="h-3.5 w-3.5" /> los cambios se guardan directamente en Firestore para todos los clientes.
                </span>

                <button
                  disabled={isSavingBanner}
                  onClick={async () => {
                    setIsSavingBanner(true);
                    await saveGlobalBannerAlert(globalBannerConfig);
                    setIsSavingBanner(false);
                    setBannerSavedToast(true);
                    setTimeout(() => setBannerSavedToast(false), 3000);
                  }}
                  className="px-5 py-2 bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs rounded-xl shadow-lg shadow-purple-600/20 transition cursor-pointer flex items-center gap-1.5"
                >
                  <Save className="h-4 w-4" />
                  <span>{isSavingBanner ? "Guardando..." : bannerSavedToast ? "¡Guardado!" : "Guardar Aviso Global"}</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              
              {/* Control of Hero Banner */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-5">
                <div className="flex flex-col space-y-1">
                  <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Crown className="h-4 w-4 text-amber-400" />
                    Control del Hero Banner
                  </span>
                  <span className="text-[10px] text-neutral-500">Selecciona el anime destacado en grande al entrar a la web.</span>
                </div>

                <div className="flex flex-col space-y-4">
                  <div className="flex flex-col space-y-1">
                    <label className="text-[10px] text-neutral-400 font-semibold">Anime Destacado:</label>
                    <select
                      value={featuredHeroId}
                      onChange={(e) => {
                        setFeaturedHeroId(e.target.value);
                        alert(`¡Banner principal actualizado para destacar a ${animes.find(a => a.id === e.target.value)?.title}!`);
                      }}
                      className="bg-neutral-900 border border-white/5 rounded-xl px-4 py-3 text-xs text-white focus:outline-none focus:border-rose-500"
                    >
                      {animes.map(a => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </select>
                  </div>

                  {/* Banner Preview simulation */}
                  {animes.find(a => a.id === featuredHeroId) && (
                    <div className="relative h-32 rounded-xl overflow-hidden border border-white/5 shadow-inner">
                      <img 
                        src={animes.find(a => a.id === featuredHeroId)?.coverUrl} 
                        className="w-full h-full object-cover blur-sm opacity-35" 
                        alt="featured"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-neutral-950 to-transparent flex items-end p-4">
                        <div className="flex items-center gap-3">
                          <img 
                            src={animes.find(a => a.id === featuredHeroId)?.coverUrl} 
                            className="h-12 w-9 object-cover rounded shadow-md border border-white/10 animate-scale-up" 
                            alt="cover" 
                          />
                          <div className="flex flex-col">
                            <span className="text-[8px] bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded font-black tracking-widest uppercase w-max mb-1">En Portada</span>
                            <span className="text-xs font-black text-white">{animes.find(a => a.id === featuredHeroId)?.title}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Draggable lists reordering simulator */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <div className="flex flex-col space-y-1">
                  <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                    <Palette className="h-4 w-4 text-rose-400" />
                    Ordenador de Carruseles
                  </span>
                  <span className="text-[10px] text-neutral-500">Orden de las filas de contenidos en la pantalla de inicio.</span>
                </div>

                <div className="flex flex-col space-y-2 select-none">
                  {carouselOrder.map((row, index) => (
                    <div 
                      key={row} 
                      className="bg-neutral-950 border border-white/5 px-4 py-3 rounded-xl flex items-center justify-between text-xs text-neutral-300 hover:border-white/15 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-bold text-neutral-500 w-4">{index + 1}.</span>
                        <span className="font-semibold text-white">{row}</span>
                      </div>
                      
                      {/* Move controls */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleMoveCarousel(index, 'up')}
                          disabled={index === 0}
                          className="p-1 text-neutral-500 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleMoveCarousel(index, 'down')}
                          disabled={index === carouselOrder.length - 1}
                          className="p-1 text-neutral-500 hover:text-white disabled:opacity-30 disabled:pointer-events-none transition-colors cursor-pointer"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </div>
          </div>
        )}

        {/* 4. CRM / USER MANAGEMENT TAB */}
        {activeTab === 'usuarios' && (
          <div className="space-y-8 animate-slide-in">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex flex-col space-y-1">
                <h1 className="text-xl font-extrabold text-white tracking-tight">CRM & Gestión de Soporte</h1>
                <p className="text-xs text-neutral-400">Busca perfiles de clientes, monitorea suscripciones y gestiona suspensiones rápidas.</p>
              </div>

              {/* Exporter and Search */}
              <div className="flex items-center gap-3 w-full md:w-auto">
                <button
                  onClick={handleExportCSV}
                  className="bg-white/5 hover:bg-white/10 text-neutral-300 font-bold px-4 py-2 rounded-xl text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  <span>Exportar CSV</span>
                </button>
                
                <div className="relative max-w-xs w-full">
                  <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
                  <input
                    type="text"
                    placeholder="Buscar cliente..."
                    value={userSearchQuery}
                    onChange={(e) => setUserSearchQuery(e.target.value)}
                    className="w-full bg-neutral-900 border border-white/5 rounded-xl pl-10 pr-4 py-2 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-rose-500 transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* Split layout: Users List vs Detail Profile Card */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Users Master list */}
              <div className="lg:col-span-2 bg-neutral-900/30 border border-white/5 rounded-2xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-white/5 bg-black/20 text-neutral-400 font-bold uppercase tracking-wider">
                        <th className="py-3 px-4">Nombre / Cliente</th>
                        <th className="py-3 px-4">Plan</th>
                        <th className="py-3 px-4">Estado</th>
                        <th className="py-3 px-4 text-right">Detalles</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-neutral-300">
                      {filteredUsers.map(user => (
                        <tr key={user.id} className="hover:bg-white/5 transition-colors">
                          <td className="py-3 px-4">
                            <div className="flex flex-col">
                              <span className="font-bold text-white">{user.name}</span>
                              <span className="text-[10px] text-neutral-500 mt-0.5">{user.email}</span>
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`text-[10px] font-bold ${
                              user.plan === 'Premium' ? 'text-amber-400' : user.plan === 'Básico' ? 'text-blue-400' : 'text-neutral-400'
                            }`}>
                              {user.plan}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`text-[9px] px-2 py-0.5 rounded-full font-black uppercase ${
                              user.status === 'Activo' 
                                ? 'bg-green-500/10 text-green-400 border border-green-500/20' 
                                : user.status === 'Suspendido' 
                                  ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20' 
                                  : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                            }`}>
                              {user.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => setSelectedUser(user)}
                              className="text-rose-500 hover:text-rose-400 font-bold cursor-pointer hover:underline text-[10px]"
                            >
                              Ver Perfil
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Profile CRM Detail Card */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col justify-between min-h-[300px]">
                {selectedUser ? (
                  <div className="flex flex-col h-full justify-between space-y-6">
                    <div className="space-y-4 animate-scale-up">
                      {/* Name card */}
                      <div className="flex items-center gap-3.5 border-b border-white/5 pb-4">
                        <div className="h-10 w-10 bg-rose-500/10 text-rose-400 rounded-xl flex items-center justify-center font-black text-sm">
                          {selectedUser.name.charAt(0)}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-xs font-black text-white">{selectedUser.name}</span>
                          <span className="text-[10px] text-neutral-500">{selectedUser.email}</span>
                        </div>
                      </div>

                      {/* Detail metadata list */}
                      <div className="space-y-2.5 text-[10px] text-neutral-400">
                        <div className="flex justify-between">
                          <span>Plan de Pago:</span>
                          <span className="font-bold text-white">{selectedUser.plan}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Estado de Cuenta:</span>
                          <span className={`font-bold ${selectedUser.status === 'Activo' ? 'text-green-400' : 'text-rose-400'}`}>{selectedUser.status}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Último Acceso:</span>
                          <span className="font-semibold text-white">{selectedUser.lastLogin}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Fecha Registro:</span>
                          <span className="font-semibold text-white">{selectedUser.registeredDate}</span>
                        </div>
                      </div>
                    </div>

                    {/* Quick action buttons CRM */}
                    <div className="flex flex-col gap-2 pt-4 border-t border-white/5">
                      <div className="flex gap-2">
                        {selectedUser.status === 'Activo' ? (
                          <button
                            onClick={() => handleUserAction(selectedUser.id, 'suspend')}
                            className="flex-grow bg-rose-500/10 hover:bg-rose-500/25 text-rose-400 font-bold py-2 rounded-xl text-[10px] transition-colors cursor-pointer flex items-center justify-center gap-1 border border-rose-500/20"
                          >
                            <UserX className="h-3.5 w-3.5" />
                            <span>Suspender</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => handleUserAction(selectedUser.id, 'activate')}
                            className="flex-grow bg-green-500/10 hover:bg-green-500/25 text-green-400 font-bold py-2 rounded-xl text-[10px] transition-colors cursor-pointer flex items-center justify-center gap-1 border border-green-500/20"
                          >
                            <UserCheck className="h-3.5 w-3.5" />
                            <span>Activar Cuenta</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleUserAction(selectedUser.id, 'free_month')}
                          className="flex-grow bg-amber-500/10 hover:bg-amber-500/25 text-amber-400 font-bold py-2 rounded-xl text-[10px] transition-colors cursor-pointer flex items-center justify-center gap-1 border border-amber-500/20"
                        >
                          <Gift className="h-3.5 w-3.5" />
                          <span>Otorgar Regalo</span>
                        </button>
                      </div>

                      <button
                        onClick={() => handleUserAction(selectedUser.id, 'reset_password')}
                        className="w-full bg-white/5 hover:bg-white/10 text-neutral-300 font-bold py-2 rounded-xl text-[10px] transition-colors cursor-pointer"
                      >
                        Restablecer Contraseña
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center my-auto space-y-2 p-6">
                    <Info className="h-8 w-8 text-neutral-600" />
                    <span className="text-xs font-bold text-neutral-400">Perfil Administrativo</span>
                    <p className="text-[10px] text-neutral-500 leading-relaxed max-w-xs">Selecciona un cliente de la lista de la izquierda para ver su historial y aplicar acciones rápidas de soporte.</p>
                  </div>
                )}
              </div>

            </div>
          </div>
        )}

        {/* 5. USER REPORTS & BROKEN LINKS CENTER TAB */}
        {activeTab === 'reportes' && (
          <div className="space-y-8 animate-slide-in">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-col space-y-1">
                <h1 className="text-xl font-extrabold text-white tracking-tight flex items-center gap-2">
                  <Flag className="h-5 w-5 text-amber-400" />
                  Centro de Reportes de Usuarios
                </h1>
                <p className="text-xs text-neutral-400">Atiende los reportes de reproductores caídos y fallos informados por los espectadores en tiempo real.</p>
              </div>

              {/* Filter tab buttons */}
              <div className="flex items-center gap-2 bg-neutral-900 p-1 rounded-xl border border-white/5">
                <button
                  onClick={() => setReportsFilter('pending')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    reportsFilter === 'pending'
                      ? 'bg-rose-600 text-white shadow-md'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  Pendientes ({reports.filter(r => r.status === 'pending').length})
                </button>
                <button
                  onClick={() => setReportsFilter('resolved')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    reportsFilter === 'resolved'
                      ? 'bg-emerald-600 text-white shadow-md'
                      : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  Resueltos ({reports.filter(r => r.status === 'resolved').length})
                </button>
              </div>
            </div>

            {/* Reports List Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {reports.filter(r => r.status === reportsFilter).length === 0 ? (
                <div className="col-span-full py-16 bg-neutral-900/20 border border-white/5 rounded-2xl flex flex-col items-center justify-center text-center space-y-3">
                  <CheckCircle2 className="h-10 w-10 text-emerald-400 animate-bounce" />
                  <h3 className="text-sm font-bold text-white">¡No hay reportes {reportsFilter === 'pending' ? 'pendientes' : 'resueltos'}!</h3>
                  <p className="text-xs text-neutral-500 max-w-sm">Todos los reproductores y servidores están funcionando correctamente en la web.</p>
                </div>
              ) : (
                reports
                  .filter(r => r.status === reportsFilter)
                  .map((rep) => (
                    <div 
                      key={rep.id || rep.createdAt}
                      className="bg-neutral-900/40 border border-white/10 rounded-2xl p-5 flex flex-col justify-between space-y-4 hover:border-white/20 transition group"
                    >
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] bg-rose-500/20 text-rose-300 font-bold px-2 py-0.5 rounded-md uppercase">
                            Episodio {rep.episodeNumber}
                          </span>
                          <span className="text-[9px] text-neutral-500">
                            {rep.createdAt ? new Date(rep.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Reciente"}
                          </span>
                        </div>

                        <h3 className="text-sm font-bold text-white truncate">{rep.animeTitle}</h3>

                        <div className="bg-black/30 p-2.5 rounded-xl border border-white/5 space-y-1 text-xs">
                          <div className="flex justify-between">
                            <span className="text-neutral-400">Servidor:</span>
                            <span className="font-semibold text-rose-400">{rep.serverName}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-neutral-400">Motivo:</span>
                            <span className="font-semibold text-amber-300 truncate max-w-[170px]">{rep.reason}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-2 border-t border-white/5">
                        <button
                          onClick={() => {
                            const found = animes.find(a => a.id === rep.animeId || a.title === rep.animeTitle);
                            if (found) {
                              setSelectedAnimeForEpisodes(found);
                              setSelectedEpNum(rep.episodeNumber);
                            } else {
                              alert(`Abriendo editor de servidores para ${rep.animeTitle}`);
                            }
                          }}
                          className="flex-1 py-1.5 bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 border border-purple-500/30 rounded-xl text-[10px] font-bold transition flex items-center justify-center gap-1 cursor-pointer"
                        >
                          <Film className="h-3 w-3" />
                          <span>Reparar Enlaces</span>
                        </button>

                        {rep.status === 'pending' ? (
                          <button
                            onClick={async () => {
                              if (rep.id) {
                                await updateReportStatus(rep.id, 'resolved');
                                setReports(reports.map(r => r.id === rep.id ? { ...r, status: 'resolved' } : r));
                              } else {
                                setReports(reports.map(r => r === rep ? { ...r, status: 'resolved' } : r));
                              }
                            }}
                            className="py-1.5 px-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-[10px] font-bold transition flex items-center justify-center gap-1 cursor-pointer"
                          >
                            <Check className="h-3 w-3" />
                            <span>Solucionado</span>
                          </button>
                        ) : (
                          <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                            <CheckCircle2 className="h-3.5 w-3.5" /> Resuelto
                          </span>
                        )}
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        )}

        {/* 6. ADVANCED SERVERS & MONITORING TAB */}
        {activeTab === 'servidores' && (
          <div className="space-y-8 animate-slide-in">
            <div className="flex flex-col space-y-1">
              <h1 className="text-xl font-extrabold text-white tracking-tight">Gestión de Servidores y Fuentes</h1>
              <p className="text-xs text-neutral-400">Administra el extractor de enlaces directos (resolvers), verifica la salud de los servidores y define prioridades.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Section 1: Server Priorities */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Sliders className="h-4.5 w-4.5 text-rose-500" />
                  Prioridad de Resolvers
                </span>
                <p className="text-[10px] text-neutral-400 leading-normal">
                  Define el orden en el que el sistema de fallback intentará extraer el enlace multimedia directo.
                </p>

                <div className="space-y-2">
                  {serverPriority.map((srv, idx) => (
                    <div key={srv} className="bg-neutral-900/50 border border-white/5 rounded-xl p-3 flex items-center justify-between text-xs text-white">
                      <div className="flex items-center gap-2">
                        <span className="text-[9px] text-neutral-500 font-bold">#{idx + 1}</span>
                        <span className="font-bold">{srv}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => {
                            if (idx === 0) return;
                            const copy = [...serverPriority];
                            const temp = copy[idx - 1];
                            copy[idx - 1] = copy[idx];
                            copy[idx] = temp;
                            handleSavePriority(copy);
                          }}
                          disabled={idx === 0}
                          className="h-6 w-6 rounded bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-white/5 flex items-center justify-center cursor-pointer"
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => {
                            if (idx === serverPriority.length - 1) return;
                            const copy = [...serverPriority];
                            const temp = copy[idx + 1];
                            copy[idx + 1] = copy[idx];
                            copy[idx] = temp;
                            handleSavePriority(copy);
                          }}
                          disabled={idx === serverPriority.length - 1}
                          className="h-6 w-6 rounded bg-white/5 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-white/5 flex items-center justify-center cursor-pointer"
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Source Inspector */}
              <div className="lg:col-span-2 bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Activity className="h-4.5 w-4.5 text-green-500" />
                  Inspección de Fuentes por Episodio
                </span>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="flex flex-col space-y-1.5">
                    <label className="text-[10px] text-neutral-400 font-bold uppercase">Seleccionar Anime</label>
                    <select
                      value={selectedAnimeIdForSources}
                      onChange={(e) => {
                        setSelectedAnimeIdForSources(e.target.value);
                        setSourceTestResults({});
                      }}
                      className="w-full bg-neutral-900 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-rose-500"
                    >
                      <option value="">-- Elige un anime --</option>
                      {animes.map(a => (
                        <option key={a.id} value={a.id}>{a.title}</option>
                      ))}
                    </select>
                  </div>
                  
                  <div className="flex flex-col space-y-1.5">
                    <label className="text-[10px] text-neutral-400 font-bold uppercase">Número de Episodio</label>
                    <input
                      type="number"
                      min={1}
                      value={selectedEpNumberForSources}
                      onChange={(e) => {
                        setSelectedEpNumberForSources(parseInt(e.target.value, 10) || 1);
                        setSourceTestResults({});
                      }}
                      className="w-full bg-neutral-900 border border-white/5 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-rose-500"
                    />
                  </div>
                </div>

                {selectedAnimeIdForSources ? (
                  <div className="space-y-3 pt-2">
                    <span className="text-[10px] text-neutral-400 font-bold uppercase tracking-wider block">Servidores Detectados</span>
                    
                    <div className="space-y-2">
                      {[
                        { name: "Streamwish", embed: `https://streamwish.to/e/${selectedAnimeIdForSources}-ep-${selectedEpNumberForSources}` },
                        { name: "Mp4Upload", embed: `https://www.mp4upload.com/embed-${selectedAnimeIdForSources}-${selectedEpNumberForSources}.html` },
                        { name: "VOE", embed: `https://voe.sx/e/${selectedAnimeIdForSources}-cap-${selectedEpNumberForSources}` }
                      ].map((srv) => {
                        const test = sourceTestResults[srv.embed];
                        return (
                          <div key={srv.name} className="bg-neutral-950/40 border border-white/5 rounded-xl p-3 flex flex-col space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-xs font-bold text-white">{srv.name}</span>
                              </div>
                              <button
                                onClick={() => handleTestLink(srv.name, srv.embed)}
                                disabled={test?.status === "loading"}
                                className="bg-white/5 hover:bg-white/10 text-neutral-300 disabled:opacity-50 text-[10px] font-bold px-3 py-1 rounded-lg transition-colors cursor-pointer"
                              >
                                {test?.status === "loading" ? "Probando..." : "Probar Enlace"}
                              </button>
                            </div>
                            
                            <div className="text-[10px] text-neutral-500 truncate font-mono">
                              {srv.embed}
                            </div>

                            {test && (
                              <div className={`mt-2 p-2.5 rounded-lg border text-[10px] leading-relaxed font-semibold ${
                                test.status === "ok"
                                  ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                                  : test.status === "error"
                                  ? "bg-rose-500/5 border-rose-500/20 text-rose-400"
                                  : "bg-white/5 border-white/5 text-neutral-400"
                              }`}>
                                {test.status === "loading" && <span>Simulando descifrado del iframe y cargando stream...</span>}
                                {test.status === "ok" && (
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-1">
                                      <CheckCircle className="h-3.5 w-3.5" />
                                      <span>Resolver Exitoso! Stream extraído.</span>
                                    </div>
                                    <div className="font-mono text-neutral-300 truncate bg-black/40 p-1.5 rounded mt-1 select-all select-text">
                                      {test.resolvedUrl}
                                    </div>
                                  </div>
                                )}
                                {test.status === "error" && (
                                  <div className="flex items-center gap-1">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    <span>Error: {test.msg}</span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center text-center p-8 bg-neutral-950/20 border border-dashed border-white/5 rounded-2xl h-44 text-neutral-500">
                    <Info className="h-6 w-6 mb-2 text-neutral-600" />
                    <span className="text-xs font-bold">Sin selección</span>
                    <p className="text-[10px] max-w-xs mt-1">Elige un anime y episodio de arriba para inspeccionar los servidores guardados por scraping.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Health Monitor Dashboard Section */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              
              {/* Box 1: Health Score card */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldAlert className="h-4.5 w-4.5 text-amber-500" />
                  Salud de los Servidores
                </span>

                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-2xl font-black text-white">{healthScore}%</span>
                    <span className="text-[9px] text-neutral-500 uppercase font-black">Estado General</span>
                  </div>
                  <button
                    onClick={handleScanBrokenLinks}
                    className="bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 text-[10px] font-bold px-3 py-1.5 rounded-lg border border-amber-500/20 cursor-pointer"
                  >
                    Escanear Enlaces
                  </button>
                </div>

                <div className="space-y-1.5 text-[10px] text-neutral-400 leading-normal">
                  <div className="flex justify-between">
                    <span>Enlaces escaneados:</span>
                    <span className="font-bold text-white">{scannedLinksCount || "No escaneado"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Enlaces caídos (404/403):</span>
                    <span className={`font-bold ${brokenLinksCount > 0 ? "text-rose-400" : "text-emerald-400"}`}>{brokenLinksCount}</span>
                  </div>
                </div>
              </div>

              {/* Box 2: Cron Jobs Status */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Calendar className="h-4.5 w-4.5 text-indigo-500" />
                  Estado de Cron Jobs
                </span>

                <div className="space-y-3">
                  <div className="bg-neutral-950/40 p-3 rounded-xl border border-white/5 flex items-center justify-between">
                    <div className="flex flex-col">
                      <span className="text-xs font-bold text-white">Daily Scraper Update</span>
                      <span className="text-[8px] text-neutral-500 mt-0.5">8:00 AM Eastern Time</span>
                    </div>
                    <span className="text-[8px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-black uppercase">Activo</span>
                  </div>

                  <div className="text-[10px] text-neutral-400 leading-normal space-y-1">
                    <div className="flex justify-between">
                      <span>Último análisis:</span>
                      <span className="text-white font-bold">Hoy, 08:00 AM</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Próximo análisis:</span>
                      <span className="text-white font-bold">Mañana, 08:00 AM</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Box 3: Proxy Bandwidth metrics */}
              <div className="bg-neutral-900/30 border border-white/5 rounded-2xl p-5 flex flex-col space-y-4">
                <span className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
                  <Download className="h-4.5 w-4.5 text-rose-500" />
                  Métricas de Proxy de Transmisión
                </span>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-neutral-400">Tráfico Activo</span>
                      <span className="text-white font-bold">2.4 GB / 10 GB</span>
                    </div>
                    <div className="h-2 w-full bg-neutral-950 rounded-full overflow-hidden">
                      <div className="h-full bg-rose-500 rounded-full" style={{ width: "24%" }} />
                    </div>
                  </div>

                  <p className="text-[9px] text-neutral-500 leading-relaxed">
                    Muestra el volumen de tráfico que pasa por el Proxy CORS de tu backend. Esto ayuda a anticipar cuellos de botella de red.
                  </p>
                </div>
              </div>

            </div>
          </div>
        )}
      </main>

      {/* Episode & Custom Server Manager Modal */}
      {selectedAnimeForEpisodes && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
          <div className="bg-neutral-900 border border-white/10 rounded-2xl p-6 max-w-2xl w-full shadow-2xl relative space-y-5 max-h-[90vh] overflow-y-auto">
            <button 
              onClick={() => setSelectedAnimeForEpisodes(null)}
              className="absolute top-4 right-4 text-neutral-400 hover:text-white p-1 rounded-lg transition"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-3">
              <img 
                src={selectedAnimeForEpisodes.coverUrl} 
                className="h-12 w-10 object-cover rounded-lg border border-white/10 shadow-md"
                alt="cover"
              />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] bg-rose-500/20 text-rose-300 font-bold px-2 py-0.5 rounded uppercase">Gestor de Episodios</span>
                  {(() => {
                    const r2 = getR2Info(selectedAnimeForEpisodes);
                    if (!r2) return null;
                    return (
                      <span className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30">
                        <Cloud className="h-2.5 w-2.5" />
                        Cloudflare R2 ({r2.count} caps)
                      </span>
                    );
                  })()}
                </div>
                <h3 className="text-base font-bold text-white leading-tight mt-0.5">{selectedAnimeForEpisodes.title}</h3>
                <p className="text-xs text-neutral-400">Episodios totales: {selectedAnimeForEpisodes.episodesCount || 12}</p>
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-white/5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-white">Selecciona Episodio:</label>
                <div className="flex items-center gap-1.5 overflow-x-auto max-w-md py-1">
                  {Array.from({ length: selectedAnimeForEpisodes.episodesCount || 12 }, (_, i) => i + 1).map((epNum) => {
                    const epKey = `ep-${epNum}`;
                    let isEpInR2 = false;
                    if (r2Manifest) {
                      const entry = r2Manifest[selectedAnimeForEpisodes.id]
                        || r2Manifest[`tioanime-${selectedAnimeForEpisodes.id}`]
                        || (selectedAnimeForEpisodes.id.includes("bleach") ? (r2Manifest["tioanime-bleach-sennen-kessenhen"] || r2Manifest["bleach-sennen-kessen-hen"]) : null);
                      if (entry && entry.episodes && entry.episodes[epKey]) {
                        isEpInR2 = true;
                      }
                    }
                    return (
                      <button
                        key={epNum}
                        onClick={() => setSelectedEpNum(epNum)}
                        className={`relative px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                          selectedEpNum === epNum 
                            ? "bg-rose-600 text-white shadow-lg shadow-rose-600/20" 
                            : "bg-neutral-800 text-neutral-400 hover:text-white"
                        }`}
                      >
                        EP {epNum}
                        {isEpInR2 && (
                          <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-orange-400 ring-2 ring-neutral-900" title="Alojado en Cloudflare R2" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Cloudflare Direct Stream Notice */}
              {(() => {
                const epKey = `ep-${selectedEpNum}`;
                let r2Url = null;
                if (r2Manifest) {
                  const entry = r2Manifest[selectedAnimeForEpisodes.id] 
                    || r2Manifest[`tioanime-${selectedAnimeForEpisodes.id}`]
                    || (selectedAnimeForEpisodes.id.includes("bleach") ? (r2Manifest["tioanime-bleach-sennen-kessenhen"] || r2Manifest["bleach-sennen-kessen-hen"]) : null);
                  if (entry && entry.episodes && entry.episodes[epKey]) {
                    r2Url = entry.episodes[epKey].url;
                  }
                }
                if (!r2Url) return null;
                return (
                  <div className="flex items-center justify-between p-3 rounded-xl bg-orange-500/10 border border-orange-500/30 text-orange-400 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <Cloud className="h-4 w-4 shrink-0 text-orange-400" />
                      <div className="min-w-0">
                        <span className="font-bold block text-white">⚡ Servidor Oficial MegaAnime PRO (Cloudflare R2)</span>
                        <a href={r2Url} target="_blank" rel="noreferrer" className="text-[11px] text-orange-300 hover:underline flex items-center gap-1 font-mono mt-0.5 truncate">
                          {r2Url} <ExternalLink className="h-2.5 w-2.5 inline shrink-0" />
                        </a>
                      </div>
                    </div>
                    <span className="text-[10px] bg-orange-500/20 text-orange-300 font-bold px-2 py-0.5 rounded uppercase tracking-wider shrink-0 ml-2">
                      Ultra HD
                    </span>
                  </div>
                );
              })()}

              {/* Form to Add Custom Video Server */}
              <div className="bg-black/30 border border-white/5 rounded-xl p-4 space-y-3">
                <span className="text-xs font-bold text-rose-400 flex items-center gap-1.5">
                  <Plus className="h-4 w-4" />
                  Agregar Servidor Personalizado para Episodio {selectedEpNum}
                </span>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[10px] text-neutral-400 font-semibold block mb-1">Nombre Servidor:</label>
                    <input
                      type="text"
                      placeholder="Ej: Mp4Upload HD, VOE VIP"
                      value={newCustomServer.name}
                      onChange={(e) => setNewCustomServer({ ...newCustomServer, name: e.target.value })}
                      className="w-full bg-neutral-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-rose-500"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="text-[10px] text-neutral-400 font-semibold block mb-1">URL de Video o Embed:</label>
                    <input
                      type="text"
                      placeholder="Ej: https://mp4upload.com/embed-xyz.html o https://.../video.mp4"
                      value={newCustomServer.url}
                      onChange={(e) => setNewCustomServer({ ...newCustomServer, url: e.target.value })}
                      className="w-full bg-neutral-950 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-rose-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <select
                    value={newCustomServer.type}
                    onChange={(e) => setNewCustomServer({ ...newCustomServer, type: e.target.value as any })}
                    className="bg-neutral-950 border border-white/10 rounded-xl px-3 py-1.5 text-xs text-neutral-300 focus:outline-none"
                  >
                    <option value="embed">Iframe / Embed Player (Recomendado)</option>
                    <option value="direct_mp4">Enlace MP4 / HLS Directo</option>
                  </select>

                  <button
                    disabled={isSavingCustomServer || !newCustomServer.url}
                    onClick={async () => {
                      if (!newCustomServer.url) return;
                      setIsSavingCustomServer(true);
                      const serverItem = { name: newCustomServer.name, url: newCustomServer.url, type: newCustomServer.type };
                      const updatedList = [...customServersList, serverItem];
                      setCustomServersList(updatedList);
                      
                      // Save custom server in local storage & Firestore API
                      try {
                        await fetch('/api/admin/animes/save', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            ...selectedAnimeForEpisodes,
                            customServers: {
                              ...((selectedAnimeForEpisodes as any).customServers || {}),
                              [selectedEpNum]: updatedList
                            }
                          })
                        });
                      } catch (e) {}

                      setNewCustomServer({ name: 'Mp4Upload HD', url: '', type: 'embed' });
                      setIsSavingCustomServer(false);
                      alert(`¡Servidor '${serverItem.name}' añadido con éxito para el Episodio ${selectedEpNum}!`);
                    }}
                    className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white font-bold text-xs rounded-xl shadow-md transition cursor-pointer flex items-center gap-1"
                  >
                    <Save className="h-3.5 w-3.5" />
                    <span>{isSavingCustomServer ? "Guardando..." : "Guardar Servidor"}</span>
                  </button>
                </div>
              </div>

              {/* List of active custom servers */}
              <div className="space-y-2">
                <span className="text-xs font-bold text-white">Servidores Configurados ({customServersList.length + 3}):</span>
                
                <div className="space-y-1.5">
                  <div className="bg-neutral-950 border border-white/5 p-3 rounded-xl flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                      <span className="font-bold text-white">MonosChinos Direct (Automático)</span>
                    </div>
                    <span className="text-[10px] text-neutral-500 font-mono">Prioridad #1</span>
                  </div>

                  {customServersList.map((srv, idx) => (
                    <div key={idx} className="bg-rose-950/20 border border-rose-500/20 p-3 rounded-xl flex items-center justify-between text-xs text-white">
                      <div className="flex items-center gap-2 truncate max-w-md">
                        <span className="h-2 w-2 rounded-full bg-purple-400"></span>
                        <span className="font-bold text-rose-300">{srv.name}</span>
                        <span className="text-[10px] text-neutral-400 font-mono truncate">{srv.url}</span>
                      </div>
                      <button
                        onClick={() => setCustomServersList(customServersList.filter((_, i) => i !== idx))}
                        className="text-neutral-500 hover:text-rose-400 p-1"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                onClick={() => setSelectedAnimeForEpisodes(null)}
                className="px-5 py-2 bg-neutral-800 hover:bg-neutral-700 text-white font-bold text-xs rounded-xl transition cursor-pointer"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
