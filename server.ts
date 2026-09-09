import express from "express";
import "dotenv/config";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { Readable } from "stream";
import { parse as parseUrl } from "url";
import { scrapeHome, scrapeAnime, scrapeSearch, scrapeEpisode, scrapeEpisodeFromTioAnime, getRealAiredEpCount, updateEpisodesRepository, fetchAniListMovies, verifyVideoServers, queryAniListGraphQL, AnimeApiAggregator } from "./src/utils/scraper";
import { GENRES_LIST, Manga } from "./src/types";
import { getAnimePlaceholder } from "./src/utils/imageUtils";
import { MOCK_MANGAS } from "./src/utils/mangaDb";
import { MOCK_ANIMES, getAnimesWithEpisodes } from "./src/utils/animeDb";
import { fuzzyMatch } from "./src/utils/titleNormalizer";

// Local catalog — loaded dynamically from catalog.json
const getLocalCatalog = () => getAnimesWithEpisodes();
let LOCAL_CATALOG = getAnimesWithEpisodes();
console.log(`[Catalog] Loaded ${LOCAL_CATALOG.length} titles from local catalog.`);

import cron from "node-cron";
import NodeCache from "node-cache";
import nodemailer from "nodemailer";
import { postNewReleaseToFacebook, publishRandomAnimeIfDue } from "./src/utils/facebookAutoPost";

// Initialize cache: check every 2 minutes for expired items
const apiCache = new NodeCache({ stdTTL: 1800, checkperiod: 120 });
apiCache.flushAll();

// In-memory simulation of user storage (active session helper)
const USERS_DB: Record<string, { username: string; email: string; favorites: string[] }> = {};

// 6-Digit Email OTP verification store: Record<email, { code: string; attemptsLeft: number; expiresAt: number }>
const OTP_STORE: Record<string, { code: string; attemptsLeft: number; expiresAt: number }> = {};

// Transporter for 6-digit OTP verification emails
const emailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER || "baezcabrera.j.r@gmail.com",
    pass: process.env.SMTP_PASS || ""
  }
});

// ── Drive manifest: loaded ONCE at startup, kept in memory ──
// Avoids fs.readFileSync on every /api/episode/:id request under high concurrency
let DRIVE_MANIFEST: Record<string, any> = {};
(function loadDriveManifest() {
  const manifestPaths = [
    path.join(process.cwd(), "dist/drive_episodes.json"),
    path.join(process.cwd(), "src/data/drive_episodes.json")
  ];
  for (const mp of manifestPaths) {
    try {
      if (fs.existsSync(mp)) {
        DRIVE_MANIFEST = JSON.parse(fs.readFileSync(mp, "utf-8"));
        console.log(`[Manifest] Loaded drive_episodes.json (${Object.keys(DRIVE_MANIFEST).length} series) from ${mp}`);
        break;
      }
    } catch (e) {
      console.warn("[Manifest] Failed to load drive_episodes.json:", e);
    }
  }
})();

// ── Cloudflare R2 Manifest: direct native high-speed streams ($0 egress) ──
let R2_MANIFEST: Record<string, any> = {};
function loadR2Manifest(): Record<string, any> {
  const r2Paths = [
    path.join(process.cwd(), "src/data/r2_episodes.json"),
    path.join(process.cwd(), "dist/r2_episodes.json")
  ];
  for (const rp of r2Paths) {
    try {
      if (fs.existsSync(rp)) {
        R2_MANIFEST = JSON.parse(fs.readFileSync(rp, "utf-8"));
        return R2_MANIFEST;
      }
    } catch (e) {
      console.warn("[R2 Manifest] Failed to load r2_episodes.json:", e);
    }
  }
  return R2_MANIFEST;
}
loadR2Manifest();

// ── OTP Rate Limiter: max 3 OTP requests per IP per 10 minutes ──
const OTP_RATE_LIMITER: Record<string, { count: number; resetAt: number }> = {};
function checkOtpRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = OTP_RATE_LIMITER[ip];
  if (!record || now > record.resetAt) {
    OTP_RATE_LIMITER[ip] = { count: 1, resetAt: now + 10 * 60 * 1000 };
    return true; // allowed
  }
  if (record.count >= 3) return false; // blocked
  record.count++;
  return true; // allowed
}

// Periodically purge expired OTP and rate limiter entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const email of Object.keys(OTP_STORE)) {
    if (OTP_STORE[email].expiresAt < now) delete OTP_STORE[email];
  }
  for (const ip of Object.keys(OTP_RATE_LIMITER)) {
    if (OTP_RATE_LIMITER[ip].resetAt < now) delete OTP_RATE_LIMITER[ip];
  }
}, 5 * 60 * 1000);

export async function createExpressApp() {
  const app = express();

  // Universal CORS middleware for iOS / Android / Web clients
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }
    next();
  });

  // --- ADMIN ROLES IMPLEMENTATION ---
  const adminRolesPath = path.join(process.cwd(), "src/data/admin_roles.json");
  const adminRolesDistPath = path.join(process.cwd(), "dist/admin_roles.json");

  function readAdminRoles(): any[] {
    try {
      if (fs.existsSync(adminRolesPath)) {
        return JSON.parse(fs.readFileSync(adminRolesPath, "utf8"));
      } else if (fs.existsSync(adminRolesDistPath)) {
        return JSON.parse(fs.readFileSync(adminRolesDistPath, "utf8"));
      }
    } catch (e) {
      console.error("Error reading admin_roles.json:", e);
    }
    return [
      { email: "baezcabrera.j.r@gmail.com", name: "Juan Ramón Báez", role: "super_admin", addedAt: "2026-01-10T00:00:00.000Z", addedBy: "system" },
      { email: "ericksonflores20@gmail.com", name: "Erickson Flores", role: "admin", addedAt: "2026-09-08T00:00:00.000Z", addedBy: "baezcabrera.j.r@gmail.com" }
    ];
  }

  function writeAdminRoles(roles: any[]) {
    try {
      const parentDir = path.dirname(adminRolesPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(adminRolesPath, JSON.stringify(roles, null, 2), "utf8");
      if (fs.existsSync(path.dirname(adminRolesDistPath))) {
        fs.writeFileSync(adminRolesDistPath, JSON.stringify(roles, null, 2), "utf8");
      }
    } catch (e) {
      console.error("Error writing admin_roles.json:", e);
    }
  }

  // --- CUSTOM ADMIN DATABASE IMPLEMENTATION ---
  const customDbPath = path.join(process.cwd(), "src/utils/customAnimes.json");
  const customMangasDbPath = path.join(process.cwd(), "src/utils/customMangas.json");

  function readCustomDb(): any[] {
    try {
      if (fs.existsSync(customDbPath)) {
        const raw = fs.readFileSync(customDbPath, "utf8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("Error reading customDb:", e);
    }
    return [];
  }

  function writeCustomDb(data: any[]) {
    try {
      const parentDir = path.dirname(customDbPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(customDbPath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.error("Error writing customDb:", e);
    }
  }

  function readCustomMangasDb(): any[] {
    try {
      if (fs.existsSync(customMangasDbPath)) {
        const raw = fs.readFileSync(customMangasDbPath, "utf8");
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("Error reading customMangasDb:", e);
    }
    return [];
  }

  function writeCustomMangasDb(data: any[]) {
    try {
      const parentDir = path.dirname(customMangasDbPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(customMangasDbPath, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.error("Error writing customMangasDb:", e);
    }
  }

  let GLOBAL_CUSTOM_ANIMES = readCustomDb();
  let GLOBAL_CUSTOM_MANGAS = readCustomMangasDb();

  const catalogSrcPath = path.join(process.cwd(), "src/data/catalog.json");
  const catalogDistPath = path.join(process.cwd(), "dist/catalog.json");

  function persistCatalog(catalogData: any[]) {
    try {
      const dataStr = JSON.stringify(catalogData, null, 2);
      fs.writeFileSync(catalogSrcPath, dataStr, "utf8");
      if (fs.existsSync(path.dirname(catalogDistPath))) {
        fs.writeFileSync(catalogDistPath, dataStr, "utf8");
      }
      console.log(`[Catalog] Successfully persisted ${catalogData.length} titles to catalog.json`);
    } catch (e) {
      console.error("[Catalog] Error writing catalog.json:", e);
    }
  }

  async function scrapeAnimeFromMonosChinosByTitle(title: string): Promise<any> {
    const cleanTitle = title
      .toLowerCase()
      .replace(/season \d+/gi, "")
      .replace(/temporada \d+/gi, "")
      .replace(/[:.\-()\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const domains = [
      "https://monoschinos2.com",
      "https://monoschinos3.com",
      "https://monoschinos2.net",
      "https://monoschinos.net",
      "https://monoschinos.st"
    ];

    for (const domain of domains) {
      try {
        const searchUrl = `${domain}/buscar?q=${encodeURIComponent(cleanTitle)}`;
        const searchRes = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          },
          signal: AbortSignal.timeout(4000)
        });
        
        if (searchRes.ok) {
          const searchText = await searchRes.text();
          const searchRegex = /href=["']?(?:https?:\/\/[^\/]+)?\/anime\/([^"'\s>]+)["']?/gi;
          let match;
          const matchedSlugs: string[] = [];
          while ((match = searchRegex.exec(searchText)) !== null) {
            matchedSlugs.push(match[1].replace(/-sub-espanol$/, ""));
          }
          
          if (matchedSlugs.length > 0) {
            const foundSlug = matchedSlugs[0];
            
            // Now scrape the details page of MonosChinos
            const animeUrl = `${domain}/anime/${foundSlug}`;
            const detailsRes = await fetch(animeUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
              },
              signal: AbortSignal.timeout(4000)
            });

            if (detailsRes.ok) {
              const html = await detailsRes.text();
              
              let mTitle = title;
              let mSynopsis = "";
              let mCoverUrl = "";
              const mGenres: string[] = [];
              let mEpisodesCount = 12;

              // Parse Title
              const titleMatch = html.match(/<h1 class="title-nit[^>]*>([^<]+)<\/h1>/i);
              if (titleMatch) mTitle = titleMatch[1].trim();

              // Parse Synopsis
              const synMatch = html.match(/<p class="text-justify[^>]*>([^<]+)<\/p>/i);
              if (synMatch) mSynopsis = synMatch[1].trim();

              // Parse Cover
              const coverMatch = html.match(/<div class="chapter-pic">[^]*?<img[^>]+src="([^"]+)"/i);
              if (coverMatch) mCoverUrl = coverMatch[1];

              // Parse Genres
              const genreRegex = /<a class="btn btn-outline-primary[^>]*>([^<]+)<\/a>/gi;
              let gMatch;
              while ((gMatch = genreRegex.exec(html)) !== null) {
                if (!mGenres.includes(gMatch[1])) mGenres.push(gMatch[1]);
              }

              // Parse Episodes
              const epRegex = /class="episode-item"[^>]*>Episode\s*(\d+)/gi;
              let maxEp = 0;
              let epM;
              while ((epM = epRegex.exec(html)) !== null) {
                const num = parseInt(epM[1], 10);
                if (num > maxEp) maxEp = num;
              }
              mEpisodesCount = maxEp || 12;

              const id = mTitle.toLowerCase()
                .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/(^-|-$)/g, "");

              return {
                id,
                title: mTitle,
                synopsis: mSynopsis,
                coverUrl: mCoverUrl,
                genres: mGenres.length > 0 ? mGenres : ["Acción"],
                status: "En emisión",
                rating: 8.5,
                type: "Anime",
                episodesCount: mEpisodesCount,
                year: new Date().getFullYear(),
                episodes: []
              };
            }
          }
        }
      } catch (e) {
        console.warn(`[Audit/Scraper] Sourcing from MonosChinos failed on domain ${domain}:`, e);
      }
    }
    return null;
  }

  // Audit existing custom database to remove/migrate any AnimeFLV-sourced entries
  async function auditAndMigrateCustomDatabase() {
    let customAnimes = readCustomDb();
    if (customAnimes.length === 0) return;

    console.log("[Audit] Checking custom database for AnimeFLV entries...");
    const updatedList = [];
    let changed = false;

    for (const anime of customAnimes) {
      const isAnimeFLVEntry = (anime.coverUrl && anime.coverUrl.includes("animeflv.net"));
      if (isAnimeFLVEntry) {
        console.log(`[Audit] Custom anime "${anime.title}" was sourced from AnimeFLV. Sourcing from MonosChinos instead...`);
        const monosAnime = await scrapeAnimeFromMonosChinosByTitle(anime.title);
        if (monosAnime) {
          updatedList.push(monosAnime);
          changed = true;
          console.log(`[Audit] Successfully migrated "${anime.title}" to MonosChinos.`);
        } else {
          changed = true;
          console.log(`[Audit] "${anime.title}" is not available on MonosChinos. Removing from database.`);
        }
      } else {
        updatedList.push(anime);
      }
    }

    if (changed) {
      GLOBAL_CUSTOM_ANIMES = updatedList;
      writeCustomDb(updatedList);
      apiCache.flushAll();
      console.log("[Audit] Custom database audit completed and updated.");
    } else {
      console.log("[Audit] Custom database is clean of AnimeFLV entries.");
    }
  }

  // Trigger migration audit immediately
  auditAndMigrateCustomDatabase();

  // File to persist dynamically retrieved airing episodes count
  const airingEpisodesPath = path.join(process.cwd(), "src/utils/airing_episodes.json");

  function loadAiringEpisodesFromFile() {
    try {
      if (fs.existsSync(airingEpisodesPath)) {
        const raw = fs.readFileSync(airingEpisodesPath, "utf8");
        const data = JSON.parse(raw);
        console.log("Loaded cached airing episode counts:", Object.keys(data).length);
        getAnimesWithEpisodes().forEach(anime => {
          if (data[anime.id] !== undefined) {
            anime.airedEpisodesCount = data[anime.id];
          }
        });
      }
    } catch (e) {
      console.error("Failed to load cached airing episode counts:", e);
    }
  }

  async function refreshAiringEpisodesCount() {
    console.log("Checking airing/releasing anime episodes on AniList...");
    const counts: Record<string, number> = {};
    
    // Read current ones first
    try {
      if (fs.existsSync(airingEpisodesPath)) {
        const raw = fs.readFileSync(airingEpisodesPath, "utf8");
        Object.assign(counts, JSON.parse(raw));
      }
    } catch (e) {}

    let updatedAny = false;
    for (const anime of getAnimesWithEpisodes()) {
      if (anime.status === "En emisión" && anime.external_id) {
        const extId = parseInt(anime.external_id.toString(), 10);
        if (!isNaN(extId)) {
          try {
            console.log(`[AniList Audit] Fetching metadata for airing anime "${anime.title}" (ID: ${extId})...`);
            const data = await queryAniListGraphQL({ id: extId });
            if (data && data.Page && data.Page.media && data.Page.media[0]) {
              const media = data.Page.media[0];
              let count = anime.episodesCount;
              if (media.nextAiringEpisode) {
                count = Math.max(1, media.nextAiringEpisode.episode - 1);
              } else if (media.episodes) {
                count = media.episodes;
              }
              
              if (counts[anime.id] !== count) {
                counts[anime.id] = count;
                anime.airedEpisodesCount = count;
                updatedAny = true;
                console.log(`[AniList Audit] Airing anime "${anime.title}" updated episodes count: ${count}`);
              } else {
                anime.airedEpisodesCount = count;
              }
            }
          } catch (e: any) {
            console.warn(`[AniList Audit] Failed to query AniList for "${anime.title}":`, e.message || e);
          }
        }
      }
    }

    if (updatedAny) {
      try {
        const parentDir = path.dirname(airingEpisodesPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(airingEpisodesPath, JSON.stringify(counts, null, 2), "utf8");
        console.log("Successfully persisted updated airing episode counts to disk.");
      } catch (e) {
        console.error("Failed to write airing episodes count to file:", e);
      }
    }
  }

  // Load cached episode counts from file
  loadAiringEpisodesFromFile();

  // Initialize background Cron Job (8:00 AM Eastern Time every day)
  cron.schedule("0 8 * * *", async () => {
    console.log("CRON JOB TRIGGERED: Starting automatic data refresh at 8:00 AM Eastern Time...");
    await updateEpisodesRepository();
    await refreshAiringEpisodesCount();
    apiCache.flushAll(); // Clear cache on manual refresh
  }, {
    timezone: "America/New_York"
  });
  
  // Automatic Facebook Auto-Poster: runs every 3 hours natively on the backend server
  cron.schedule("0 */3 * * *", () => {
    console.log("[FB Cron] ⏰ Running scheduled 3-hour Facebook auto-post task...");
    publishRandomAnimeIfDue().catch(e => console.warn("[FB Cron] Error in 3-hour auto-post:", e));
  }, {
    timezone: "America/New_York"
  });

  // Automatic Airing Anime Downloader: checks for new releases every 30 minutes
  cron.schedule("*/30 * * * *", () => {
    console.log("[Auto-Downloader Cron] ⏰ Triggering scheduled 30-min airing anime sweep...");
    try {
      const { spawn } = require("child_process");
      const scriptPath = path.join(process.cwd(), "scripts/auto_airing_downloader.cjs");
      if (fs.existsSync(scriptPath)) {
        const child = spawn("node", [scriptPath], { detached: true, stdio: "ignore" });
        child.unref();
      }
    } catch (e: any) {
      console.warn("[Auto-Downloader Cron] Failed to spawn sweep:", e.message);
    }
  });

  // Pre-fetch the latest episodes asynchronously after server startup (skip during Firebase CLI analysis)
  if (process.env.K_SERVICE || (!process.argv.includes("deploy") && process.env.NODE_ENV === "production")) {
    setTimeout(() => {
      updateEpisodesRepository().catch(e => console.warn("Background prefetch error:", e));
      refreshAiringEpisodesCount().catch(e => console.warn("Airing count error:", e));
    }, 5000);
  }

  // Body parsers
  app.use(express.json());

  app.get("/robots.txt", (req, res) => {
    res.header("Content-Type", "text/plain");
    res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\n\nSitemap: https://mega-anime.com/sitemap.xml\n`);
  });

  // ── 0. OTP Email Verification Endpoints for Registration ──
  app.post("/api/auth/send-otp", async (req, res) => {
    const email = (req.body?.email as string || "").toLowerCase().trim();
    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Dirección de correo electrónico inválida." });
    }

    // Rate limiting: max 3 OTP requests per IP per 10 minutes
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      || req.headers["x-real-ip"] as string
      || req.socket.remoteAddress
      || "unknown";
    if (!checkOtpRateLimit(clientIp)) {
      console.warn(`[OTP Engine] ⛔ Rate limit exceeded for IP ${clientIp} (email: ${email})`);
      return res.status(429).json({ error: "Demasiados intentos. Por favor espera 10 minutos antes de solicitar un nuevo código." });
    }

    // Generate random 6-digit OTP code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

    OTP_STORE[email] = {
      code,
      attemptsLeft: 3,
      expiresAt
    };

    console.log(`[OTP Engine] 🔒 Generated 6-Digit OTP for ${email}: [ ${code} ] (Expires in 10m, Max 3 attempts)`);

    const htmlMessage = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px; background-color: #0a0a0a; color: #ffffff; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #f43f5e; font-size: 28px; font-weight: 900; margin: 0;">mega<span style="color: #ffffff;">Anime</span></h1>
          <p style="color: #a3a3a3; font-size: 13px; margin-top: 6px;">Código de Verificación de Registro</p>
        </div>
        <div style="background-color: #171717; padding: 24px; border-radius: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.05);">
          <p style="color: #d4d4d4; font-size: 14px; margin-bottom: 16px;">Introduce el siguiente código de <strong>6 dígitos</strong> para completar tu registro:</p>
          <div style="font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #f43f5e; background-color: #000000; padding: 16px 24px; border-radius: 12px; display: inline-block; border: 1px solid #f43f5e; font-family: monospace;">
            ${code}
          </div>
          <p style="color: #737373; font-size: 11px; margin-top: 16px;">Este código expirará en 10 minutos. Tienes un máximo de <strong>3 intentos</strong> para introducirlo correctamente.</p>
        </div>
        <p style="color: #525252; font-size: 10px; text-align: center; margin-top: 24px;">Si no solicitaste este registro en megaAnime, puedes ignorar este mensaje.</p>
      </div>
    `;

    try {
      if (process.env.SMTP_PASS) {
        await emailTransporter.sendMail({
          from: '"megaAnime Seguridad" <baezcabrera.j.r@gmail.com>',
          to: email,
          subject: `${code} es tu código de verificación | megaAnime`,
          html: htmlMessage
        });
      }
    } catch (e: any) {
      console.warn(`[OTP Engine] Email dispatch warning for ${email}:`, e.message || e);
    }

    res.json({
      success: true,
      message: `Código enviado a ${email}`,
      debugCode: process.env.NODE_ENV !== "production" ? code : undefined
    });
  });

  app.post("/api/auth/verify-otp", async (req, res) => {
    const email = (req.body?.email as string || "").toLowerCase().trim();
    const code = (req.body?.code as string || "").trim();

    if (!email || !code) {
      return res.status(400).json({ error: "Faltan parámetros requeridos (email, code)." });
    }

    const record = OTP_STORE[email];

    if (!record) {
      return res.status(400).json({
        error: "No hay ninguna solicitud de verificación activa para este correo. Por favor inicia el registro nuevamente.",
        expired: true
      });
    }

    // Check 10-minute expiration
    if (Date.now() > record.expiresAt) {
      delete OTP_STORE[email];
      return res.status(400).json({
        error: "El código de 6 dígitos ha expirado (límite 10 minutos). Por favor solicita uno nuevo.",
        expired: true
      });
    }

    // Validate 6-digit OTP code
    if (record.code !== code) {
      record.attemptsLeft -= 1;

      if (record.attemptsLeft <= 0) {
        // STRICT RULE: 3 failed attempts cancels registration immediately!
        delete OTP_STORE[email];
        console.warn(`[OTP Engine] ❌ Max failed attempts (3/3) reached for ${email}. OTP session destroyed.`);
        return res.status(400).json({
          error: "⚠️ Has alcanzado el límite máximo de 3 intentos fallidos. Por seguridad, el registro ha sido cancelado y debes empezar de nuevo.",
          maxAttemptsExceeded: true,
          attemptsLeft: 0
        });
      }

      console.warn(`[OTP Engine] ⚠️ Incorrect OTP for ${email}. Submitted: ${code}, Correct: ${record.code}. Remaining attempts: ${record.attemptsLeft}`);
      return res.status(400).json({
        error: `Código de 6 dígitos incorrecto. Te quedan ${record.attemptsLeft} ${record.attemptsLeft === 1 ? 'intento' : 'intentos'}.`,
        attemptsLeft: record.attemptsLeft
      });
    }

    // SUCCESS: OTP is valid!
    delete OTP_STORE[email];
    console.log(`[OTP Engine] ✅ OTP verified successfully for ${email}`);
    res.json({
      success: true,
      message: "Código verificado correctamente."
    });
  });

  // --- GOOGLE OAUTH PORTAL FOR NATIVE IOS & ANDROID APPS ---
  app.get("/api/auth/google-start", (req, res) => {
    const state = (req.query?.state as string || "").trim();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Iniciar Sesión con Google - megaAnime</title>
  <style>
    body {
      background-color: #0a0a0a;
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      text-align: center;
    }
    .card {
      background: #171717;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 24px;
      padding: 36px 28px;
      max-width: 380px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
    }
    .logo {
      font-size: 24px;
      font-weight: 900;
      color: #e11d48;
      letter-spacing: -0.5px;
      margin-bottom: 24px;
    }
    .logo span { color: #ffffff; }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid rgba(225, 29, 72, 0.2);
      border-top-color: #e11d48;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .btn {
      display: inline-block;
      background: #e11d48;
      color: white;
      text-decoration: none;
      padding: 14px 20px;
      border-radius: 14px;
      font-weight: bold;
      margin-top: 24px;
      border: none;
      cursor: pointer;
      font-size: 15px;
      width: 100%;
      box-sizing: border-box;
      transition: opacity 0.2s;
    }
    .btn:active { opacity: 0.8; }
  </style>
  <script type="module">
    import { initializeApp } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-app.js";
    import { getAuth, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.4.0/firebase-auth.js";

    const host = window.location.hostname;
    const authDomain = (host && host !== "localhost" && !host.includes("127.0.0.1")) ? host : "mega-anime.com";

    const firebaseConfig = {
      apiKey: "AIzaSyCiOUFkE_JabN1ho29lZoxssj33TXHUZlg",
      authDomain: authDomain,
      projectId: "megaanime-1c250",
      storageBucket: "megaanime-1c250.firebasestorage.app",
      messagingSenderId: "642402487201",
      appId: "1:642402487201:web:0a0510b6bb43ea6fba99e0"
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const state = "${state}";

    async function login() {
      const statusEl = document.getElementById("status");
      const actionEl = document.getElementById("action-btn");
      const spinnerEl = document.getElementById("spinner");
      try {
        if (spinnerEl) spinnerEl.style.display = "block";
        statusEl.textContent = "Conectando de forma segura con Google...";
        const result = await signInWithPopup(auth, provider);
        const user = result.user;
        statusEl.textContent = "¡Autenticado con éxito! Abriendo megaAnime App...";
        
        const queryParams = "uid=" + encodeURIComponent(user.uid) + "&email=" + encodeURIComponent(user.email || "") + "&name=" + encodeURIComponent(user.displayName || "") + "&photo=" + encodeURIComponent(user.photoURL || "") + "&state=" + encodeURIComponent(state);
        const returnUrl = "megaanime://auth-callback?" + queryParams;
        const legacyReturnUrl = "net.megaanime.app://auth-callback?" + queryParams;
        
        if (actionEl) {
          actionEl.style.display = "block";
          actionEl.href = returnUrl;
          actionEl.textContent = "Abrir en megaAnime App";
          actionEl.onclick = null;
        }

        window.location.href = returnUrl;

        setTimeout(() => {
          try {
            window.location.href = legacyReturnUrl;
          } catch(e) {}
        }, 500);
      } catch (err) {
        console.error(err);
        if (spinnerEl) spinnerEl.style.display = "none";
        statusEl.textContent = "Toca el botón para iniciar sesión con Google:";
        if (actionEl) {
          actionEl.style.display = "block";
          actionEl.href = "#";
          actionEl.onclick = (e) => { e.preventDefault(); login(); };
          actionEl.textContent = "Continuar con Google";
        }
      }
    }

    window.addEventListener("DOMContentLoaded", () => {
      login();
    });
  </script>
</head>
<body>
  <div class="card">
    <div class="logo">mega<span>Anime</span></div>
    <div class="spinner"></div>
    <p id="status" style="color:#a3a3a3; font-size:14px; margin:0; line-height: 1.5;">Iniciando sesión con Google...</p>
    <a id="action-btn" class="btn" style="display:none;">Continuar</a>
  </div>
</body>
</html>`);
  });

  app.all("/api/admin/flush-cache", (req, res) => {
    apiCache.flushAll();
    console.log("[Cache] 🧹 Server apiCache flushed completely!");
    return res.json({ success: true, message: "Cache de servidor vaciada en megaAnime" });
  });

  // ── Periodic Facebook Auto-Post Endpoint (called every 3 hours from node-cron, external cron, or GET link) ──
  // Internally guards against double-posting: will skip if last post was < 3 hours ago.
  app.all("/api/admin/fb-cron", async (req, res) => {
    const secret = req.headers["x-cron-secret"] || req.body?.secret || req.query?.secret;
    const CRON_SECRET = process.env.CRON_SECRET || "megaanime_cron_2026";
    
    // Allow GET without secret if requested directly, or validate if provided
    if (secret && secret !== CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const result = await publishRandomAnimeIfDue();
    return res.json(result);
  });

  // ── Periodic Airing Anime Auto-Downloader Trigger Endpoint ──
  app.all("/api/admin/auto-download", (req, res) => {
    const secret = req.headers["x-cron-secret"] || req.body?.secret || req.query?.secret;
    const CRON_SECRET = process.env.CRON_SECRET || "megaanime_cron_2026";
    if (secret && secret !== CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { spawn } = require("child_process");
      const scriptPath = path.join(process.cwd(), "scripts/auto_airing_downloader.cjs");
      if (fs.existsSync(scriptPath)) {
        const child = spawn("node", [scriptPath], { detached: true, stdio: "ignore" });
        child.unref();
        return res.json({ success: true, message: "Auto-downloader sweep triggered in background." });
      } else {
        return res.status(404).json({ success: false, error: "auto_airing_downloader.cjs not found" });
      }
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Automatic Facebook Page Posting Admin Endpoint ──
  app.post("/api/admin/facebook-post", async (req, res) => {
    const { animeId, episodeId, episodeNumber, title, coverUrl, genres, isMovie } = req.body || {};

    if (!animeId || !episodeNumber) {
      return res.status(400).json({ error: "Faltan parámetros (animeId, episodeNumber)." });
    }

    const item = LOCAL_CATALOG.find(a => a.id === animeId);
    const targetTitle = title || item?.title || animeId;
    const targetCover = coverUrl || item?.coverUrl || "";
    const targetGenres = genres || item?.genres || ["Anime"];
    const targetEpId = episodeId || `${animeId}-ep-${episodeNumber}`;

    const result = await postNewReleaseToFacebook({
      episodeId: targetEpId,
      animeId,
      animeTitle: targetTitle,
      episodeNumber: parseInt(episodeNumber, 10),
      coverUrl: targetCover,
      genres: targetGenres,
      isMovie: isMovie || item?.type === "Película"
    });

    if (result.success) {
      return res.json({ success: true, message: `Publicación enviada exitosamente a Facebook Page!`, postId: result.postId });
    } else {
      return res.status(400).json({ success: false, error: result.error });
    }
  });

  // ── Meta Facebook Page Webhook Endpoints ──
  const FB_VERIFY_TOKEN = process.env.FACEBOOK_VERIFY_TOKEN || "megaanime_webhook_verify_token_2026";

  // GET /api/webhooks/facebook or /webhooks/facebook (Meta Verification Challenge Endpoint)
  app.get(["/api/webhooks/facebook", "/webhooks/facebook"], (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode && token) {
      if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
        console.log(`[FB Webhook] ✅ Meta Webhook Verification successful! Challenge returned: ${challenge}`);
        return res.status(200).send(challenge);
      } else {
        console.warn(`[FB Webhook] ❌ Verification failed. Token mismatch: received "${token}", expected "${FB_VERIFY_TOKEN}"`);
        return res.sendStatus(403);
      }
    }
    return res.status(400).send("Faltan parámetros de verificación de Meta Webhook (hub.mode, hub.verify_token).");
  });

  // POST /api/webhooks/facebook or /webhooks/facebook (Meta Events Receiver)
  app.post(["/api/webhooks/facebook", "/webhooks/facebook"], (req, res) => {
    const body = req.body;

    if (body.object === "page") {
      console.log(`[FB Webhook] 📩 Event received from Facebook Page:`, JSON.stringify(body, null, 2));
      return res.status(200).send("EVENT_RECEIVED");
    } else {
      return res.sendStatus(404);
    }
  });

  // --- API ROUTES ---

  // 1. Get Home Screen lists (Seasonal, Popular, Episodes)
  app.get("/api/home", async (req, res) => {
    const page = parseInt(req.query.page as string, 10) || 1;
    const cacheKey = `home_data_local_p${page}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      const catalog = LOCAL_CATALOG.filter(a => a.active !== false);
      const PAGE_SIZE = 24;
      const offset = (page - 1) * PAGE_SIZE;

      // Seasonal: currently airing
      const seasonal = catalog.filter(a => a.status === "En emisión");
      // Trending: rest of catalog sorted by rating desc
      const trending = [...catalog].sort((a, b) => (b.rating || 0) - (a.rating || 0));
      // Recent episodes: top 20 series latest episodes
      const episodes = trending.slice(0, 20).map(a => ({
        id: `${a.id}-ep-${a.episodesCount || 1}`,
        title: a.type === "Película" ? a.title : `${a.title} - Episodio ${a.episodesCount || 1}`,
        number: a.episodesCount || 1,
        animeId: a.id,
        animeTitle: a.title,
        coverUrl: a.coverUrl,
        videoUrl: `/api/episode/${a.id}-ep-${a.episodesCount || 1}`
      }));

      const totalPages = Math.ceil(trending.length / PAGE_SIZE);
      const data = {
        success: true,
        seasonal: seasonal.slice(0, 24),
        trending: trending.slice(offset, offset + PAGE_SIZE),
        episodes,
        totalPages
      };

      apiCache.set(cacheKey, data, 3600);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to load home page" });
    }
  });

  // 2. Search & Browse animes — local catalog with Airing First -> Year Desc -> Rating Desc sorting
  app.get("/api/search", async (req, res) => {
    const q = (req.query.q as string || "").toLowerCase().trim();
    const type = (req.query.type as string || "").toLowerCase().trim();
    const genre = (req.query.genre as string || "").toLowerCase().trim();
    const page = parseInt(req.query.page as string || "1", 10);
    const PAGE_SIZE = 24;
    const qNorm = q ? q.toLowerCase().trim() : "";

    const cacheKey = `search_local_${q}_${type}_${genre}_p${page}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    const includeInactive = req.query.includeInactive === "true";
    let results = includeInactive ? LOCAL_CATALOG : LOCAL_CATALOG.filter(a => a.active !== false);

    // Filter by search query (title, synopsis, genres)
    if (q) {
      results = results.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.synopsis || "").toLowerCase().includes(q) ||
        (a.genres || []).some((g: string) => g.toLowerCase().includes(q))
      );
    }

    // Filter by genre
    if (genre) {
      const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      const genreNorm = normalize(genre);
      results = results.filter(a => {
        const titleLower = a.title.toLowerCase();
        const synLower = (a.synopsis || "").toLowerCase();
        const matchesGenre = (a.genres || []).some((g: string) => {
          const gNorm = normalize(g);
          return gNorm === genreNorm || gNorm.includes(genreNorm) || genreNorm.includes(gNorm);
        });
        if (matchesGenre) return true;

        // Fallback keyword matching for genres not explicitly tagged in source data
        if ((genreNorm.includes("shonen") || genreNorm.includes("shounen")) && (titleLower.includes("hero") || titleLower.includes("piece") || titleLower.includes("naruto") || titleLower.includes("bleach") || titleLower.includes("yaiba"))) return true;
        if (genreNorm.includes("seinen") && (titleLower.includes("berserk") || titleLower.includes("vinland") || titleLower.includes("monster") || synLower.includes("adulto") || synLower.includes("oscuro"))) return true;
        if (genreNorm.includes("isekai") && (titleLower.includes("isekai") || titleLower.includes("tensei") || titleLower.includes("reencarnac") || synLower.includes("otro mundo"))) return true;
        if (genreNorm.includes("escolar") && (titleLower.includes("gakuen") || titleLower.includes("school") || titleLower.includes("academia") || synLower.includes("escuela") || synLower.includes("estudiante"))) return true;

        return false;
      });
    }

    // Filter by type
    if (type && type !== "todos") {
      if (type === "pelicula" || type === "película" || type === "peliculas" || type === "películas") {
        results = results.filter(a => a.type === "Película");
      } else if (type === "ova" || type === "ovas") {
        results = results.filter(a => a.type === "OVA");
      } else if (type === "anime" || type === "animes" || type === "tv") {
        results = results.filter(a => a.type === "Anime");
      }
    }

    // Relevance score if text query provided
    const getRelevance = (a: any) => {
      if (!qNorm) return 0;
      const t = (a.title || "").toLowerCase().trim();
      if (t === qNorm) return 1000;
      if (t.startsWith(qNorm)) return 500;
      if (a.id === `tioanime-${qNorm}-tv` || a.id === `tioanime-${qNorm}`) return 400;
      return 100;
    };

    // Sorting: 1. Search relevance (exact title match first) -> 2. Airing ("En emisión") first -> 3. Year Descending -> 4. Rating Descending
    results = [...results].sort((a, b) => {
      if (qNorm) {
        const relA = getRelevance(a);
        const relB = getRelevance(b);
        if (relA !== relB) return relB - relA;
      }

      const isAiringA = a.status === "En emisión" ? 1 : 0;
      const isAiringB = b.status === "En emisión" ? 1 : 0;
      if (isAiringA !== isAiringB) {
        return isAiringB - isAiringA;
      }
      const yearA = a.year || 0;
      const yearB = b.year || 0;
      if (yearA !== yearB) {
        return yearB - yearA;
      }
      return (b.rating || 0) - (a.rating || 0);
    });

    const total = results.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const paged = results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const data = { results: paged, total, page, totalPages };
    apiCache.set(cacheKey, data, 3600);
    res.json(data);
  });

  // 2b. Search suggestions (autocomplete)
  app.get("/api/suggestions", async (req, res) => {
    const q = req.query.q as string;
    if (!q || q.length < 2) return res.json([]);

    const cacheKey = `suggestions_${q.toLowerCase()}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      // Use a faster search for suggestions, maybe limited to just first few results
      const data = await scrapeSearch(q);
      const suggestions = data.slice(0, 6).map(anime => ({
        id: anime.id,
        title: anime.title,
        coverUrl: anime.coverUrl,
        type: anime.type,
        year: anime.year
      }));
      
      apiCache.set(cacheKey, suggestions, 3600);
      res.json(suggestions);
    } catch (error) {
      res.json([]);
    }
  });

  // 3. Get single anime details and episode list
  app.get("/api/anime/:id", async (req, res) => {
    const { id } = req.params;
    const cacheKey = `anime_${id}`;
    // Always evaluate catalog data directly to reflect instant metadata updates

    try {
      // Check local catalog first
      const catalogItem = getLocalCatalog().find(a => a.id === id || a.id.replace(/^tioanime-/, "") === id);
      if (catalogItem) {
        const isMovie = catalogItem.type === "Película";
        const isOVA = catalogItem.type === "OVA";
        let count = isMovie ? 1 : isOVA ? 1 : (catalogItem.episodesCount || 12);

        // For Airing animes ("En emisión"), confirm real available episodes directly from streaming providers (TioAnime/MonosChinos)
        // so ONLY episodes with confirmed video servers loadable in player are presented to the user.
        if (catalogItem.status === "En emisión" && !isMovie && !isOVA) {
          const rawSlug = catalogItem.id.replace(/^tioanime-/, "");
          const cachedCountKey = `aired_count_${rawSlug}`;
          const cachedCount = apiCache.get<number>(cachedCountKey);
          if (cachedCount) {
            count = cachedCount;
          } else {
            try {
              const liveCount = await getRealAiredEpCount(rawSlug);
              if (liveCount && liveCount > 0) {
                count = liveCount;
                catalogItem.episodesCount = liveCount;
                apiCache.set(cachedCountKey, liveCount, 3600);
              }
            } catch (e) {}
          }
        }

        // Ensure episode count is at least the highest episode present in Drive manifest
        const rawSlug = catalogItem.id.replace(/^tioanime-/, "");
        const driveEntry = DRIVE_MANIFEST[catalogItem.id] || DRIVE_MANIFEST[`tioanime-${rawSlug}`] || DRIVE_MANIFEST[rawSlug];
        if (driveEntry && driveEntry.episodes) {
          let driveMaxEp = 0;
          for (const epKey of Object.keys(driveEntry.episodes)) {
            const num = parseInt(epKey.replace(/^ep-/, ""), 10);
            if (!isNaN(num) && num > driveMaxEp) driveMaxEp = num;
          }
          if (driveMaxEp > count) {
            count = driveMaxEp;
            catalogItem.episodesCount = count;
          }
        }
        
        const episodes = Array.from({ length: count }, (_, i) => ({
          id: `${catalogItem.id}-ep-${i + 1}`,
          title: isMovie ? catalogItem.title : isOVA ? `${catalogItem.title} - OVA ${i + 1}` : `${catalogItem.title} - Episodio ${i + 1}`,
          number: i + 1,
          animeId: catalogItem.id,
          animeTitle: catalogItem.title,
          coverUrl: catalogItem.coverUrl,
          videoUrl: `/api/episode/${catalogItem.id}-ep-${i + 1}`
        }));

        const fullAnime = { ...catalogItem, episodesCount: count, episodes };
        apiCache.set(cacheKey, fullAnime, 300);
        return res.json(fullAnime);
      }

      // Check custom DB second
      GLOBAL_CUSTOM_ANIMES = readCustomDb();
      const custom = GLOBAL_CUSTOM_ANIMES.find(a => a.id === id);
      if (custom) {
        const episodes = [];
        for (let i = 1; i <= custom.episodesCount; i++) {
          episodes.push({
            id: `${custom.id}-ep-${i}`,
            title: `${custom.title} - Episodio ${i}`,
            number: i,
            animeId: custom.id,
            animeTitle: custom.title,
            coverUrl: custom.coverUrl,
            videoUrl: `/api/episode/${custom.id}-ep-${i}`,
            videoServers: []
          });
        }
        const fullAnime = { ...custom, episodes };
        apiCache.set(cacheKey, fullAnime, 7200);
        return res.json(fullAnime);
      }

      const data = await scrapeAnime(id);
      apiCache.set(cacheKey, data, 7200); // 2 hours
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch anime details" });
    }
  });

  // 4. Get episode video stream servers
  app.get("/api/episode/:id", async (req, res) => {
    const { id } = req.params;
    const cacheKey = `episode_${id}`;
    
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    try {
      // 1. Check if this episode exists in Google Drive manifest with STRICT matching
      // Using module-level DRIVE_MANIFEST (loaded once at startup, not per-request)
      const manifest = DRIVE_MANIFEST;

      let rawSlug = "";
      let epNum = 1;
      const tioMatch = id.match(/^(?:tioanime-)?(.+?)-(?:ep|episodio)-(\d+)$/i);
      if (tioMatch) {
        rawSlug = tioMatch[1];
        epNum = parseInt(tioMatch[2], 10);
      } else {
        const parts = id.split("-ep-");
        if (parts.length === 2) {
          rawSlug = parts[0];
          epNum = parseInt(parts[1], 10);
        }
      }

      // Match anime in catalog
      const catalogItem = (rawSlug === "one-piece" || rawSlug === "one-piece-tv" || rawSlug === "one-piece-temporada-2")
        ? (LOCAL_CATALOG.find(a => a.id === "one-piece" || a.id === "tioanime-one-piece-tv") || LOCAL_CATALOG.find(a => a.title === "One Piece"))
        : (LOCAL_CATALOG.find(a => 
            a.id === id ||
            a.id === rawSlug ||
            a.id === `tioanime-${rawSlug}` || 
            a.id === `tioanime-${rawSlug}-tv` || 
            (a.external_id && a.external_id === rawSlug)
          ) || LOCAL_CATALOG.find(a => a.id.toLowerCase() === `tioanime-${rawSlug.toLowerCase()}`));

      const normRawSlug = rawSlug.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normAnimeTitle = (catalogItem?.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const normCatalogId = (catalogItem?.id || "").toLowerCase().replace(/[^a-z0-9]/g, "");

      let driveEp: any = null;

      // 1. Direct exact key match only
      const directKeys = [
        rawSlug,
        `tioanime-${rawSlug}`,
        `tioanime-${rawSlug}-tv`,
        catalogItem?.id,
        catalogItem?.external_id
      ].filter(Boolean) as string[];

      for (const k of directKeys) {
        if (manifest[k]?.episodes?.[`ep-${epNum}`]) {
          driveEp = manifest[k].episodes[`ep-${epNum}`];
          break;
        }
      }

      // 2. Strict full normalized equality match only (NO partial substring .includes)
      if (!driveEp) {
        for (const mKey of Object.keys(manifest)) {
          const normKey = mKey.toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]/g, "");
          const normEntryTitle = (manifest[mKey]?.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
          
          const isExactKey = (normKey && normRawSlug && normKey === normRawSlug) || (normCatalogId && normKey === normCatalogId);
          const isExactTitle = normAnimeTitle && normEntryTitle && normAnimeTitle.length >= 4 && normAnimeTitle === normEntryTitle;

          if (isExactKey || isExactTitle) {
            if (manifest[mKey]?.episodes?.[`ep-${epNum}`]) {
              driveEp = manifest[mKey].episodes[`ep-${epNum}`];
              break;
            }
          }
        }
      }

      // 2. Fetch original authentic servers from scrapers (TioAnime, MonosChinos, AnimeFLV, AnimeID)
      let combinedServers: Array<{ name: string; url: string }> = [];

      if (rawSlug) {
        const scrapeSlug = rawSlug.includes("one-piece") && !rawSlug.includes("movie") && !rawSlug.includes("pelicula") ? "one-piece-tv" : rawSlug;
        try {
          const tioServers = await scrapeEpisodeFromTioAnime(scrapeSlug, epNum);
          if (tioServers && tioServers.length > 0) {
            combinedServers.push(...tioServers);
          }
        } catch (e) {
          console.warn("TioAnime scrape notice:", e);
        }
      }

      // If needed, run additional scrapers
      if (combinedServers.length === 0) {
        try {
          const freshData = await scrapeEpisode(id);
          if (freshData && freshData.videoServers && freshData.videoServers.length > 0) {
            combinedServers.push(...freshData.videoServers);
          }
        } catch (e) {
          console.warn("Aggregator scrape notice:", e);
        }
      }

      // Check if this episode exists in Cloudflare R2 (Tier-1 Ultra HD, $0 egress, native custom player)
      const currentR2Manifest = loadR2Manifest();
      let r2Ep: any = null;
      for (const k of directKeys) {
        if (currentR2Manifest[k]?.episodes?.[`ep-${epNum}`]) {
          r2Ep = currentR2Manifest[k].episodes[`ep-${epNum}`];
          break;
        }
      }
      if (!r2Ep) {
        for (const mKey of Object.keys(currentR2Manifest)) {
          const normKey = mKey.toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]/g, "");
          const isExactKey = (normKey && normRawSlug && normKey === normRawSlug) || (normCatalogId && normKey === normCatalogId);
          if (isExactKey && currentR2Manifest[mKey]?.episodes?.[`ep-${epNum}`]) {
            r2Ep = currentR2Manifest[mKey].episodes[`ep-${epNum}`];
            break;
          }
        }
      }

      // Bleach TYBW guard: NEVER allow classic Bleach episodes or invalid episode numbers into TYBW
      const isBleachTYBWCheck = normRawSlug.includes("sennen") || normRawSlug.includes("thousandyear");
      if (isBleachTYBWCheck) {
        if (epNum > 47 || driveEp?.filename?.toLowerCase().includes("bleach - episodio")) {
          driveEp = null;
        }
      }

      // If strict Drive episode exists and is a valid video (> 20MB), add it as backup Drive player
      const driveSize = parseFloat(driveEp?.sizeMB || "0");
      if (driveEp && (driveEp.fileId || driveEp.streamUrl) && (isNaN(driveSize) || driveSize >= 20)) {
        const fileId = driveEp.fileId || (driveEp.streamUrl ? driveEp.streamUrl.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] : null);
        if (fileId) {
          // Add Google Drive preview iframe as alternative server
          combinedServers.unshift({
            name: "⚡ Google Drive (HD)",
            url: `https://drive.google.com/file/d/${fileId}/preview`
          });
        }
      }

      // If R2 episode exists, unshift it to the VERY TOP (Priority #1)
      if (r2Ep && r2Ep.url) {
        combinedServers.unshift({
          name: r2Ep.name || "⚡ MegaAnime PRO (Ultra HD)",
          url: r2Ep.url
        });
      }

      // Custom DB fallback - note: no fallback video; real servers will be scraped per episode
      if (combinedServers.length === 0) {
        GLOBAL_CUSTOM_ANIMES = readCustomDb();
        for (const anime of GLOBAL_CUSTOM_ANIMES) {
          if (id.startsWith(anime.id + "-")) {
            // Don't inject fake video - real episode servers will be found via scrapers above
            // If we get here with 0 servers, TioAnime/MonosChinos didn't find this anime yet
            break;
          }
        }
      }

      // Anti-Mismatch Guard: Ensure no external server belongs to a different anime
      const currentAnimeKeywords = [
        rawSlug,
        catalogItem?.id,
        catalogItem?.title,
        catalogItem?.title_english,
        catalogItem?.title_romaji
      ].filter(Boolean).map(s => (s as string).toLowerCase().replace(/[^a-z0-9]/g, ""));

      const KNOWN_ANIME_DISTINCT_KEYS = [
        "clevatess", "onepiece", "naruto", "bleach", "boruto", "dragonball",
        "jujutsukaisen", "chainsawman", "sololeveling", "frieren",
        "mushokutensei", "shingekinokyojin", "attackontitan", "bokunohero", "myheroacademia",
        "blackclover", "fairytail", "kimetsunoyaiba", "demonslayer", "hunterxhunter",
        "deathnote", "dandadan", "overlord", "spyxfamily", "tokyoghoul", "rezero"
      ];

      const isBleachTYBW = normRawSlug.includes("sennen") || normRawSlug.includes("thousandyear");
      const isBleachTV = (normRawSlug === "bleach" || normRawSlug === "bleachtv") && !isBleachTYBW;

      const verifiedServers = combinedServers.filter(s => {
        const u = (s.url || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const n = (s.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

        // Bleach Season isolation: NEVER let 2004 Bleach servers into TYBW, or TYBW into 2004 Bleach
        if (isBleachTYBW) {
          if (u.includes("bleachtv") || (u.includes("bleach") && !u.includes("sennen") && !u.includes("thousand") && !u.includes("tybw") && !u.includes("google") && !u.includes("r2"))) {
            console.warn(`[Anti-Mismatch Filter] Dropped 2004 Bleach server from TYBW: ${s.name} (${s.url})`);
            return false;
          }
        }
        if (isBleachTV) {
          if (u.includes("sennen") || u.includes("thousandyear") || u.includes("tybw")) {
            console.warn(`[Anti-Mismatch Filter] Dropped TYBW server from 2004 Bleach: ${s.name} (${s.url})`);
            return false;
          }
        }

        for (const key of KNOWN_ANIME_DISTINCT_KEYS) {
          const isTargetAnime = currentAnimeKeywords.some(ak => ak.includes(key) || key.includes(ak));
          if (!isTargetAnime) {
            if (u.includes(key) || n.includes(key)) {
              console.warn(`[Anti-Mismatch Server Filter] Dropped server ${s.name} (${s.url}) - belongs to ${key}`);
              return false;
            }
          }
        }
        return true;
      });

      const epData = {
        id,
        title: catalogItem ? (catalogItem.type === "Película" ? catalogItem.title : `${catalogItem.title} - Episodio ${epNum}`) : `Episodio ${epNum}`,
        number: epNum,
        animeId: catalogItem ? catalogItem.id : (rawSlug.includes("one-piece") ? "tioanime-one-piece-tv" : `tioanime-${rawSlug}`),
        animeTitle: catalogItem ? catalogItem.title : (rawSlug.includes("one-piece") ? "One Piece" : rawSlug),
        coverUrl: catalogItem ? catalogItem.coverUrl : "",
        videoServers: verifiedServers,
        videoUrl: verifiedServers[0]?.url || ""
      };

      if (combinedServers.length > 0) {
        // Cache successful responses for 2 hours
        apiCache.set(cacheKey, epData, 7200);
      } else {
        // Cache empty responses for 2 minutes to absorb thundering-herd traffic
        // when scraper is temporarily unavailable (prevents N simultaneous scrape calls for same episode)
        apiCache.set(cacheKey, epData, 120);
      }
      return res.json(epData);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch episode players" });
    }
  });

  // 5. Get available categories / genres
  app.get("/api/genres", (req, res) => {
    res.json(GENRES_LIST);
  });

  // 5c. Get mangas (from MangaDex)
  app.get("/api/mangas", async (req, res) => {
    const pageParam = req.query.page;
    const page = typeof pageParam === 'string' ? parseInt(pageParam, 10) || 1 : 1;
    const genreParam = req.query.genre;
    const limit = 20;
    const offset = (page - 1) * limit;

    const MANGADEX_TAGS: Record<string, string> = {
      "Acción": "391b0423-db21-4890-85fb-b2f342738a03",
      "Aventura": "87cc8738-d6a4-4f0e-b7e1-88f58c707538",
      "Comedia": "4d32b851-d85c-436c-aba0-fa626998c38c",
      "Drama": "b9af3a06-3848-4251-98e3-da6530188041",
      "Fantasía": "cdc58593-37dd-4156-b010-96025064e4f5",
      "Romance": "423e273a-3b92-49a2-ae62-8418c633a268",
      "Ciencia Ficción": "256c895d-d6f1-414d-917a-5557ce0dadaf",
      "Shounen": "27c3e57a-48f5-4161-a8a8-a40b07202383",
      "Seinen": "3b60b75c-a2d7-4860-8f69-df924b068b32",
      "Recuentos de la vida": "e5301a23-ebd9-49dd-a0cb-2af9d60d370c",
      "Terror": "cd86a313-f642-4e88-8090-d1667351ded8",
      "Sobrenatural": "eabc5bde-9397-43f2-a301-a83b49051bd8",
      "Misterio": "ee968100-41d1-4ad6-83f3-752bd234651d",
      "Psicológico": "3b60b75c-a2d7-4860-8f69-df924b068b32",
      "Escolar": "caaa44aa-d692-4c30-a4f2-9590f69f4c6e",
      "Deportes": "6995039a-6c30-410a-86c3-98ce44e54881",
      "Mecha": "508d148a-ad40-426e-9533-5c305747cc2a",
      "Isekai": "ace04321-c630-455b-b459-d3027e9dd17f"
    };

    const cacheKey = `mangas_p${page}_g${genreParam || "none"}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      let url = `https://api.mangadex.org/manga?limit=${limit}&offset=${offset}&includes[]=cover_art&order[rating]=desc&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
      
      if (typeof genreParam === 'string' && MANGADEX_TAGS[genreParam]) {
        url += `&includedTags[]=${MANGADEX_TAGS[genreParam]}`;
      }

      const response = await fetch(url, {
        headers: {
          "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        return res.json({ mangas: [], totalPages: 1 });
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.data)) throw new Error("Invalid data format");

      const mangaIds = data.data.map((m: any) => m.id);
      let statistics: Record<string, any> = {};

      if (mangaIds.length > 0) {
        try {
          const statsUrl = `https://api.mangadex.org/statistics/manga?${mangaIds.map(id => `manga[]=${id}`).join('&')}`;
          const statsRes = await fetch(statsUrl, {
            headers: {
              "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
              "Accept": "application/json"
            }
          });
          if (statsRes.ok) {
            const statsData = await statsRes.json();
            statistics = statsData.statistics || {};
          }
        } catch (e) {}
      }
      
      const mangas: Manga[] = data.data.map((m: any) => {
        // Find cover_art relationship and attributes
        const coverArt = m.relationships.find((rel: any) => rel.type === "cover_art");
        let fileName = coverArt?.attributes?.fileName;
        
        // If attributes are missing (e.g. not expanded correctly in response)
        // sometimes we have to look in the top-level 'included' array
        if (!fileName && data.included) {
          const includedCover = data.included.find((inc: any) => inc.type === "cover_art" && inc.id === coverArt?.id);
          fileName = includedCover?.attributes?.fileName;
        }

        const coverUrl = fileName 
          ? `https://uploads.mangadex.org/covers/${m.id}/${fileName}.256.jpg` 
          : "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=400"; // Fallback
        const title = m.attributes.title.es || m.attributes.title["es-la"] || m.attributes.title.en || (m.attributes.title && Object.values(m.attributes.title)[0]);
        const lastChapterStr = m.attributes.lastChapter;
        const lastChapter = lastChapterStr ? parseFloat(lastChapterStr) : 0;
        const rating = statistics[m.id]?.rating?.average || 0;
        
        return {
          id: m.id,
          title: title || "Sin título",
          synopsis: m.attributes.description?.es || m.attributes.description?.en || "Sinopsis no disponible.",
          coverUrl: coverUrl,
          genres: m.attributes.tags.filter((t: any) => t.type === "tag").map((t: any) => t.attributes.name.en),
          status: m.attributes.status === "ongoing" ? "En emisión" : "Finalizado",
          year: m.attributes.year || 0,
          chaptersCount: isNaN(lastChapter) || lastChapter === 0 ? 0 : Math.floor(lastChapter),
          rating: Math.round(rating * 10) / 10
        };
      });

      // Sort: "En emisión" first, then "Finalizado"
      mangas.sort((a, b) => {
        if (a.status === "En emisión" && b.status !== "En emisión") return -1;
        if (a.status !== "En emisión" && b.status === "En emisión") return 1;
        return 0;
      });
      
      const result = { mangas, totalPages: Math.ceil(data.total / limit) };
      apiCache.set(cacheKey, result, 3600); // 1 hour
      res.json(result);
    } catch (error) {
      res.json({ mangas: [], totalPages: 1 });
    }
  });

  // 5d. Get manga chapters
  app.get("/api/manga/:id/chapters", async (req, res) => {
    const { id } = req.params;
    
    // Validate UUID format roughly or at least check for "undefined"/"null"
    if (!id || id === 'undefined' || id === 'null' || id.length < 10) {
      console.warn("Invalid Manga ID requested:", id);
      return res.json([]);
    }

    const cacheKey = `manga_chapters_${id}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      const url = `https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=es&translatedLanguage[]=es-la&translatedLanguage[]=en&order[chapter]=asc&limit=500&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica&contentRating[]=pornographic`;
      
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        return res.json([]);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        return res.json([]);
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.data)) return res.json([]);
      
      // Filter out chapters that are just placeholders or external
      const chapters = data.data
        .filter((c: any) => c.attributes.pages > 0 || c.attributes.externalUrl)
        .map((c: any) => ({
          id: c.id,
          title: `Capítulo ${c.attributes.chapter || '?'} ${c.attributes.title ? `- ${c.attributes.title}` : ''}`,
          chapter: c.attributes.chapter
        }));

      // Sort chapters numerically by chapter number
      chapters.sort((a: any, b: any) => {
        const valA = parseFloat(a.chapter) || 0;
        const valB = parseFloat(b.chapter) || 0;
        return valA - valB;
      });
      
      apiCache.set(cacheKey, chapters, 3600); // 1 hour
      res.json(chapters);
    } catch (error) {
      res.json([]);
    }
  });

  // 5d-2. Get single manga details from MangaDex
  app.get("/api/manga-detail/:id", async (req, res) => {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null' || id.length < 10) {
      return res.status(400).json({ error: "Invalid Manga ID" });
    }

    const cacheKey = `manga_detail_${id}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      const url = `https://api.mangadex.org/manga/${id}?includes[]=cover_art`;
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
          "Accept": "application/json"
        }
      });
      if (!response.ok) {
        return res.status(404).json({ error: "Manga not found" });
      }

      const data = await response.json();
      const m = data.data;
      if (!m) {
        return res.status(404).json({ error: "Manga data empty" });
      }

      // Fetch stats
      let statistics: Record<string, any> = {};
      try {
        const statsRes = await fetch(`https://api.mangadex.org/statistics/manga/${id}`, {
          headers: {
            "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
            "Accept": "application/json"
          }
        });
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          statistics = statsData.statistics || {};
        }
      } catch (e) {}

      const coverArt = m.relationships?.find((rel: any) => rel.type === "cover_art");
      let fileName = coverArt?.attributes?.fileName;
      if (!fileName && data.included) {
        const includedCover = data.included.find((inc: any) => inc.type === "cover_art" && inc.id === coverArt?.id);
        fileName = includedCover?.attributes?.fileName;
      }
      if (!fileName && m.relationships) {
        const includedCover = m.relationships.find((inc: any) => inc.type === "cover_art");
        fileName = includedCover?.attributes?.fileName;
      }

      const coverUrl = fileName 
        ? `https://uploads.mangadex.org/covers/${m.id}/${fileName}.256.jpg` 
        : "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=400"; // Fallback

      const title = m.attributes?.title?.es || m.attributes?.title?.["es-la"] || m.attributes?.title?.en || (m.attributes?.title && Object.values(m.attributes?.title)[0]);
      const lastChapterStr = m.attributes?.lastChapter;
      const lastChapter = lastChapterStr ? parseFloat(lastChapterStr) : 0;
      const rating = statistics[m.id]?.rating?.average || 0;

      const manga: Manga = {
        id: m.id,
        title: title || "Sin título",
        synopsis: m.attributes?.description?.es || m.attributes?.description?.en || "Sinopsis no disponible.",
        coverUrl: coverUrl,
        genres: m.attributes?.tags?.filter((t: any) => t.type === "tag").map((t: any) => t.attributes?.name?.en) || [],
        status: m.attributes?.status === "ongoing" ? "En emisión" : "Finalizado",
        year: m.attributes?.year || 0,
        chaptersCount: isNaN(lastChapter) || lastChapter === 0 ? 0 : Math.floor(lastChapter),
        rating: Math.round(rating * 10) / 10
      };

      apiCache.set(cacheKey, manga, 7200); // cache for 2 hours
      res.json(manga);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to fetch manga detail" });
    }
  });

  // 5e. Get manga chapter pages
  app.get("/api/chapter/:id/pages", async (req, res) => {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null' || id.length < 10) {
      return res.status(400).json({ error: "Invalid Chapter ID" });
    }

    const cacheKey = `chapter_pages_${id}`;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) return res.json(cachedData);

    try {
      const response = await fetch(`https://api.mangadex.org/at-home/server/${id}`, {
        headers: {
          "User-Agent": "MegaAnime-App/1.2.0 (contact: BaezCabrera.J.R@gmail.com)",
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        return res.status(response.status).json({ error: "MangaDex API error" });
      }

      const data = await response.json();
      if (!data || !data.chapter) throw new Error("Invalid response");
      
      const baseUrl = data.baseUrl;
      const hash = data.chapter.hash;
      const pages = data.chapter.data.map((fileName: string) => `${baseUrl}/data/${hash}/${fileName}`);
      
      apiCache.set(cacheKey, pages, 86400); // 24 hours
      res.json(pages);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch chapter pages" });
    }
  });

  // 5b. Get movies — local catalog only
  app.get("/api/movies", async (req, res) => {
    const genre = (req.query.genre as string || "").toLowerCase();
    const page = parseInt(req.query.page as string, 10) || 1;
    const cacheKey = `movies_local_${genre || 'all'}_p${page}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    let movies = LOCAL_CATALOG.filter(a => a.type === "Película" && a.active !== false);
    if (genre) {
      movies = movies.filter(a =>
        (a.genres || []).some((g: string) => g.toLowerCase().includes(genre))
      );
    }
    movies = [...movies].sort((a, b) => (b.rating || 0) - (a.rating || 0));

    apiCache.set(cacheKey, movies, 3600);
    res.json(movies);
  });

  // 6. User Authentication: Login
  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Todos los campos son obligatorios" });
    }

    // Standard demonstration validation (simulates registration if not found)
    const emailKey = email.toLowerCase().trim();
    if (!USERS_DB[emailKey]) {
      // Auto-register on the fly for premium feel, or require sign up
      USERS_DB[emailKey] = {
        username: email.split("@")[0],
        email: emailKey,
        favorites: []
      };
    }

    res.json({
      success: true,
      message: "Sesión iniciada con éxito",
      user: {
        id: emailKey,
        username: USERS_DB[emailKey].username,
        email: USERS_DB[emailKey].email,
        favorites: USERS_DB[emailKey].favorites
      }
    });
  });

  // 7. User Authentication: Register
  app.post("/api/auth/register", (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, message: "Todos los campos son obligatorios" });
    }

    const emailKey = email.toLowerCase().trim();
    if (USERS_DB[emailKey]) {
      return res.status(400).json({ success: false, message: "Este correo electrónico ya está registrado" });
    }

    USERS_DB[emailKey] = {
      username: username.trim(),
      email: emailKey,
      favorites: []
    };

    res.json({
      success: true,
      message: "Registro completado con éxito",
      user: {
        id: emailKey,
        username: USERS_DB[emailKey].username,
        email: USERS_DB[emailKey].email,
        favorites: USERS_DB[emailKey].favorites
      }
    });
  });

  // 8. Sync favorites (Save user favorites back to server session if logged in)
  app.post("/api/favorites/sync", (req, res) => {
    const { email, favorites } = req.body;
    if (!email || !Array.isArray(favorites)) {
      return res.status(400).json({ success: false, message: "Falta el correo o los favoritos" });
    }
    const emailKey = email.toLowerCase().trim();
    if (USERS_DB[emailKey]) {
      USERS_DB[emailKey].favorites = favorites;
    } else {
      USERS_DB[emailKey] = {
        username: email.split("@")[0],
        email: emailKey,
        favorites: favorites
      };
    }
    res.json({ success: true, favorites: USERS_DB[emailKey].favorites });
  });

  // 9. Server-side image proxy to bypass hotlinking blocks and CORS restrictions
  app.get("/api/image-proxy", async (req, res) => {
    let imageUrl = (req.query.url as string || "").trim();
    const title = (req.query.title as string || "Anime").trim();
    const encodeParam = req.query.encode as string;

    // Step 1: Decode the URL
    if (encodeParam === "base64" && imageUrl) {
      try {
        const decoded = Buffer.from(imageUrl, "base64").toString("utf-8");
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
          imageUrl = decoded;
        }
      } catch (err) {
        try { imageUrl = decodeURIComponent(imageUrl); } catch(e) {}
      }
    } else if (imageUrl && !imageUrl.startsWith("http") && !imageUrl.startsWith("data:")) {
      try { imageUrl = decodeURIComponent(imageUrl); } catch(e) {}
    }
    // Step 2: If URL is missing/invalid → try AniList then serve SVG
    const isBannerQuery = req.query.isBanner === "1" || imageUrl.includes("banner") || imageUrl.includes("cover-large") || imageUrl.includes("bannerUrl") || imageUrl.includes("banner_url");

    if (!imageUrl || imageUrl === "trigger-error" || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
      if (title && title.toLowerCase() !== "anime" && title.toLowerCase() !== "manga" && title.toLowerCase() !== "undefined" && title.length > 2) {
        try {
          const gqlResponse = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({
              query: `query ($search: String) { Page(page:1,perPage:1) { media(search:$search) { bannerImage coverImage { extraLarge large } } } }`,
              variables: { search: title }
            }),
            signal: AbortSignal.timeout(4000)
          });
          if (gqlResponse.ok) {
            const json: any = await gqlResponse.json();
            const media = json.data?.Page?.media?.[0];
            const coverUrl = isBannerQuery 
              ? (media?.bannerImage || media?.coverImage?.extraLarge || media?.coverImage?.large)
              : (media?.coverImage?.extraLarge || media?.coverImage?.large || media?.bannerImage);
            if (coverUrl) {
              imageUrl = coverUrl;
              console.log(`[image-proxy] AniList resolved missing image for "${title}" (isBanner=${isBannerQuery}): ${coverUrl}`);
            }
          }
        } catch (err: any) {
          console.warn(`[image-proxy] AniList resolve failed for "${title}":`, err.message);
        }
      }
    }

    // Step 3: Still no valid URL → serve SVG placeholder
    if (!imageUrl || imageUrl === "trigger-error" || (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://"))) {
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(getSvgPlaceholder(title, isBannerQuery));
    }

    try {

      const parsedUrl = new URL(imageUrl);
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8"
      };

      if (parsedUrl.hostname.includes("myanimelist.net")) {
        headers["Referer"] = "https://myanimelist.net/";
      } else if (parsedUrl.hostname.includes("alphacoders.com")) {
        headers["Referer"] = "https://alphacoders.com/";
      } else if (parsedUrl.hostname.includes("monoschinos.st")) {
        headers["Referer"] = "https://monoschinos.st/";
      } else if (parsedUrl.hostname.includes("mangadex.org")) {
        // MangaDex is very picky about headers - MUST NOT send User-Agent
        headers["Referer"] = "https://mangadex.org/";
        delete headers["User-Agent"];
        headers["Accept"] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
        headers["Accept-Language"] = "en-US,en;q=0.9,es;q=0.8";
      } else {
        headers["Referer"] = `${parsedUrl.protocol}//${parsedUrl.host}/`;
      }

      // Helper for serving image from wsrv.nl on the server without redirects
      const serveViaWeserv = async (url: string) => {
        try {
          const weservUrl = `https://wsrv.nl/?url=${encodeURIComponent(url)}`;
          const weservResponse = await fetch(weservUrl, {
            signal: AbortSignal.timeout(8000)
          });
          if (weservResponse.ok) {
            res.setHeader("Content-Type", weservResponse.headers.get("content-type") || "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=604800");
            const buffer = await weservResponse.arrayBuffer();
            res.send(Buffer.from(buffer));
            return true;
          }
        } catch (e: any) {
          console.error(`wsrv.nl server-side proxy failed for: ${url}`, e.message);
        }
        return false;
      };

      if (parsedUrl.hostname.includes("mangadex.org")) {
        // MangaDex is extremely picky. We try multiple strategies.
        // Strategy 1: Direct fetch with specific headers
        try {
          const directRes = await fetch(imageUrl, {
            headers: {
              "Referer": "https://mangadex.org/",
              "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            },
            signal: AbortSignal.timeout(5000)
          });
          if (directRes.ok) {
            res.setHeader("Content-Type", directRes.headers.get("content-type") || "image/jpeg");
            res.setHeader("Cache-Control", "public, max-age=604800");
            const buffer = await directRes.arrayBuffer();
            return res.send(Buffer.from(buffer));
          }
        } catch (e) {}

        // Strategy 2: Use wsrv.nl (Weserv) on the server
        const success = await serveViaWeserv(imageUrl);
        if (success) return;

        // Strategy 3: Try original image if this was a thumbnail
        if (imageUrl.includes(".256.jpg") || imageUrl.includes(".512.jpg")) {
          const originalUrl = imageUrl.replace(/\.(256|512)\.jpg$/, "");
          const successOrig = await serveViaWeserv(originalUrl);
          if (successOrig) return;
        }
      }

      let response = await fetch(imageUrl, {
        headers,
        signal: AbortSignal.timeout(6000)
      });

      // If direct fetch fails, try server-side wsrv.nl fallback
      if (!response.ok) {
        if (response.status !== 404) {
          console.warn(`Direct proxy fetch failed with status ${response.status} for URL: ${imageUrl}. Trying server-side wsrv.nl fallback...`);
        }
        const success = await serveViaWeserv(imageUrl);
        if (success) return;
        
        throw new Error(`Failed to fetch image directly: ${response.status}`);
      }

      const contentType = response.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
      
      const buffer = await response.arrayBuffer();
      res.send(Buffer.from(buffer));
    } catch (error: any) {
      if (!error.message.includes("404")) {
        console.warn("Local image proxy failed, falling back to server-side wsrv.nl proxy for URL:", imageUrl, error.message);
      }
      
      // Fallback to server-side fetch from wsrv.nl to avoid redirects
      try {
        const weservUrl = `https://wsrv.nl/?url=${encodeURIComponent(imageUrl)}`;
        const weservResponse = await fetch(weservUrl, {
          signal: AbortSignal.timeout(8000)
        });
        if (weservResponse.ok) {
          res.setHeader("Content-Type", weservResponse.headers.get("content-type") || "image/jpeg");
          res.setHeader("Cache-Control", "public, max-age=604800");
          const buffer = await weservResponse.arrayBuffer();
          return res.send(Buffer.from(buffer));
        }
      } catch (err: any) {
        if (!err.message.includes("404")) {
          console.error("wsrv.nl server-side proxy fallback failed:", err.message);
        }
      }
      
      // Try searching AniList GraphQL for a valid cover/banner using the title parameter
      const isBannerRecovery = req.query.isBanner === "1" || imageUrl.includes("banner") || imageUrl.includes("cover-large") || imageUrl.includes("bannerUrl") || imageUrl.includes("banner_url");
      if (title && title.toLowerCase() !== "anime" && title.toLowerCase() !== "manga" && title.toLowerCase() !== "undefined" && title.length > 2) {
        try {
          const variables = { search: title };
          const queryStr = `
            query ($search: String) {
              Page(page: 1, perPage: 1) {
                media(search: $search) {
                  bannerImage
                  coverImage {
                    large
                    extraLarge
                  }
                }
              }
            }
          `;
          const gqlResponse = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
            },
            body: JSON.stringify({ query: queryStr, variables }),
            signal: AbortSignal.timeout(5000)
          });
          if (gqlResponse.ok) {
            const json = await gqlResponse.json();
            const media = json.data?.Page?.media?.[0];
            const altCoverUrl = isBannerRecovery 
              ? (media?.bannerImage || media?.coverImage?.extraLarge || media?.coverImage?.large)
              : (media?.coverImage?.extraLarge || media?.coverImage?.large || media?.bannerImage);
            
            if (altCoverUrl && altCoverUrl !== imageUrl) {
              console.log(`Image proxy fallback: Found alternative image on AniList for "${title}": ${altCoverUrl}`);
              const altResponse = await fetch(altCoverUrl, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                  "Accept": "image/*"
                },
                signal: AbortSignal.timeout(6000)
              });
              if (altResponse.ok) {
                res.setHeader("Content-Type", altResponse.headers.get("content-type") || "image/jpeg");
                res.setHeader("Cache-Control", "public, max-age=604800");
                const buffer = await altResponse.arrayBuffer();
                return res.send(Buffer.from(buffer));
              }
            }
          }
        } catch (e: any) {
          console.warn(`Image proxy fallback: AniList recovery failed for "${title}":`, e.message);
        }
      }

      // Serve beautiful dynamic server-side fallback SVG
      const fallbackSvg = getSvgPlaceholder(title, isBannerRecovery);
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.status(200).send(fallbackSvg);
    }
  });

  // 10. CORS-free progressive video download proxy to bypass browser restrictions
  app.get("/api/download-proxy", async (req, res) => {
    const videoUrl = req.query.url as string;
    if (!videoUrl) {
      return res.status(400).send("No video URL provided");
    }

    try {
      console.log(`Streaming proxy download request for URL: ${videoUrl}`);
      const videoRes = await fetch(videoUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(600000) // 10 minutes maximum download time
      });

      if (!videoRes.ok) {
        throw new Error(`Failed to fetch remote stream: ${videoRes.status}`);
      }

      // Propagate content-type, content-length and CORS headers
      res.setHeader("Content-Type", videoRes.headers.get("content-type") || "video/mp4");
      const contentLength = videoRes.headers.get("content-length");
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-cache");

      // Stream the response in chunks directly to the client
      if (videoRes.body) {
        const reader = videoRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            res.write(Buffer.from(value));
          }
        }
      }
      res.end();
    } catch (err: any) {
      console.error(`Download proxy streaming failed for ${videoUrl}:`, err.message);
      res.status(500).send(`Download failed: ${err.message}`);
    }
  });

  // 11. Dynamic Hot Cover Recovery Route using AniList GraphQL API
  app.get("/api/resolve-cover", async (req, res) => {
    const title = req.query.title as string;
    const animeId = req.query.animeId as string;
    const requestedType = req.query.type as string; // "ANIME" | "MANGA"

    if (!title && !animeId) {
      return res.status(400).json({ error: "Missing title or animeId parameter" });
    }

    try {
      console.log(`Hot cover recovery requested for title: "${title}", ID: "${animeId}", Type: "${requestedType}"`);

      let cleanId = "";
      if (animeId) {
        let stripped = animeId.replace(/^(consumet-ep-|hianime-ep-|consumet-|hianime-|anilist-)/i, "");
        stripped = stripped.replace(/-ep-\d+$/i, "").replace(/-episodio-\d+$/i, "").replace(/-capitulo-\d+$/i, "");
        if (!/^\d+$/.test(stripped) && /-[0-9]+$/.test(stripped)) {
          stripped = stripped.replace(/-[0-9]+$/, "");
        }
        cleanId = stripped;
      }
      const isNumericId = /^\d+$/.test(cleanId);
      
      // Determine if media is Anime or Manga
      let mediaType = "ANIME";
      if (requestedType?.toUpperCase() === "MANGA" || animeId?.startsWith("manga-")) {
        mediaType = "MANGA";
      }

      // 1. Instant local catalog resolution
      if (mediaType === "MANGA") {
        const { MOCK_MANGAS } = await import("./src/utils/mangaDb");
        const target = MOCK_MANGAS.find(m => m.id === animeId);
        if (target && target.coverUrl) {
          console.log(`Resolved hot cover from local mangaDb: ${target.coverUrl}`);
          return res.json({ coverUrl: target.coverUrl, title: target.title });
        }
      } else {
        const { MOCK_ANIMES } = await import("./src/utils/animeDb");
        const target = MOCK_ANIMES.find(a => a.id === animeId || (a.external_id && a.external_id === cleanId));
        if (target && target.coverUrl) {
          console.log(`Resolved hot cover from local animeDb: ${target.coverUrl}`);
          return res.json({ coverUrl: target.coverUrl, title: target.title });
        }
      }

      let coverUrl: string | null = null;
      let resolvedTitle: string | null = null;

      if (isNumericId) {
        // Tier 1: Query AniZip API (100% reliable for AniList IDs, 0 Cloudflare blocks)
        try {
          const aniZipRes = await fetch(`https://api.ani.zip/mappings?anilist_id=${cleanId}`, { signal: AbortSignal.timeout(4000) });
          if (aniZipRes.ok) {
            const aniZipData = await aniZipRes.json();
            const title = aniZipData.titles?.en || aniZipData.titles?.ro || aniZipData.titles?.ja;
            const images = aniZipData.images || [];
            const coverObj = images.find((img: any) => img.coverType === "Poster" || img.coverType === "Fanart") || images[0];
            const cover = coverObj?.url;
            if (title) resolvedTitle = title;
            if (cover) coverUrl = cover;
          }
        } catch (e) {
          console.warn("AniZip lookup failed:", e);
        }

        // Tier 2: Query AniList GraphQL directly if AniZip missing
        if (!coverUrl || !resolvedTitle) {
          const anilistId = parseInt(cleanId, 10);
          const queryStr = `
            query ($id: Int, $type: MediaType) {
              Media(id: $id, type: $type) {
                title { english romaji native }
                coverImage { extraLarge large }
              }
            }
          `;
          try {
            const gqlResponse = await fetch("https://graphql.anilist.co", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ query: queryStr, variables: { id: anilistId, type: mediaType } }),
              signal: AbortSignal.timeout(4000)
            });
            if (gqlResponse.ok) {
              const json: any = await gqlResponse.json();
              const media = json.data?.Media;
              if (!coverUrl) coverUrl = media?.coverImage?.extraLarge || media?.coverImage?.large || null;
              if (!resolvedTitle) resolvedTitle = media?.title?.english || media?.title?.romaji || media?.title?.native || null;
            }
          } catch (e) {}
        }
      } else if (title && title.toLowerCase() !== "anime" && title.toLowerCase() !== "manga" && title.toLowerCase() !== "undefined") {
        // Query AniList GraphQL using title search
        const queryStr = `
          query ($search: String, $type: MediaType) {
            Page(page: 1, perPage: 1) {
              media(search: $search, type: $type) {
                title { english romaji native }
                coverImage { extraLarge large }
              }
            }
          }
        `;
        try {
          const gqlResponse = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify({ query: queryStr, variables: { search: title, type: mediaType } }),
            signal: AbortSignal.timeout(4000)
          });
          if (gqlResponse.ok) {
            const json: any = await gqlResponse.json();
            const media = json.data?.Page?.media?.[0];
            coverUrl = media?.coverImage?.extraLarge || media?.coverImage?.large || null;
            resolvedTitle = media?.title?.english || media?.title?.romaji || media?.title?.native || null;
          }
        } catch (e) {}
      }

      if (coverUrl) {
        console.log(`Successfully recovered hot cover for ${mediaType} "${title || animeId}": ${coverUrl}`);
        
        // Dynamic memory-cache update to prevent subsequent errors in runtime
        try {
          if (mediaType === "MANGA") {
            const { MOCK_MANGAS } = await import("./src/utils/mangaDb");
            const target = MOCK_MANGAS.find(m => m.id === animeId);
            if (target) {
              target.coverUrl = coverUrl;
              if (resolvedTitle) target.title = resolvedTitle;
              console.log(`Updated coverUrl in runtime MOCK_MANGAS cache for ID: ${animeId}`);
            }
          } else {
            const { MOCK_ANIMES } = await import("./src/utils/animeDb");
            const target = MOCK_ANIMES.find(a => a.id === animeId);
            if (target) {
              target.coverUrl = coverUrl;
              if (resolvedTitle) target.title = resolvedTitle;
              console.log(`Updated coverUrl in runtime MOCK_ANIMES cache for ID: ${animeId}`);
            }
          }
        } catch (e) {}

        return res.json({ coverUrl, title: resolvedTitle });
      }

      return res.status(404).json({ error: "No cover image resolved on AniList" });
    } catch (err: any) {
      console.error(`Cover recovery failed for "${title || animeId}":`, err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // --- ADMIN ACTIONS ENDPOINTS ---

  // 1. Get all custom animes
  app.get("/api/admin/animes", (req, res) => {
    GLOBAL_CUSTOM_ANIMES = readCustomDb();
    res.json(GLOBAL_CUSTOM_ANIMES);
  });

  // 1b. Get all custom mangas
  app.get("/api/admin/mangas", (req, res) => {
    GLOBAL_CUSTOM_MANGAS = readCustomMangasDb();
    res.json(GLOBAL_CUSTOM_MANGAS);
  });

  // 1c. Get R2 Cloudflare Manifest
  app.get("/api/admin/r2-episodes", (req, res) => {
    res.json(loadR2Manifest());
  });

  // --- ADMIN ROLES MANAGEMENT ---
  app.get("/api/admin/roles", (req, res) => {
    try {
      const roles = readAdminRoles();
      res.json(roles);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/roles/add", (req, res) => {
    try {
      const { email, name, role, addedBy } = req.body;
      if (!email || typeof email !== "string" || !email.includes("@")) {
        return res.status(400).json({ error: "Ingresa un correo electrónico válido" });
      }
      const cleanEmail = email.trim().toLowerCase();
      let roles = readAdminRoles();
      const existingIdx = roles.findIndex((r: any) => r.email.trim().toLowerCase() === cleanEmail);

      if (existingIdx !== -1) {
        roles[existingIdx].name = name || roles[existingIdx].name;
        roles[existingIdx].role = role || roles[existingIdx].role || "admin";
      } else {
        roles.push({
          email: cleanEmail,
          name: name ? name.trim() : cleanEmail.split("@")[0],
          role: role || "admin",
          addedAt: new Date().toISOString(),
          addedBy: addedBy || "baezcabrera.j.r@gmail.com"
        });
      }

      writeAdminRoles(roles);
      console.log(`[Admin Roles] ✅ Added/Updated admin: ${cleanEmail} (${role || 'admin'})`);
      res.json({ success: true, roles, message: `Usuario ${cleanEmail} registrado como administrador.` });
    } catch (e: any) {
      console.error("Error adding admin role:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/admin/roles/remove", (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Correo requerido" });
      }
      const cleanEmail = email.trim().toLowerCase();
      if (cleanEmail === "baezcabrera.j.r@gmail.com") {
        return res.status(403).json({ error: "Acción denegada: No es posible revocar permisos al Super Administrador principal." });
      }

      let roles = readAdminRoles();
      const beforeCount = roles.length;
      roles = roles.filter((r: any) => r.email.trim().toLowerCase() !== cleanEmail);

      if (roles.length === beforeCount) {
        return res.status(404).json({ error: "El correo no se encuentra en la lista de administradores." });
      }

      writeAdminRoles(roles);
      console.log(`[Admin Roles] ⚠️ Removed admin: ${cleanEmail}`);
      res.json({ success: true, roles, message: `Permisos revocados para ${cleanEmail}.` });
    } catch (e: any) {
      console.error("Error removing admin role:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // --- CONTENT VISIBILITY TOGGLE (ACTIVE / INACTIVE) ---
  app.post("/api/admin/content/toggle-active", (req, res) => {
    try {
      const { id, type, active } = req.body;
      if (!id) {
        return res.status(400).json({ error: "ID de contenido requerido" });
      }

      const isManga = type === "manga" || type === "Manga";
      if (isManga) {
        GLOBAL_CUSTOM_MANGAS = readCustomMangasDb();
        const mIdx = GLOBAL_CUSTOM_MANGAS.findIndex(m => m.id === id);
        let currentActive = true;
        if (mIdx !== -1) {
          currentActive = active !== undefined ? Boolean(active) : !(GLOBAL_CUSTOM_MANGAS[mIdx].active !== false);
          GLOBAL_CUSTOM_MANGAS[mIdx].active = currentActive;
        } else {
          currentActive = active !== undefined ? Boolean(active) : false;
          GLOBAL_CUSTOM_MANGAS.push({ id, active: currentActive });
        }
        writeCustomMangasDb(GLOBAL_CUSTOM_MANGAS);
        apiCache.flushAll();
        return res.json({ success: true, id, active: currentActive });
      }

      // Anime / Película
      const idx = LOCAL_CATALOG.findIndex(a => a.id === id);
      let newActiveState = true;
      if (idx !== -1) {
        newActiveState = active !== undefined ? Boolean(active) : !(LOCAL_CATALOG[idx].active !== false);
        LOCAL_CATALOG[idx].active = newActiveState;
      } else {
        newActiveState = active !== undefined ? Boolean(active) : false;
      }

      // Persist to catalog.json
      persistCatalog(LOCAL_CATALOG);

      // Also sync custom DB
      GLOBAL_CUSTOM_ANIMES = readCustomDb();
      const cIdx = GLOBAL_CUSTOM_ANIMES.findIndex(a => a.id === id);
      if (cIdx !== -1) {
        GLOBAL_CUSTOM_ANIMES[cIdx].active = newActiveState;
      } else if (idx !== -1) {
        GLOBAL_CUSTOM_ANIMES.push({ ...LOCAL_CATALOG[idx], active: newActiveState });
      }
      writeCustomDb(GLOBAL_CUSTOM_ANIMES);

      apiCache.flushAll();
      console.log(`[Content Toggle] Toggled "${id}" active state to ${newActiveState}`);
      res.json({ success: true, id, active: newActiveState });
    } catch (e: any) {
      console.error("Error toggling content active state:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 2. Save/Update catalog anime or movie (with disk persistence to catalog.json)
  app.post("/api/admin/animes/save", (req, res) => {
    try {
      const anime = req.body;
      if (!anime || !anime.title || anime.title.trim() === "") {
        return res.status(400).json({ error: "El título es obligatorio" });
      }

      // Generate or clean ID slug if missing
      if (!anime.id || anime.id.trim() === "") {
        const rawSlug = (anime.title_romaji || anime.title_english || anime.title)
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        anime.id = `tioanime-${rawSlug || Date.now()}`;
      }

      // Set defaults
      anime.type = anime.type || "Anime";
      if (anime.type === "Película") {
        anime.episodesCount = 1;
      } else {
        anime.episodesCount = parseInt(anime.episodesCount, 10) || 12;
      }
      anime.rating = parseFloat(anime.rating) || 8.0;
      anime.year = parseInt(anime.year, 10) || new Date().getFullYear();
      anime.genres = Array.isArray(anime.genres) ? anime.genres : (anime.genres ? [anime.genres] : ["Acción"]);
      anime.episodes = anime.episodes || [];
      anime.active = anime.active !== undefined ? Boolean(anime.active) : true;

      // 1. Update in-memory LOCAL_CATALOG preserving all extended metadata
      const index = LOCAL_CATALOG.findIndex(a => a.id === anime.id);
      if (index !== -1) {
        LOCAL_CATALOG[index] = { ...LOCAL_CATALOG[index], ...anime };
      } else {
        LOCAL_CATALOG.unshift(anime);
      }

      // 2. Persist directly to catalog.json & dist/catalog.json
      persistCatalog(LOCAL_CATALOG);

      // 3. Keep custom DB in sync as well
      GLOBAL_CUSTOM_ANIMES = readCustomDb();
      const customIndex = GLOBAL_CUSTOM_ANIMES.findIndex(a => a.id === anime.id);
      if (customIndex !== -1) {
        GLOBAL_CUSTOM_ANIMES[customIndex] = { ...GLOBAL_CUSTOM_ANIMES[customIndex], ...anime };
      } else {
        GLOBAL_CUSTOM_ANIMES.unshift(anime);
      }
      writeCustomDb(GLOBAL_CUSTOM_ANIMES);

      apiCache.flushAll(); // Flush cache so home, movies, and search show changes instantly
      res.json({ success: true, anime: LOCAL_CATALOG[index !== -1 ? index : 0] });
    } catch (e: any) {
      console.error("Error saving anime:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 2b. Save/Update custom manga
  app.post("/api/admin/mangas/save", (req, res) => {
    try {
      const manga = req.body;
      if (!manga || !manga.id) {
        return res.status(400).json({ error: "Invalid manga object" });
      }
      manga.active = manga.active !== undefined ? Boolean(manga.active) : true;

      GLOBAL_CUSTOM_MANGAS = readCustomMangasDb();
      const index = GLOBAL_CUSTOM_MANGAS.findIndex(m => m.id === manga.id);
      if (index !== -1) {
        GLOBAL_CUSTOM_MANGAS[index] = { ...GLOBAL_CUSTOM_MANGAS[index], ...manga };
      } else {
        GLOBAL_CUSTOM_MANGAS.push(manga);
      }

      writeCustomMangasDb(GLOBAL_CUSTOM_MANGAS);
      apiCache.flushAll();
      res.json({ success: true, manga });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 3. Delete anime or movie from catalog (with disk persistence)
  app.post("/api/admin/animes/delete", (req, res) => {
    try {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ error: "Missing anime ID" });
      }

      // Remove from LOCAL_CATALOG
      LOCAL_CATALOG = LOCAL_CATALOG.filter(a => a.id !== id);
      persistCatalog(LOCAL_CATALOG);

      // Also remove from GLOBAL_CUSTOM_ANIMES
      GLOBAL_CUSTOM_ANIMES = readCustomDb();
      GLOBAL_CUSTOM_ANIMES = GLOBAL_CUSTOM_ANIMES.filter(a => a.id !== id);
      writeCustomDb(GLOBAL_CUSTOM_ANIMES);

      apiCache.flushAll();
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error deleting anime:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // 3b. Delete custom manga
  app.post("/api/admin/mangas/delete", (req, res) => {
    try {
      const { id } = req.body;
      if (!id) {
        return res.status(400).json({ error: "Missing manga ID" });
      }

      GLOBAL_CUSTOM_MANGAS = readCustomMangasDb();
      GLOBAL_CUSTOM_MANGAS = GLOBAL_CUSTOM_MANGAS.filter(m => m.id !== id);
      writeCustomMangasDb(GLOBAL_CUSTOM_MANGAS);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 4. Suggest metadata and covers from AniList for Admin creation/editing
  app.get("/api/admin/catalog/suggest-media", async (req, res) => {
    try {
      const queryStr = (req.query.search as string || "").trim();
      if (!queryStr) {
        return res.status(400).json({ error: "Search query required" });
      }

      const gqlResult = await queryAniListGraphQL({ search: queryStr, perPage: 5 });
      if (gqlResult && gqlResult.Page && Array.isArray(gqlResult.Page.media) && gqlResult.Page.media.length > 0) {
        const suggestions = gqlResult.Page.media.map((m: any) => ({
          title: m.title?.romaji || m.title?.english || queryStr,
          title_english: m.title?.english || "",
          title_romaji: m.title?.romaji || "",
          coverUrl: m.coverImage?.extraLarge || m.coverImage?.large || "",
          bannerUrl: m.bannerImage || m.coverImage?.extraLarge || "",
          synopsis: m.description ? m.description.replace(/<[^>]*>/g, "").replace(/\n+/g, " ").trim() : "",
          genres: m.genres || [],
          rating: m.averageScore ? parseFloat((m.averageScore / 10).toFixed(1)) : 8.5,
          year: m.seasonYear || new Date().getFullYear(),
          episodesCount: m.episodes || 12,
          type: m.format === "MOVIE" ? "Película" : m.format === "OVA" ? "OVA" : "Anime",
          status: m.status === "RELEASING" ? "En emisión" : m.status === "NOT_YET_RELEASED" ? "Próximamente" : "Finalizado"
        }));
        return res.json({ success: true, suggestions });
      }
      res.json({ success: false, suggestions: [] });
    } catch (err: any) {
      console.error("Error suggesting media:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // 4. Scrape URL and add/update anime in the database
  app.post("/api/admin/animes/scrape-url", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: "Missing URL parameter" });
      }

      const lowercaseUrl = url.toLowerCase();
      const isAnimeFLV = lowercaseUrl.includes("animeflv.net");
      const isMonosChinos = lowercaseUrl.includes("monoschinos2.com") || lowercaseUrl.includes("monoschinos");

      if (!isAnimeFLV && !isMonosChinos) {
        return res.status(400).json({ error: "Only MonosChinos URLs are supported." });
      }

      if (isAnimeFLV) {
        console.log(`[Scraper] URL is AnimeFLV: "${url}". Sourcing equivalent from MonosChinos instead...`);
        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          }
        });
        const html = await response.text();
        let flvTitle = "";
        const titleMatch = html.match(/<h1 class="Title font-weight-bold">([^<]+)<\/h1>/i) || html.match(/<h1 class="Title">([^<]+)<\/h1>/i);
        if (titleMatch) flvTitle = titleMatch[1].trim();

        if (!flvTitle) {
          const slug = url.split("/anime/")[1] || "";
          flvTitle = slug.replace(/-/g, " ");
        }

        const monosAnime = await scrapeAnimeFromMonosChinosByTitle(flvTitle);
        if (monosAnime) {
          GLOBAL_CUSTOM_ANIMES = readCustomDb();
          const index = GLOBAL_CUSTOM_ANIMES.findIndex(a => a.id === monosAnime.id);
          if (index !== -1) {
            GLOBAL_CUSTOM_ANIMES[index] = { ...GLOBAL_CUSTOM_ANIMES[index], ...monosAnime };
          } else {
            GLOBAL_CUSTOM_ANIMES.push(monosAnime);
          }
          writeCustomDb(GLOBAL_CUSTOM_ANIMES);
          apiCache.flushAll();
          return res.json({ success: true, anime: monosAnime });
        } else {
          return res.status(400).json({ error: `El anime "${flvTitle}" no está disponible en MonosChinos. No se puede importar desde AnimeFLV.` });
        }
      }

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        }
      });
      const html = await response.text();

      let title = "Scraped Anime";
      let synopsis = "";
      let coverUrl = "";
      const genres: string[] = [];
      let status = "En emisión";
      let episodesCount = 12;

      // Parse Title
      const titleMatch = html.match(/<h1 class="title-nit[^>]*>([^<]+)<\/h1>/i);
      if (titleMatch) title = titleMatch[1].trim();

      // Parse Synopsis
      const synMatch = html.match(/<p class="text-justify[^>]*>([^<]+)<\/p>/i);
      if (synMatch) synopsis = synMatch[1].trim();

      // Parse Cover
      const coverMatch = html.match(/<div class="chapter-pic">[^]*?<img[^>]+src="([^"]+)"/i);
      if (coverMatch) coverUrl = coverMatch[1];

      // Parse Genres
      const genreRegex = /<a class="btn btn-outline-primary[^>]*>([^<]+)<\/a>/gi;
      let gMatch;
      while ((gMatch = genreRegex.exec(html)) !== null) {
        if (!genres.includes(gMatch[1])) genres.push(gMatch[1]);
      }

      // Parse Episodes
      const epRegex = /class="episode-item"[^>]*>Episode\s*(\d+)/gi;
      let maxEp = 0;
      let epM;
      while ((epM = epRegex.exec(html)) !== null) {
        const num = parseInt(epM[1], 10);
        if (num > maxEp) maxEp = num;
      }
      episodesCount = maxEp || 12;

      // Format ID (slugify)
      const id = title.toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove accents
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const newAnime = {
        id,
        title,
        synopsis,
        coverUrl,
        genres: genres.length > 0 ? genres : ["Acción"],
        status,
        rating: 8.5,
        type: "Anime",
        episodesCount,
        year: new Date().getFullYear(),
        episodes: []
      };

      GLOBAL_CUSTOM_ANIMES = readCustomDb();
      const index = GLOBAL_CUSTOM_ANIMES.findIndex(a => a.id === newAnime.id);
      if (index !== -1) {
        GLOBAL_CUSTOM_ANIMES[index] = { ...GLOBAL_CUSTOM_ANIMES[index], ...newAnime };
      } else {
        GLOBAL_CUSTOM_ANIMES.push(newAnime);
      }

      writeCustomDb(GLOBAL_CUSTOM_ANIMES);
      apiCache.flushAll();

      res.json({ success: true, anime: newAnime });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // --- STREAMING PROXY & LINK RESOLVERS ---

  // 1. Robust CORS-fixed Streaming Proxy (handles Range requests, HLS segments, CORS)
  app.get("/api/proxy-stream", async (req, res) => {
    const videoUrl = req.query.url as string;
    const referer = (req.query.referer as string) || videoUrl;
    if (!videoUrl) {
      return res.status(400).send("Missing video URL");
    }

    // Always set permissive CORS headers so the browser can read the stream
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type");

    const clientRange = req.headers.range;
    let refOrigin = videoUrl;
    try { refOrigin = new URL(referer).origin; } catch(e) {}

    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer,
      "Origin": refOrigin,
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    };
    if (clientRange) {
      fetchHeaders["Range"] = clientRange;
    }

    try {
      const upstream = await fetch(videoUrl, {
        headers: fetchHeaders,
        redirect: "follow",
        signal: AbortSignal.timeout(30000)
      });

      // If it's an HLS manifest (.m3u8), rewrite segment URLs to go through proxy
      const contentType = upstream.headers.get("content-type") || "";
      const isHlsManifest = videoUrl.split("?")[0].endsWith(".m3u8") || contentType.includes("mpegurl");

      if (isHlsManifest && upstream.ok) {
        let manifest = await upstream.text();
        const baseUrl = videoUrl.substring(0, videoUrl.lastIndexOf("/") + 1);
        // Rewrite relative segment/playlist URLs to go through our proxy
        manifest = manifest.replace(/^(?!#)(.+\.ts.*)$/gm, (match) => {
          const absUrl = match.startsWith("http") ? match : baseUrl + match;
          return `/api/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
        });
        manifest = manifest.replace(/^(?!#)(.+\.m3u8.*)$/gm, (match) => {
          const absUrl = match.startsWith("http") ? match : baseUrl + match;
          return `/api/proxy-stream?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
        });
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        return res.send(manifest);
      }

      // Forward status + headers for video segments and MP4 files
      res.status(upstream.status);
      const forwardHeaders = ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"];
      forwardHeaders.forEach(h => {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      });

      // Stream the body using standard Node.js stream piping to handle backpressure and range requests
      if (upstream.body) {
        const { Readable } = await import("node:stream");
        const nodeStream = Readable.fromWeb(upstream.body as any);
        nodeStream.on("error", (streamErr: any) => {
          console.warn("Proxy stream aborted/timed out cleanly:", streamErr?.message || streamErr);
          if (!res.writableEnded) res.end();
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err: any) {
      console.error("Proxy stream error:", err.message);
      if (!res.headersSent) {
        res.status(502).send("Upstream stream error: " + err.message);
      }
    }
  });

  // ── Google Drive OAuth2 Helper ──────────────────────────────────────────────
  // ── Google Drive OAuth2 Helper ──────────────────────────────────────────────
  // Uses the rclone refresh_token (or .env GDRIVE_REFRESH_TOKEN) to get
  // a short-lived access token so we can serve Drive files without anonymous
  // blocks from Google.
  const GDRIVE_CLIENT_ID     = process.env.GDRIVE_CLIENT_ID     || "202264815644.apps.googleusercontent.com";
  const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET || "X4Z3ca8xfWDb1Voo-F9a7ZxJ";
  const GDRIVE_REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN || "";

  let _cachedAccessToken: string | null = null;
  let _tokenExpiry = 0;

  async function getGDriveAccessToken(): Promise<string> {
    const now = Date.now();
    if (_cachedAccessToken && now < _tokenExpiry - 60000) return _cachedAccessToken;

    const body = new URLSearchParams({
      client_id: GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      refresh_token: GDRIVE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`GDrive token refresh failed: ${err}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    _cachedAccessToken = data.access_token;
    _tokenExpiry = Date.now() + (data.expires_in * 1000);
    return _cachedAccessToken;
  }

  // ── GET /api/gdrive-token — returns direct Google CDN stream URL ──
  app.get("/api/gdrive-token", async (req, res) => {
    const fileId = req.query.fileId as string;
    if (!fileId) return res.status(400).json({ error: "Missing fileId" });
    const directUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
    return res.json({ streamUrl: directUrl, proxyUrl: `/api/gdrive-stream?fileId=${fileId}` });
  });

  // ── GET & HEAD /api/gdrive-stream — streaming proxy fallback ──
  // Streams video bytes in safe chunks (max 4MB per request) to comply with
  // Firebase Cloud Functions 32MB payload limit.
  app.all("/api/gdrive-stream", async (req, res) => {
    let fileId = req.query.fileId as string;
    const rawUrl = req.query.url as string;

    if (!fileId && rawUrl) {
      const match = rawUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || rawUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (match) fileId = match[1];
    }

    if (!fileId) {
      return res.status(400).json({ error: "Missing fileId parameter" });
    }

    // CORS headers for HTML5 video element
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Range, Origin, Content-Type, Accept");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    try {
      const upstreamBase = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
      const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
      const reqRange = req.headers.range as string | undefined;

      let start = 0;
      let end: number | null = null;

      if (reqRange) {
        const match = reqRange.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          start = parseInt(match[1], 10);
          if (match[2]) {
            end = parseInt(match[2], 10);
          }
        }
      }

      if (end === null || end - start + 1 > MAX_CHUNK_SIZE) {
        end = start + MAX_CHUNK_SIZE - 1;
      }

      if (req.method === "HEAD") {
        const headUpstream = await fetch(upstreamBase, {
          method: "HEAD",
          headers: { "User-Agent": "Mozilla/5.0", Range: `bytes=${start}-${end}` }
        });
        res.status(206);
        res.setHeader("Content-Type", "video/mp4");
        res.setHeader("Accept-Ranges", "bytes");
        const cr = headUpstream.headers.get("content-range");
        if (cr) res.setHeader("Content-Range", cr);
        const cl = headUpstream.headers.get("content-length") || (end - start + 1).toString();
        res.setHeader("Content-Length", cl);
        return res.end();
      }

      const upstreamRes = await fetch(upstreamBase, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Range: `bytes=${start}-${end}`,
        },
      });

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        const errText = await upstreamRes.text();
        console.error(`[GDrive Stream] Upstream error ${upstreamRes.status}:`, errText.slice(0, 200));
        if (!res.headersSent) res.status(upstreamRes.status).send(errText);
        return;
      }

      res.status(upstreamRes.status);
      res.setHeader("Content-Type", upstreamRes.headers.get("content-type") || "video/mp4");
      res.setHeader("Accept-Ranges", "bytes");
      const contentRange = upstreamRes.headers.get("content-range");
      if (contentRange) res.setHeader("Content-Range", contentRange);
      const contentLength = upstreamRes.headers.get("content-length");
      if (contentLength) res.setHeader("Content-Length", contentLength);
      res.setHeader("Cache-Control", "public, max-age=7200");

      if (!upstreamRes.body) {
        return res.end();
      }

      Readable.fromWeb(upstreamRes.body as any).pipe(res);
    } catch (e: any) {
      console.error("[GDrive Stream] Error:", e.message);
      if (!res.headersSent) res.status(500).send("Stream error: " + e.message);
    }
  });




  // 2. Comprehensive Embed URL Resolver — supports 12+ server types

  app.get("/api/admin/resolve", async (req, res) => {
    const serverName = (req.query.server as string || "").toLowerCase();
    const embedUrl = req.query.url as string;

    if (!embedUrl) {
      return res.status(400).json({ error: "Missing URL to resolve" });
    }

    // Direct .mp4 / .m3u8 → proxy immediately, no extraction needed
    const cleanExt = embedUrl.toLowerCase().split("?")[0].split("#")[0];
    if (cleanExt.endsWith(".mp4") || cleanExt.endsWith(".m3u8") || cleanExt.endsWith(".webm")) {
      const isHls = cleanExt.endsWith(".m3u8");
      return res.json({
        url: `/api/proxy-stream?url=${encodeURIComponent(embedUrl)}&referer=${encodeURIComponent(embedUrl)}`,
        isHls
      });
    }

    // Google Drive direct stream resolver (Full HD 1080p, Zero ads, plays in MegaAnime native player)
    if (embedUrl.includes("drive.google.com") || embedUrl.includes("google.com/file") || serverName.includes("drive") || serverName.includes("megaanime")) {
      const driveMatch = embedUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || embedUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || embedUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      const fileId = driveMatch ? driveMatch[1] : null;
      if (fileId) {
        try {
          const downloadPageRes = await fetch(`https://drive.usercontent.google.com/download?id=${fileId}&export=download`, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(4000)
          });
          if (downloadPageRes.ok) {
            const pageText = await downloadPageRes.text();
            const uuidMatch = pageText.match(/name="uuid"\s+value="([^"]+)"/) || pageText.match(/uuid=([a-zA-Z0-9_-]+)/);
            const confirmMatch = pageText.match(/name="confirm"\s+value="([^"]+)"/) || pageText.match(/confirm=([a-zA-Z0-9_-]+)/);
            const uuid = uuidMatch ? uuidMatch[1] : "";
            const confirm = confirmMatch ? confirmMatch[1] : "t";
            const directStreamUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${confirm}&uuid=${uuid}`;
            return res.json({
              url: directStreamUrl,
              isHls: false,
              dead: false
            });
          }
        } catch (err) {
          console.warn("[Resolve] GDrive direct stream resolution error:", err);
        }
      }
    }

    try {
      let referer = embedUrl;
      try {
        const embedUrlObj = new URL(embedUrl);
        referer = embedUrlObj.origin;
      } catch(e) {}

      let response: Response | null = null;
      try {
        response = await fetch(embedUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
          },
          signal: AbortSignal.timeout(5000)
        });
      } catch (e) {}

      if (!response || !response.ok) {
        return res.json({ url: null, isHls: false, dead: false });
      }
      const rawHtml = await response.text();

      // Helper to unpack P.A.C.K.E.R encoded javascript strings
      const unpackPacker = (packedCode: string): string => {
        try {
          const match = packedCode.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
          if (!match) return packedCode;

          const payload = match[1];
          const radix = parseInt(match[2], 10);
          const symtab = match[4].split('|');
          const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

          const lookup = (word: string) => {
            let val = 0;
            for (let i = 0; i < word.length; i++) {
              val = val * radix + digits.indexOf(word[i]);
            }
            if (val < symtab.length && symtab[val]) {
              return symtab[val];
            }
            return word;
          };

          return payload.replace(/\b\w+\b/g, lookup);
        } catch (e) {
          return packedCode;
        }
      };

      const html = unpackPacker(rawHtml) + "\n" + rawHtml;

      // Detect if third-party embed page returned a 404 or File Deleted page
      const isDeadEmbed = /404|No encontrado|Not Found|File Not Found|File deleted|Video not found|no longer available|Content Restricted/i.test(html);
      if (isDeadEmbed) {
        return res.json({ url: null, isHls: false, dead: true });
      }

      let directUrl: string | null = null;
      let isHls = false;

      // ── Streamwish / Filelions / Wishembed / Lulustream ──
      if (serverName.includes("wish") || serverName.includes("lion") || html.includes("jwplayer") || html.includes("streamwish") || html.includes("luluvdo") || html.includes("lulustream")) {
        const m = html.match(/file\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/i)
               || html.match(/["']file["']\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/i)
               || html.match(/source\s*:\s*["'`](https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)["'`]/i)
               || html.match(/(https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*)/i);
        if (m) { directUrl = m[1]; isHls = true; }
      }

      // ── Doodstream / DoodPlayer ──
      if (!directUrl && (serverName.includes("dood") || html.includes("dood") || embedUrl.includes("dood"))) {
        const passMatch = html.match(/pass_md5\/([^'"\s]+)/i);
        if (passMatch) {
          try {
            const doodBase = new URL(embedUrl).origin;
            const passRes = await fetch(`${doodBase}/pass_md5/${passMatch[1]}`, {
              headers: { "Referer": embedUrl, "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(5000)
            });
            if (passRes.ok) {
              const token = await passRes.text();
              const ts = Date.now();
              directUrl = `${token.trim()}zUEJeL3mUN?token=${passMatch[1].split("/").pop()}&expiry=${ts}`;
            }
          } catch(e) {}
        }
      }

      // ── Filemoon / Moonplayer ──
      if (!directUrl && (serverName.includes("moon") || serverName.includes("filemoon") || html.includes("filemoon"))) {
        const m = html.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["'](https?:\/\/[^"']+)["']/i)
               || html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
        if (m) { directUrl = m[1]; isHls = directUrl.includes(".m3u8"); }
      }

      // ── OK.ru / okru ──
      if (!directUrl && (serverName.includes("ok") || embedUrl.includes("ok.ru"))) {
        const m = html.match(/"contentUrl":\s*"(https?:\/\/[^"]+\.mp4[^"]*)"/i)
               || html.match(/data-options=["']([^"']+)["']/i);
        if (m) {
          try {
            const opts = JSON.parse(decodeURIComponent(m[1]));
            const videos = opts?.flashvars?.metadata?.videos || opts?.metadata?.videos || [];
            const best = videos.sort((a: any, b: any) => (b.seekSchema || 0) - (a.seekSchema || 0))[0];
            if (best?.url) directUrl = best.url;
          } catch(e) {
            if (m[1].startsWith("http")) directUrl = m[1];
          }
        }
      }

      // ── Mp4Upload ──
      if (!directUrl && (serverName.includes("mp4upload") || embedUrl.includes("mp4upload") || html.includes("mp4upload"))) {
        const m = html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/player\.src\(["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.mp4\b[^"'`\s]*)/i);
        if (m && !m[1].includes(".js") && !m[1].includes(".css")) { directUrl = m[1]; isHls = false; }
      }

      // ── VOE.sx ──
      if (!directUrl && (serverName.includes("voe") || embedUrl.includes("voe") || html.includes("voe"))) {
        const redirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
        if (redirectMatch && redirectMatch[1] && !redirectMatch[1].includes("permanentToken")) {
          try {
            const voeRes = await fetch(redirectMatch[1], {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": embedUrl
              },
              signal: AbortSignal.timeout(4000)
            });
            if (voeRes.ok) {
              const voeHtml = await voeRes.text();
              const m = voeHtml.match(/['"]hls['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)
                     || voeHtml.match(/['"]file['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)
                     || voeHtml.match(/(https?:\/\/[^"'`\s\\]+\.m3u8\b[^"'`\s]*)/i);
              if (m) { directUrl = m[1]; isHls = true; }
            }
          } catch(e) {}
        }
        if (!directUrl) {
          const m = html.match(/['"]hls['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)
                 || html.match(/['"]file['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/i)
                 || html.match(/(https?:\/\/[^"'`\s\\]+\.m3u8\b[^"'`\s]*)/i);
          if (m) { directUrl = m[1]; isHls = true; }
        }
      }

      // ── YourUpload / uqload ──
      if (!directUrl && (serverName.includes("upload") || serverName.includes("yourupload") || embedUrl.includes("yourupload") || html.includes("yourupload"))) {
        const m = html.match(/jwplayer\([^)]+\)\.setup\(\{\s*file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/sources\s*:\s*\[[\s\S]*?["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.mp4\b[^"'`\s]*)/i);
        if (m && !m[1].includes(".js") && !m[1].includes(".css")) { directUrl = m[1]; isHls = false; }
      }

      // ── StreamTape ──
      if (!directUrl && (serverName.includes("tape") || html.includes("streamtape"))) {
        const m = html.match(/get_video\?id=([^&'"\s]+).*token=([^&'"\s]+)/i);
        if (m) directUrl = `https://streamtape.com/get_video?id=${m[1]}&token=${m[2]}&stream=1`;
      }

      // ── Mixdrop ──
      if (!directUrl && (serverName.includes("mix") || html.includes("mixdrop"))) {
        const m = html.match(/MDCore\.wurl\s*=\s*["'](https?:\/\/[^"']+)["']/i)
               || html.match(/["'](https?:\/\/s[0-9]+\.mixdrop\.co\/[^"']+)["']/i);
        if (m) { directUrl = m[1]; }
      }

      // ── Generic HLS/MP4 extraction (works for most unknown servers) ──
      if (!directUrl) {
        const m3u8 = html.match(/["'`](https?:\/\/[^"'`\s]{10,}\.m3u8(?:[^"'`\s]*)?)["'`]/i)
                  || html.match(/file:\s*["'](https?:\/\/[^"']+)["']/i);
        if (m3u8) { directUrl = m3u8[1]; isHls = true; }
        else {
          const mp4 = html.match(/["'`](https?:\/\/[^"'`\s]{10,}\.mp4(?:[^"'`\s]*)?)["'`]/i);
          if (mp4) { directUrl = mp4[1]; }
        }
      }

      if (directUrl) {
        return res.json({
          url: `/api/proxy-stream?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent(embedUrl)}`,
          isHls
        });
      }

      res.json({ url: null, isHls: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to resolve embed link" });
    }
  });

  // 3. Public Anime Streams — queries Gogoanime & AnimePahe without needing local servers
  app.get("/api/public-streams", async (req, res) => {
    const title = (req.query.title as string || "").trim();
    const epNum = parseInt(req.query.ep as string || "1", 10);
    const isMovie = req.query.movie === "1";

    if (!title) return res.status(400).json({ error: "Missing title" });

    // Run ALL 3 sources in PARALLEL (reduces worst-case from 26s to ~5s)
    const [aniZipResult, animePaheResult, jikanResult] = await Promise.allSettled([
      // ── Source 1: Gogoanime via api.ani.zip ──
      (async () => {
        const found: { name: string; url: string }[] = [];
        const searchRes = await fetch(
          `https://api.ani.zip/mappings?title=${encodeURIComponent(title)}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (searchRes.ok) {
          const data = await searchRes.json();
          const gogoanimeId = data?.mappings?.gogoanime_id || data?.mappings?.animepahe_id;
          if (gogoanimeId) {
            const epId = isMovie ? `${gogoanimeId}-movie` : `${gogoanimeId}-episode-${epNum}`;
            const streamRes = await fetch(
              `https://api.ani.zip/stream?episode_id=${encodeURIComponent(epId)}`,
              { signal: AbortSignal.timeout(3000) }
            );
            if (streamRes.ok) {
              const streamData = await streamRes.json();
              (streamData.sources || []).forEach((s: any) => {
                if (s.url) found.push({ name: `Gogoanime (${s.quality || "HD"})`, url: s.url });
              });
            }
          }
        }
        return found;
      })(),

      // ── Source 2: AnimePahe search ──
      (async () => {
        const found: { name: string; url: string }[] = [];
        const searchRes = await fetch(
          `https://animepahe.ru/api?m=search&q=${encodeURIComponent(title)}`,
          {
            headers: { "User-Agent": "Mozilla/5.0", "Cookie": "__ddg2_=lel" },
            signal: AbortSignal.timeout(3000)
          }
        );
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const candidates = searchData?.data || [];
          let bestCandidate: any = null;
          let bestScore = 0;
          for (const item of candidates) {
            const score = fuzzyMatch(title, item.title);
            if (score > bestScore) {
              bestScore = score;
              bestCandidate = item;
            }
          }
          if (bestCandidate && bestScore >= 0.70) {
            const first = bestCandidate;
            const epListRes = await fetch(
              `https://animepahe.ru/api?m=episode&id=${first.session}&sort=episode_asc&page=1`,
              {
                headers: { "User-Agent": "Mozilla/5.0", "Cookie": "__ddg2_=lel" },
                signal: AbortSignal.timeout(3000)
              }
            );
            if (epListRes.ok) {
              const epListData = await epListRes.json();
              const targetEp = (epListData?.data || []).find((e: any) => e.episode === epNum)
                            || epListData?.data?.[epNum - 1]
                            || epListData?.data?.[0];
              if (targetEp?.session) {
                const playerRes = await fetch(
                  `https://animepahe.ru/play/${first.session}/${targetEp.session}`,
                  {
                    headers: {
                      "User-Agent": "Mozilla/5.0",
                      "Referer": "https://animepahe.ru",
                      "Cookie": "__ddg2_=lel"
                    },
                    signal: AbortSignal.timeout(3000)
                  }
                );
                if (playerRes.ok) {
                  const playerHtml = await playerRes.text();
                  const kwikMatches = [...playerHtml.matchAll(/href=["'](https:\/\/kwik\.cx[^"']+)["']/gi)];
                  for (const m of kwikMatches.slice(0, 3)) {
                    found.push({ name: `AnimePahe (Kwik)`, url: m[1] });
                  }
                }
              }
            }
          }
        }
        return found;
      })(),

      // ── Source 3: Jikan MAL → YouTube trailer fallback ──
      (async () => {
        const found: { name: string; url: string }[] = [];
        const jikanRes = await fetch(
          `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (jikanRes.ok) {
          const jikanData = await jikanRes.json();
          const anime = jikanData?.data?.[0];
          if (anime?.trailer?.embed_url) {
            found.push({ name: "Tráiler Oficial (YouTube)", url: anime.trailer.embed_url });
          }
        }
        return found;
      })()
    ]);

    // Collect results from all sources that succeeded
    const servers: { name: string; url: string }[] = [];
    if (aniZipResult.status === "fulfilled") servers.push(...aniZipResult.value);
    if (animePaheResult.status === "fulfilled") servers.push(...animePaheResult.value);
    if (servers.length === 0 && jikanResult.status === "fulfilled") servers.push(...jikanResult.value);

    res.json({ servers });
  });

  // ── Live Users Telemetry System ──
  interface LiveSession {
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

  const LIVE_SESSIONS = new Map<string, LiveSession>();

  const COUNTRY_MAP: Record<string, { name: string; flag: string }> = {
    DO: { name: "República Dominicana", flag: "🇩🇴" },
    MX: { name: "México", flag: "🇲🇽" },
    ES: { name: "España", flag: "🇪🇸" },
    US: { name: "Estados Unidos", flag: "🇺🇸" },
    CO: { name: "Colombia", flag: "🇨🇴" },
    AR: { name: "Argentina", flag: "🇦🇷" },
    PE: { name: "Perú", flag: "🇵🇪" },
    CL: { name: "Chile", flag: "🇨🇱" },
    VE: { name: "Venezuela", flag: "🇻🇪" },
    EC: { name: "Ecuador", flag: "🇪🇨" },
    GT: { name: "Guatemala", flag: "🇬🇹" },
    CU: { name: "Cuba", flag: "🇨🇺" },
    BO: { name: "Bolivia", flag: "🇧🇴" },
    PR: { name: "Puerto Rico", flag: "🇵🇷" },
    CR: { name: "Costa Rica", flag: "🇨🇷" },
    PA: { name: "Panamá", flag: "🇵🇦" },
    UY: { name: "Uruguay", flag: "🇺🇾" },
    PY: { name: "Paraguay", flag: "🇵🇾" },
    SV: { name: "El Salvador", flag: "🇸🇻" },
    HN: { name: "Honduras", flag: "🇭🇳" },
    NI: { name: "Nicaragua", flag: "🇳🇮" },
    BR: { name: "Brasil", flag: "🇧🇷" },
    CA: { name: "Canadá", flag: "🇨🇦" },
    FR: { name: "Francia", flag: "🇫🇷" },
    DE: { name: "Alemania", flag: "🇩🇪" },
    IT: { name: "Italia", flag: "🇮🇹" },
    GB: { name: "Reino Unido", flag: "🇬🇧" },
    JP: { name: "Japón", flag: "🇯🇵" },
    KR: { name: "Corea del Sur", flag: "🇰🇷" },
    RU: { name: "Rusia", flag: "🇷🇺" },
    NL: { name: "Países Bajos", flag: "🇳🇱" },
    PT: { name: "Portugal", flag: "🇵🇹" },
    PH: { name: "Filipinas", flag: "🇵🇭" }
  };

  function parseUserAgent(ua: string) {
    ua = ua || "";
    let deviceType: LiveSession["deviceType"] = "Computadora";
    if (/mobile/i.test(ua) && !/tablet|ipad/i.test(ua)) deviceType = "Móvil";
    else if (/tablet|ipad/i.test(ua)) deviceType = "Tablet";
    else if (/smart-tv|googletv|appletv|hbbtv|roku|crkey/i.test(ua)) deviceType = "Smart TV";

    let os = "Desconocido";
    if (/windows/i.test(ua)) os = "Windows";
    else if (/macintosh|mac os x/i.test(ua) && !/iphone|ipad/i.test(ua)) os = "macOS";
    else if (/iphone/i.test(ua)) os = "iOS (iPhone)";
    else if (/ipad/i.test(ua)) os = "iPadOS";
    else if (/android/i.test(ua)) os = "Android";
    else if (/linux/i.test(ua)) os = "Linux";
    else if (/cros/i.test(ua)) os = "ChromeOS";

    let browser = "Navegador Web";
    if (/edg/i.test(ua)) browser = "Microsoft Edge";
    else if (/opr|opera/i.test(ua)) browser = "Opera";
    else if (/chrome|crios/i.test(ua)) browser = "Google Chrome";
    else if (/firefox|fxios/i.test(ua)) browser = "Mozilla Firefox";
    else if (/safari/i.test(ua)) browser = "Apple Safari";
    else if (/samsungbrowser/i.test(ua)) browser = "Samsung Internet";

    return { deviceType, os, browser };
  }

  // Heartbeat endpoint
  app.post(["/api/telemetry/heartbeat", "/telemetry/heartbeat"], express.json(), (req, res) => {
    try {
      const {
        sessionId,
        userId,
        userName,
        userEmail,
        userPlan,
        currentPath,
        currentAnimeTitle,
        currentEpisode,
        device
      } = req.body || {};

      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId" });
      }

      // Extract client IP
      const rawIp = (req.headers["cf-connecting-ip"] as string)
        || (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
        || (req.headers["fastly-client-ip"] as string)
        || (req.headers["x-real-ip"] as string)
        || req.socket.remoteAddress
        || "127.0.0.1";
      const ip = rawIp.replace(/^::ffff:/, '');

      // Extract Country & City from cloud headers (Cloudflare, App Engine, Fastly)
      const rawCountry = (req.headers["cf-ipcountry"] as string)
        || (req.headers["x-appengine-country"] as string)
        || (req.headers["geoip_country_code"] as string)
        || (req.headers["x-country-code"] as string)
        || "";

      const rawCity = (req.headers["cf-ipcity"] as string)
        || (req.headers["x-appengine-city"] as string)
        || "";

      const countryInfo = COUNTRY_MAP[rawCountry.toUpperCase()] || {
        name: rawCountry ? `País (${rawCountry.toUpperCase()})` : (ip === "127.0.0.1" || ip === "localhost" ? "Local / Desarrollo" : "Global / América"),
        flag: rawCountry ? "🌐" : (ip === "127.0.0.1" ? "💻" : "🌎")
      };

      const ua = req.headers["user-agent"] || "";
      const parsedUa = parseUserAgent(ua);

      const now = Date.now();
      const existing = LIVE_SESSIONS.get(sessionId);

      const session: LiveSession = {
        sessionId,
        ip: ip || "Desconocida",
        countryCode: rawCountry ? rawCountry.toUpperCase() : "INT",
        countryName: countryInfo.name,
        countryFlag: countryInfo.flag,
        city: rawCity ? decodeURIComponent(rawCity) : "",
        deviceType: device?.deviceType || parsedUa.deviceType,
        os: device?.os || parsedUa.os,
        browser: device?.browser || parsedUa.browser,
        screenResolution: device?.screenResolution || "",
        currentPath: currentPath || "/",
        currentAnimeTitle: currentAnimeTitle || "",
        currentEpisode: currentEpisode || "",
        userId: userId || existing?.userId,
        userName: userName || existing?.userName,
        userEmail: userEmail || existing?.userEmail,
        userPlan: userPlan || existing?.userPlan,
        connectedAt: existing?.connectedAt || now,
        lastSeen: now
      };

      LIVE_SESSIONS.set(sessionId, session);

      // Clean up sessions older than 45 seconds
      for (const [sId, sData] of LIVE_SESSIONS.entries()) {
        if (now - sData.lastSeen > 45000) {
          LIVE_SESSIONS.delete(sId);
        }
      }

      res.json({ success: true, onlineCount: LIVE_SESSIONS.size });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Disconnect endpoint
  app.post(["/api/telemetry/disconnect", "/telemetry/disconnect"], express.text({ type: "*/*" }), (req, res) => {
    try {
      let sessionId = "";
      if (typeof req.body === "string" && req.body.startsWith("{")) {
        try { sessionId = JSON.parse(req.body).sessionId; } catch(e) {}
      } else if (req.body?.sessionId) {
        sessionId = req.body.sessionId;
      }
      if (sessionId) {
        LIVE_SESSIONS.delete(sessionId);
      }
      res.json({ success: true });
    } catch (e: any) {
      res.json({ success: true });
    }
  });

  // Admin Live Users Query endpoint
  app.get(["/api/admin/live-users", "/admin/live-users"], (req, res) => {
    const now = Date.now();
    // Purge stale
    for (const [sId, sData] of LIVE_SESSIONS.entries()) {
      if (now - sData.lastSeen > 45000) {
        LIVE_SESSIONS.delete(sId);
      }
    }

    const sessions = Array.from(LIVE_SESSIONS.values()).sort((a, b) => b.lastSeen - a.lastSeen);

    const devices = { Computadora: 0, Móvil: 0, Tablet: 0, "Smart TV": 0, Otro: 0 };
    const countriesCount: Record<string, { country: string; code: string; flag: string; count: number }> = {};
    const pagesCount: Record<string, { path: string; title: string; count: number }> = {};

    for (const s of sessions) {
      if (devices[s.deviceType] !== undefined) devices[s.deviceType]++;
      else devices.Otro++;

      const cKey = s.countryCode || "INT";
      if (!countriesCount[cKey]) {
        countriesCount[cKey] = {
          country: s.countryName,
          code: s.countryCode,
          flag: s.countryFlag,
          count: 0
        };
      }
      countriesCount[cKey].count++;

      const pKey = s.currentAnimeTitle ? `${s.currentAnimeTitle} ${s.currentEpisode ? `- ${s.currentEpisode}` : ''}` : s.currentPath;
      if (!pagesCount[pKey]) {
        pagesCount[pKey] = {
          path: s.currentPath,
          title: s.currentAnimeTitle ? `${s.currentAnimeTitle} ${s.currentEpisode ? `- ${s.currentEpisode}` : ''}` : s.currentPath,
          count: 0
        };
      }
      pagesCount[pKey].count++;
    }

    res.json({
      onlineCount: sessions.length,
      users: sessions,
      devices,
      countries: Object.values(countriesCount).sort((a, b) => b.count - a.count),
      topPages: Object.values(pagesCount).sort((a, b) => b.count - a.count)
    });
  });

  // Configure middleware (Vite Dev Server vs Static Production bundle)
  const isDevExecution = process.env.NODE_ENV === "development" || process.argv[1]?.endsWith("server.ts");
  const isProduction = !isDevExecution && (process.env.NODE_ENV === "production" || fs.existsSync(path.join(process.cwd(), "dist/index.html")));

  if (!isProduction) {
    console.log("Starting server in DEVELOPMENT mode (booting Vite Dev Server)...");
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    // ── Dynamic XML Sitemap for Googlebot ──
    app.get(["/sitemap.xml", "/api/sitemap.xml"], (req, res) => {
      res.header("Content-Type", "application/xml");
      const todayStr = new Date().toISOString().split("T")[0];
      const catalog = getAnimesWithEpisodes() || [];

      let urlsXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://mega-anime.com/</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;

      catalog.forEach(anime => {
        const cleanId = encodeURIComponent(anime.id);
        urlsXml += `
  <url>
    <loc>https://mega-anime.com/anime/${cleanId}</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
      });

      urlsXml += `\n</urlset>`;
      res.send(urlsXml);
    });

    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, { setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
    
    // Dynamic SSR OpenGraph tags injection for Facebook / Social Crawlers & Direct Links
    app.get("*", (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      const indexPath = path.join(distPath, "index.html");
      if (!fs.existsSync(indexPath)) return res.status(200).send("megaAnime");

      let html = fs.readFileSync(indexPath, "utf-8");

      // Extract anime query or path
      const animeQuery = (req.query.anime as string) || (req.query.id as string);
      let animeSlug = animeQuery;
      if (!animeSlug && (req.path.startsWith("/anime/") || req.path.startsWith("/ver/"))) {
        animeSlug = req.path.replace(/^\/(anime|ver)\//, "").split("/")[0];
      }

      if (animeSlug) {
        const cleanSlug = decodeURIComponent(animeSlug).toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        const found = LOCAL_CATALOG.find(a => 
          a.id === animeSlug ||
          a.id === `tioanime-${animeSlug}` ||
          a.id.toLowerCase().replace(/^tioanime-/, "").replace(/[^a-z0-9]+/g, "-") === cleanSlug ||
          a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") === cleanSlug ||
          a.title.toLowerCase().includes(cleanSlug.replace(/-/g, " "))
        );

        if (found) {
          const ogTitle = `${found.title} - Ver Online en HD | megaAnime`;
          const ogDesc = found.synopsis ? found.synopsis.slice(0, 200) + "..." : `Disfruta de ${found.title} en HD en megaAnime.`;
          let ogImage = found.coverUrl || "https://mega-anime.com/icon-512.png";
          if (ogImage.includes("tioanime.com")) {
            ogImage = `https://mega-anime.com/api/image-proxy?url=${encodeURIComponent(ogImage)}`;
          }
          const ogUrl = `https://mega-anime.com/ver/${encodeURIComponent(cleanSlug)}`;

          html = html.replace(/<title>.*?<\/title>/i, `<title>${ogTitle}</title>`);
          html = html.replace(/<meta property="og:title" content=".*?"\s*\/?>/i, `<meta property="og:title" content="${ogTitle}" />`);
          html = html.replace(/<meta property="og:description" content=".*?"\s*\/?>/i, `<meta property="og:description" content="${ogDesc}" />`);
          html = html.replace(/<meta property="og:image" content=".*?"\s*\/?>/i, `<meta property="og:image" content="${ogImage}" /><meta property="og:image:secure_url" content="${ogImage}" /><meta property="og:image:type" content="image/jpeg" />`);
          html = html.replace(/<meta property="og:url" content=".*?"\s*\/?>/i, `<meta property="og:url" content="${ogUrl}" />`);
          html = html.replace(/<meta name="twitter:image" content=".*?"\s*\/?>/i, `<meta name="twitter:image" content="${ogImage}" />`);
        }
      }

      res.send(html);
    });
  }

  return app;
}

export const app = express();

createExpressApp().then((configuredApp) => {
  app.use(configuredApp);
  const isDirectExecution = process.argv[1]?.endsWith("server.cjs") || process.argv[1]?.endsWith("server.ts");
  if (isDirectExecution) {
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    configuredApp.listen(PORT, "0.0.0.0", () => {
      console.log(`megaAnime Server running on http://0.0.0.0:${PORT}`);
    });
  }
}).catch((err) => {
  console.error("Failed to initialize Express app:", err);
});

function getSvgPlaceholder(title: string, isBanner: boolean = false): string {
  const cleanTitle = title || "Anime";
  
  // Deterministic styling based on title
  let hash = 0;
  for (let i = 0; i < cleanTitle.length; i++) {
    hash = cleanTitle.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  const colors = [
    { start: "#111827", end: "#1f2937", text: "#f43f5e" }, // Deep Gray/Rose
    { start: "#1e1b4b", end: "#311042", text: "#a855f7" }, // Deep Indigo/Purple
    { start: "#0f172a", end: "#1e293b", text: "#38bdf8" }, // Slate/Dark Blue
    { start: "#1c1917", end: "#292524", text: "#f59e0b" }, // Stone/Dark Amber
    { start: "#022c22", end: "#064e3b", text: "#10b981" }, // Deep Green/Forest
    { start: "#1f0000", end: "#4a0000", text: "#ef4444" }  // Dark Red
  ];
  
  const selectedStyle = colors[Math.abs(hash) % colors.length];
  
  const width = isBanner ? 1200 : 400;
  const height = isBanner ? 480 : 570;
  
  // Break title into short lines to prevent overflow
  const words = cleanTitle.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  for (const word of words) {
    if ((currentLine + " " + word).length > (isBanner ? 28 : 14)) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += " " + word;
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  
  const displayedLines = lines.slice(0, 4);
  const textYStart = height / 2 - (displayedLines.length - 1) * (isBanner ? 22 : 18);
  
  const escapeSvgText = (str: string) => {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  const textElements = displayedLines.map((line, idx) => {
    const y = textYStart + idx * (isBanner ? 44 : 36);
    return `<text x="50%" y="${y}" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="${isBanner ? "36px" : "28px"}" letter-spacing="-0.02em">${escapeSvgText(line)}</text>`;
  }).join("\n");
  
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="anime-grad-${Math.abs(hash)}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${selectedStyle.start};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${selectedStyle.end};stop-opacity:1" />
        </linearGradient>
      </defs>
      
      <rect width="100%" height="100%" fill="url(#anime-grad-${Math.abs(hash)})" />
      
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 2.8}" fill="${selectedStyle.text}" opacity="0.08" />
      <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 1.8}" fill="#ffffff" opacity="0.01" stroke="#ffffff" stroke-width="1" />
      
      <rect x="16" y="16" width="${width - 32}" height="${height - 32}" rx="12" fill="none" stroke="${selectedStyle.text}" stroke-width="2" opacity="0.25" />

      ${textElements}
      
      <text x="50%" y="${height - 40}" dominant-baseline="middle" text-anchor="middle" fill="${selectedStyle.text}" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="12px" letter-spacing="0.3em" opacity="0.8">
        MEGAANIME OFFICIAL COVER
      </text>
    </svg>
  `.trim();
}
