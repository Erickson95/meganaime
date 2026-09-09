export interface VideoServer {
  name: string;
  url: string;
  language?: "sub" | "latino" | "castellano";
}

export interface Episode {
  id: string; // e.g. "one-piece-1110" or from animeid
  title: string; // e.g. "Episodio 1110"
  number: number;
  animeId: string;
  animeTitle: string;
  coverUrl?: string;
  videoUrl?: string; // Player iframe or MP4 url
  videoServers?: VideoServer[];
  releaseDate?: string;
}

export interface Anime {
  id: string; // URL slug e.g. "one-piece"
  title: string;
  synopsis: string;
  coverUrl: string;
  bannerUrl: string;
  genres: string[];
  status: "En emisión" | "Finalizado" | "Próximamente";
  rating: number;
  type: "Anime" | "Película" | "OVA" | "Especial" | string;
  episodesCount: number;
  year: number;
  episodes: Episode[];
  seasons?: Anime[];
  relatedMangas?: Manga[];
  title_romaji?: string;
  title_english?: string;
  title_native?: string;
  external_id?: string | number;
  airedEpisodesCount?: number;
  hasDub?: boolean;
  dubLanguages?: ("latino" | "castellano")[];
  active?: boolean; // Default true. If false, hidden from public platform
  studios?: string[];
  season?: string;
  broadcastDay?: string;
  trailerUrl?: string;
  ageRating?: string;
}

export interface Manga {
  id: string;
  title: string;
  synopsis: string;
  coverUrl: string;
  genres: string[];
  status: "En emisión" | "Finalizado" | "Próximamente";
  year: number;
  chaptersCount: number;
  rating: number;
  active?: boolean; // Default true. If false, hidden from public platform
  author?: string;
}

export interface AdminRoleRecord {
  email: string;
  name?: string;
  role: 'super_admin' | 'admin' | 'moderator';
  addedAt: string;
  addedBy: string;
}

export interface Profile {
  id: string;
  name: string;
  avatarUrl: string;
  favorites: string[]; // List of anime IDs for this profile
  history: Array<{ episodeId: string; watchedAt: string; progress: number }>; // History for this profile
  isChild?: boolean;
}

export type WatchStatus = "viendo" | "por_ver" | "completado" | "en_pausa" | "abandonado";

export interface WatchlistItem {
  animeId: string;
  status: WatchStatus;
  updatedAt: string;
}

export interface User {
  id: string;
  username: string;
  name?: string;
  email: string;
  plan?: string;
  favorites: string[]; // List of anime IDs (legacy/fallback)
  watchlist?: WatchlistItem[];
  ratings?: Record<string, number>; // user rating per animeId
  history: Array<{ episodeId: string; watchedAt: string; progress: number }>;
  isAdmin?: boolean;
  profiles?: Profile[]; // Multiple sub-profiles like Crunchyroll
  activeProfileId?: string; // ID of the currently active profile
}

export const ADMIN_EMAILS: string[] = [
  "baezcabrera.j.r@gmail.com",
  "ericksonflores20@gmail.com"
];

let cachedDynamicAdmins: string[] = [];

export function setDynamicAdmins(admins: (string | AdminRoleRecord)[]) {
  if (Array.isArray(admins)) {
    cachedDynamicAdmins = admins.map(a => typeof a === 'string' ? a.trim().toLowerCase() : a.email.trim().toLowerCase());
  }
}

export function isUserAdmin(email?: string | null, extraAdmins?: string[]): boolean {
  if (!email) return false;
  const clean = email.trim().toLowerCase();
  if (ADMIN_EMAILS.includes(clean) || clean.startsWith("baezcabrera.j.r") || clean.startsWith("ericksonflores20")) {
    return true;
  }
  if (cachedDynamicAdmins.includes(clean)) {
    return true;
  }
  if (extraAdmins && extraAdmins.map(e => e.trim().toLowerCase()).includes(clean)) {
    return true;
  }
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const localCached = window.localStorage.getItem("megaAnime_dynamic_admins");
      if (localCached) {
        const list = JSON.parse(localCached);
        if (Array.isArray(list) && list.some((item: any) => (typeof item === 'string' ? item : item.email)?.trim().toLowerCase() === clean)) {
          return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user?: Omit<User, "password">;
  token?: string;
}

export const GENRES_LIST = [
  "Acción",
  "Aventura",
  "Comedia",
  "Drama",
  "Fantasía",
  "Romance",
  "Ciencia Ficción",
  "Shounen",
  "Seinen",
  "Recuentos de la vida",
  "Terror",
  "Sobrenatural",
  "Misterio",
  "Psicológico",
  "Escolar",
  "Deportes",
  "Mecha",
  "Isekai"
];
