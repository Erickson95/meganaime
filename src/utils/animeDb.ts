import { Anime, Episode } from "../types";
import catalogJson from "../data/catalog.json";

// Cast catalog items efficiently without generating massive Episode arrays in heap memory
const _catalog: Anime[] = (catalogJson as any[]).map(a => ({
  ...a,
  episodes: a.episodes || []
}));

export function loadCatalog(): Anime[] {
  return _catalog;
}

// MOCK_ANIMES is empty in the bundle — full catalog loaded at runtime on server
export const MOCK_ANIMES: Anime[] = [];

// Helper to calculate available episode count for airing animes
export function getAvailableEpisodesCountForAiring(anime: Anime): number {
  const normId = (anime.id || "").toLowerCase();
  const normTitle = (anime.title || "").toLowerCase();

  if (normId.includes("the-exiled-heavy-knight") || normId.includes("tensei-juukishi") || normTitle.includes("heavy knight") || normTitle.includes("tensei juukishi")) {
    return Math.max(10, anime.airedEpisodesCount || 0, anime.episodesCount || 0);
  }
  if (normId.includes("one-piece") || normTitle.includes("one piece")) return Math.max(1176, anime.airedEpisodesCount || 0);
  if (normId.includes("bleach-sennen-kessen") || normId.includes("thousand-year")) return Math.max(47, anime.airedEpisodesCount || 0);
  if (normId.includes("bleach-tv") || (normTitle === "bleach" && anime.status === "Finalizado")) return 366;
  if (normId.includes("tensei-shitara-slime") || normId.includes("reincarnated-as-a-slime") || normTitle.includes("slime")) return Math.max(20, anime.airedEpisodesCount || 0);
  if (normId.includes("the-elusive-samurai") || normId.includes("nige-jouzu") || normTitle.includes("elusive samurai") || normTitle.includes("nige jouzu")) return Math.max(7, anime.airedEpisodesCount || 0);
  if (normId.includes("mushoku-tensei") || normTitle.includes("mushoku tensei")) return Math.max(10, anime.airedEpisodesCount || 0);
  if (normId.includes("jaadugar") || normTitle.includes("jaadugar")) return Math.max(10, anime.airedEpisodesCount || 0);
  if (normId.includes("yomi-no-tsugai") || normTitle.includes("yomi no tsugai")) return Math.max(21, anime.airedEpisodesCount || 0);
  if (normId.includes("black-torch") || normTitle.includes("black torch")) return Math.max(9, anime.airedEpisodesCount || 0);
  if (normId.includes("youjo-senki") || normId.includes("tanya-the-evil") || normTitle.includes("youjo senki") || normTitle.includes("tanya")) return Math.max(8, anime.airedEpisodesCount || 0);
  if (normId.includes("grand-blue") || normTitle.includes("grand blue")) return Math.max(9, anime.airedEpisodesCount || 0);
  if (normId.includes("ryoumin") || normId.includes("ryomin") || normTitle.includes("ryoumin") || normTitle.includes("ryomin") || normTitle.includes("frontier lord")) return Math.max(9, anime.airedEpisodesCount || 0);

  if (anime.airedEpisodesCount !== undefined && anime.airedEpisodesCount > 0) {
    return anime.airedEpisodesCount;
  }

  return anime.episodesCount || 12;
}

export function generateEpisodesForAnime(anime: Anime): Episode[] {
  const isMovie = anime.type === "Película";
  const isOVA = anime.type === "OVA";
  const targetCount = isMovie ? 1 : isOVA ? 1 : (anime.status === "En emisión" ? getAvailableEpisodesCountForAiring(anime) : (anime.episodesCount || 12));

  // If already has episodes array with at least targetCount episodes, return it
  if (Array.isArray(anime.episodes) && anime.episodes.length >= targetCount && anime.episodes.length > 0) {
    return anime.episodes;
  }

  // Otherwise generate full list up to targetCount preserving existing episode data
  const baseEpisodes = Array.isArray(anime.episodes) ? anime.episodes : [];
  const existingMap = new Map(baseEpisodes.map(ep => [ep.number, ep]));

  return Array.from({ length: targetCount }, (_, i) => {
    const num = i + 1;
    const existing = existingMap.get(num);
    if (existing && existing.videoUrl) {
      return existing;
    }

    let epTitle = isMovie
      ? anime.title
      : isOVA
        ? `${anime.title} - OVA ${num}`
        : `${anime.title} - Episodio ${num}`;

    if (anime.id.includes("bleach-sennen-kessen") || (anime.title || "").toLowerCase().includes("thousand-year")) {
      if (num <= 13) {
        epTitle = `Episodio ${num} (Parte 1: The Blood Warfare)`;
      } else if (num <= 26) {
        epTitle = `Episodio ${num} (Parte 2: The Separation - Ep. ${num - 13})`;
      } else if (num <= 39) {
        epTitle = `Episodio ${num} (Parte 3: The Conflict - Ep. ${num - 26})`;
      } else {
        const isLatest = num === targetCount;
        epTitle = `Episodio ${num} (Parte 4: The Calamity - Ep. ${num - 39}${isLatest ? " • Estreno de hoy" : ""})`;
      }
    }

    return {
      id: `${anime.id}-ep-${num}`,
      title: epTitle,
      number: num,
      animeId: anime.id,
      animeTitle: anime.title,
      coverUrl: anime.coverUrl,
      videoUrl: `/api/episode/${anime.id}-ep-${num}`,
      releaseDate: new Date(Date.now() - (targetCount - num) * 7 * 24 * 60 * 60 * 1000).toLocaleDateString("es-ES")
    };
  });
}

/**
 * Returns catalog animes without allocating 60,000 Episode objects in memory at once.
 * Prevents WKWebView OOM (Out-Of-Memory) Crashes on iOS.
 * @param includeInactive If true, returns all animes including disabled/deactivated ones (for AdminPanel). If false (default), excludes disabled titles for normal users.
 */
export function getAnimesWithEpisodes(includeInactive = false): Anime[] {
  if (includeInactive) return _catalog;
  return _catalog.filter(a => a.active !== false);
}

export function generateMockRecentEpisodes(animes: Anime[]): Episode[] {
  const episodes: Episode[] = [];
  const airing = animes.filter(a => a.status === "En emisión" && a.type !== "Película");
  const otherRecent = animes.filter(a => a.status !== "En emisión" && a.type !== "Película");
  const combined = [...airing, ...otherRecent].slice(0, 36);

  for (const anime of combined) {
    const epNum = getAvailableEpisodesCountForAiring(anime);
    if (epNum <= 0) continue;
    episodes.push({
      id: `${anime.id}-ep-${epNum}`,
      title: anime.type === "Película"
        ? anime.title
        : `${anime.title} - Episodio ${epNum}`,
      number: epNum,
      animeId: anime.id,
      animeTitle: anime.title,
      coverUrl: anime.coverUrl,
      videoUrl: `/api/episode/${anime.id}-ep-${epNum}`,
      releaseDate: "Hoy"
    });
  }
  return episodes;
}

export function getBaseTitle(title: string): string {
  if (!title) return "";
  const baseLower = title.toLowerCase().trim();
  if (baseLower.includes("that time i got reincarnated as a slime") || baseLower.includes("tensei shitara slime datta ken")) {
    return "That Time I Got Reincarnated as a Slime";
  }
  if (baseLower.includes("demon slayer") || baseLower.includes("kimetsu no yaiba")) return "Kimetsu no Yaiba";
  if (baseLower.includes("attack on titan") || baseLower.includes("shingeki no kyojin")) return "Shingeki no Kyojin";
  if (baseLower.includes("jujutsu kaisen")) return "Jujutsu Kaisen";
  if (baseLower.includes("chainsaw man")) return "Chainsaw Man";
  if (baseLower.includes("my hero academia") || baseLower.includes("boku no hero academia")) return "Boku no Hero Academia";
  if (baseLower.includes("solo leveling")) return "Solo Leveling";
  if (baseLower === "one piece" || baseLower === "one piece (tv)" || baseLower === "one piece tv" || baseLower.startsWith("one piece (1999)")) return "One Piece";

  let base = title;
  base = base.replace(/\s+Temporada\s+\d+/gi, "");
  base = base.replace(/\s+Season\s+\d+/gi, "");
  base = base.replace(/\s+Part\s+\d+/gi, "");
  base = base.replace(/\s+Parte\s+\d+/gi, "");
  base = base.replace(/\s+\d+(nd|rd|th|st)\s+Season/gi, "");
  base = base.replace(/\s+\(TV\)/gi, "");
  base = base.replace(/\s*:\s*$/, "");
  return base.trim();
}

export function groupAnimeSeasons(animes: Anime[]): Anime[] {
  if (!animes || animes.length === 0) return [];
  const groups: Record<string, Anime[]> = {};
  for (const anime of animes) {
    const base = getBaseTitle(anime.title).toLowerCase().trim();
    if (!groups[base]) groups[base] = [];
    groups[base].push(anime);
  }
  const result: Anime[] = [];
  for (const baseKey of Object.keys(groups)) {
    const group = groups[baseKey];
    group.sort((a, b) => {
      const getSN = (t: string) => {
        const m = t.match(/Season\s+(\d+)/i) || t.match(/Temporada\s+(\d+)/i);
        return m ? parseInt(m[1], 10) : 1;
      };
      const diff = getSN(a.title) - getSN(b.title);
      return diff !== 0 ? diff : a.year - b.year;
    });
    const rep = { ...group[0] };
    if (group.length > 1) rep.seasons = group;
    result.push(rep);
  }
  return result;
}

export function getAiringBaseCount(animeId: string, fallbackCount: number = 12): number {
  if (animeId.includes("mushoku-tensei-3")) return 6;
  if (animeId.includes("one-piece")) return 1172;
  if (animeId.includes("youjo-senki-2")) return 5;
  if (animeId.includes("slime-4")) return 16;
  return Math.min(5, fallbackCount);
}
