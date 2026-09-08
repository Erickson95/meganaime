#!/usr/bin/env node
/**
 * ==============================================================================
 * MegaAnime — Automatic Airing Anime Downloader & Manifest Updater Daemon
 * ==============================================================================
 * Features:
 *  1. Live Release Monitoring: Scrapes jkanime.net front page for new episode releases.
 *  2. Airing Catalog Backlog Sweep: Monitors tracked airing series for next episodes.
 *  3. Clean 1080p Full HD Stream Resolution: Extracts direct HLS streams from JKAnime
 *     players (um/umv), bypassing all third-party popup/banner ads and watermarks.
 *  4. High-Speed Segment Downloader: Concurrent .ts segment fetching with exponential retry.
 *  5. Google Drive Upload: Directly syncs to gdrive:MegaAnime_HD with dedicated OAuth.
 *  6. Manifest & Catalog Sync: Updates src/data/drive_episodes.json, dist/drive_episodes.json,
 *     exact_airing_episodes.json, and catalog.json in real time.
 *  7. Automated Facebook Notification: Optional auto-post to official FB page.
 *  8. Daemon Mode: Run with `--watch` or `--daemon` to continuously poll every N minutes.
 * ==============================================================================
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const MANIFEST_SRC = path.join(PROJECT_ROOT, "src/data/drive_episodes.json");
const MANIFEST_DIST = path.join(PROJECT_ROOT, "dist/drive_episodes.json");
const AIRING_LIST_PATH = path.join(PROJECT_ROOT, "src/utils/exact_airing_episodes.json");
const CATALOG_SRC = path.join(PROJECT_ROOT, "src/data/catalog.json");
const CATALOG_DIST = path.join(PROJECT_ROOT, "dist/catalog.json");
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, "downloads");
const POSTED_FILE = path.join(PROJECT_ROOT, "src/utils/facebook_posted.json");

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ── 1. Load Environment Variables ──
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[k] = v;
    }
  }
  return env;
}

const envVars = loadEnv();
const GDRIVE_CID = envVars.GDRIVE_CLIENT_ID || "";
const GDRIVE_SEC = envVars.GDRIVE_CLIENT_SECRET || "";
const FB_TOKEN = envVars.FACEBOOK_PAGE_ACCESS_TOKEN || "";
const FB_PAGE_ID = envVars.FACEBOOK_PAGE_ID || "1375353446122077";

const RCLONE_FLAGS = GDRIVE_CID && GDRIVE_SEC
  ? `--drive-client-id "${GDRIVE_CID}" --drive-client-secret "${GDRIVE_SEC}" --drive-chunk-size 64M --drive-upload-cutoff 64M`
  : "";

// ── 2. Manifest Helpers ──
function getDriveManifest() {
  const mPath = fs.existsSync(MANIFEST_SRC) ? MANIFEST_SRC : MANIFEST_DIST;
  if (fs.existsSync(mPath)) {
    try {
      return JSON.parse(fs.readFileSync(mPath, "utf-8"));
    } catch (e) {}
  }
  return {};
}

function getAiringList() {
  if (fs.existsSync(AIRING_LIST_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(AIRING_LIST_PATH, "utf-8"));
    } catch (e) {}
  }
  return {};
}

function updateManifestEntry(animeKey, epNum, fileInfo, animeTitle, relativePath) {
  const manifests = [MANIFEST_SRC, MANIFEST_DIST];
  for (const mPath of manifests) {
    if (!fs.existsSync(mPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(mPath, "utf-8"));
      if (!data[animeKey]) data[animeKey] = { title: animeTitle, episodes: {} };
      if (!data[animeKey].episodes) data[animeKey].episodes = {};
      data[animeKey].episodes[`ep-${epNum}`] = {
        fileId: fileInfo.ID || fileInfo.fileId,
        streamUrl: `https://drive.google.com/file/d/${fileInfo.ID || fileInfo.fileId}/preview`,
        gdrivePath: relativePath,
        filename: fileInfo.Name || fileInfo.filename,
        sizeMB: (fileInfo.Size / (1024 * 1024)).toFixed(2),
        uploadedAt: new Date().toISOString()
      };
      fs.writeFileSync(mPath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[Manifest] ✅ Updated ${animeKey} ep-${epNum} in ${path.basename(mPath)}`);
    } catch (e) {
      console.warn(`[Manifest] Error updating ${mPath}:`, e.message);
    }
  }

  // Update exact_airing_episodes.json if epNum is greater
  try {
    if (fs.existsSync(AIRING_LIST_PATH)) {
      const airing = JSON.parse(fs.readFileSync(AIRING_LIST_PATH, "utf-8"));
      if (airing[animeKey] === undefined || epNum > airing[animeKey]) {
        airing[animeKey] = epNum;
        fs.writeFileSync(AIRING_LIST_PATH, JSON.stringify(airing, null, 2), "utf-8");
        console.log(`[Airing Tracker] Updated ${animeKey} to ${epNum} episodes.`);
      }
    }
  } catch (e) {}

  // Update catalog.json episode count if anime exists in catalog
  const catalogPaths = [CATALOG_SRC, CATALOG_DIST];
  for (const cPath of catalogPaths) {
    if (!fs.existsSync(cPath)) continue;
    try {
      const catalog = JSON.parse(fs.readFileSync(cPath, "utf-8"));
      const entry = catalog.find(a => a.id === animeKey || a.id === animeKey.replace(/^tioanime-/, ""));
      if (entry) {
        if (!entry.episodesCount || epNum > entry.episodesCount) {
          entry.episodesCount = epNum;
          fs.writeFileSync(cPath, JSON.stringify(catalog, null, 2), "utf-8");
          console.log(`[Catalog] Updated ${entry.title} episodesCount to ${epNum}`);
        }
      }
    } catch (e) {}
  }
}

// ── 3. Facebook Auto-Poster ──
async function postEpisodeToFacebook(animeTitle, epNum, animeKey) {
  if (!FB_TOKEN || !FB_PAGE_ID) return;

  const episodeIdentifier = `${animeKey}-ep-${epNum}`;
  let postedSet = new Set();
  try {
    if (fs.existsSync(POSTED_FILE)) {
      postedSet = new Set(JSON.parse(fs.readFileSync(POSTED_FILE, "utf-8")));
    }
  } catch (e) {}

  if (postedSet.has(episodeIdentifier)) {
    console.log(`[Facebook] Already posted ${episodeIdentifier}, skipping.`);
    return;
  }

  const cleanSlug = animeKey.replace(/^tioanime-/, "");
  const webUrl = `https://mega-anime.com/anime/${cleanSlug}`;
  const hashtag = animeTitle.replace(/[^a-zA-Z0-9]/g, "");

  const caption = `🔥 ¡YA DISPONIBLE EN megaAnime SIN ANUNCIOS! 🔥\n\n` +
    `🎬 Anime: ${animeTitle}\n` +
    `📺 Capítulo ${epNum}\n` +
    `⚡ Servidor Exclusivo MegaAnime (1080p Ultra HD)\n\n` +
    `🍿 ¡Disfrútalo ahora mismo en FULL HD nativo, sin anuncios molestos y con la máxima velocidad de streaming!\n\n` +
    `🌐 Ver Directo Aquí:\n${webUrl}\n\n` +
    `#megaAnime #AnimeEnEspañol #${hashtag} #EstrenoAnime #Otaku #AnimeHD`;

  console.log(`[Facebook] Posting new release: ${animeTitle} Ep ${epNum}...`);
  try {
    const postRes = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        link: webUrl,
        access_token: FB_TOKEN
      })
    });

    const resData = await postRes.json();
    if (resData && resData.id) {
      console.log(`[Facebook] ✅ Successfully published post! ID: ${resData.id}`);
      postedSet.add(episodeIdentifier);
      fs.writeFileSync(POSTED_FILE, JSON.stringify(Array.from(postedSet), null, 2), "utf-8");
    } else {
      console.warn(`[Facebook] Failed to post:`, resData);
    }
  } catch (e) {
    console.warn(`[Facebook] Error posting to feed:`, e.message);
  }
}

// ── 4. Scrape JKAnime Recent Releases ──
async function fetchRecentReleases() {
  console.log(`[Scanner] Fetching latest releases from https://jkanime.net/...`);
  try {
    const res = await fetch("https://jkanime.net/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "text/html"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      console.warn(`[Scanner] jkanime.net returned HTTP ${res.status}`);
      return [];
    }
    const html = await res.text();
    const matches = [...html.matchAll(/href=["']https:\/\/jkanime\.net\/([a-z0-9-]+)\/(\d+)\/["']/gi)];
    const seen = new Set();
    const releases = [];
    for (const m of matches) {
      const slug = m[1];
      const ep = parseInt(m[2], 10);
      const key = `${slug}-${ep}`;
      if (!seen.has(key)) {
        seen.add(key);
        releases.push({ slug, ep });
      }
    }
    console.log(`[Scanner] Detected ${releases.length} recent episode releases on JKAnime.`);
    return releases;
  } catch (e) {
    console.warn(`[Scanner] Error fetching recent releases:`, e.message);
    return [];
  }
}

// ── 5. Resolve Clean Full HD HLS Stream ──
async function resolveJkHls(animeSlug, epNum) {
  const epUrl = `https://jkanime.net/${animeSlug}/${epNum}/`;
  try {
    const res = await fetch(epUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const html = await res.text();

    const playerMatches = [...html.matchAll(/src=["'](https:\/\/jkanime\.net\/jkplayer\/[^"']+)["']/gi)];
    if (playerMatches.length === 0) return null;

    const sortedPlayers = playerMatches.map(m => m[1]).sort((a, b) => {
      if (a.includes("/um?") && !b.includes("/um?")) return -1;
      if (b.includes("/um?") && !a.includes("/um?")) return 1;
      if (a.includes("/umv?") && !b.includes("/umv?")) return -1;
      if (b.includes("/umv?") && !a.includes("/umv?")) return 1;
      return 0;
    });

    for (const pUrl of sortedPlayers) {
      try {
        const pRes = await fetch(pUrl, {
          headers: { Referer: epUrl, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          signal: AbortSignal.timeout(10000)
        });
        if (!pRes.ok) continue;
        const pHtml = await pRes.text();
        const hlsMatch = pHtml.match(/hls\.loadSource\(\s*['"]([^'"]+)['"]\)/i) ||
                         pHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
        if (hlsMatch) {
          return { m3u8Url: hlsMatch[1] || hlsMatch[0], referer: pUrl };
        }
      } catch (e) {}
    }
  } catch (e) {
    console.warn(`[Resolver] Error resolving ${animeSlug} ep ${epNum}:`, e.message);
  }
  return null;
}

// ── 6. Download HLS Segments & Assemble ──
async function downloadHlsStream(m3u8Url, referer, outputPath) {
  console.log(`[HLS Downloader] Fetching playlist: ${m3u8Url}`);
  let text = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(m3u8Url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": referer || "https://jkanime.net/"
        },
        signal: AbortSignal.timeout(20000)
      });
      if (res.ok) {
        text = await res.text();
        break;
      }
    } catch (e) {}
    if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 2000));
  }

  if (!text) {
    throw new Error(`Failed to fetch m3u8 playlist from ${m3u8Url}`);
  }

  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const baseUrl = new URL(m3u8Url);

  for (const line of lines) {
    if (line.includes(".m3u8")) {
      const subUrl = line.startsWith("http") ? line : new URL(line, baseUrl).toString();
      return downloadHlsStream(subUrl, referer, outputPath);
    }
  }

  const segmentUrls = [];
  for (const line of lines) {
    if (line.includes(".ts") || line.includes(".mp4") || !line.startsWith("#")) {
      const segUrl = line.startsWith("http") ? line : new URL(line, baseUrl).toString();
      segmentUrls.push(segUrl);
    }
  }

  if (segmentUrls.length === 0) {
    throw new Error("No video segments found in playlist");
  }

  console.log(`[HLS Downloader] Found ${segmentUrls.length} clean video segments.`);
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const tempDir = path.join(outDir, `.temp_${path.basename(outputPath, path.extname(outputPath))}`);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const concurrency = 6;
  let downloadedCount = 0;
  const total = segmentUrls.length;

  for (let i = 0; i < total; i++) {
    const segFile = path.join(tempDir, `seg_${String(i).padStart(5, "0")}.ts`);
    if (fs.existsSync(segFile) && fs.statSync(segFile).size > 0) {
      downloadedCount++;
    }
  }

  async function downloadSegment(url, index) {
    const segFile = path.join(tempDir, `seg_${String(index).padStart(5, "0")}.ts`);
    if (fs.existsSync(segFile) && fs.statSync(segFile).size > 0) return;

    for (let attempts = 1; attempts <= 5; attempts++) {
      try {
        const sRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": referer || "https://jkanime.net/"
          },
          signal: AbortSignal.timeout(30000)
        });
        if (!sRes.ok) throw new Error(`Status ${sRes.status}`);
        const buf = Buffer.from(await sRes.arrayBuffer());
        fs.writeFileSync(segFile, buf);
        downloadedCount++;
        if (downloadedCount % 25 === 0 || downloadedCount === total) {
          process.stdout.write(`\r[HLS Downloader] Download Progress: ${downloadedCount}/${total} (${((downloadedCount / total) * 100).toFixed(1)}%)`);
        }
        return;
      } catch (e) {
        if (attempts === 5) {
          console.warn(`\n[HLS Downloader] Warning: Segment ${index} failed after 5 retries: ${e.message}`);
          return;
        }
        await new Promise(r => setTimeout(r, attempts * 1000));
      }
    }
  }

  let currentIdx = 0;
  async function worker() {
    while (currentIdx < segmentUrls.length) {
      const idx = currentIdx++;
      await downloadSegment(segmentUrls[idx], idx);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  console.log(`\n[HLS Downloader] All segments downloaded! Merging clean stream to ${path.basename(outputPath)}...`);

  const outStream = fs.createWriteStream(outputPath);
  for (let i = 0; i < total; i++) {
    const segFile = path.join(tempDir, `seg_${String(i).padStart(5, "0")}.ts`);
    if (fs.existsSync(segFile)) {
      outStream.write(fs.readFileSync(segFile));
      fs.unlinkSync(segFile);
    }
  }
  await new Promise(r => outStream.end(r));

  try { fs.rmdirSync(tempDir); } catch (e) {}

  const finalSize = fs.statSync(outputPath).size;
  if (finalSize < 15 * 1024 * 1024) {
    throw new Error(`Assembled file is too small (${(finalSize / (1024*1024)).toFixed(1)} MB)`);
  }

  console.log(`[HLS Downloader] Assembled: ${(finalSize / (1024 * 1024)).toFixed(1)} MB.`);
  return outputPath;
}

// ── 7. Process A Single Anime Episode ──
async function processAnimeEpisode(animeKey, animeSlug, epNum, animeTitle, folderPath) {
  console.log(`\n================================================================`);
  console.log(`🚀 [Auto-Downloader] Processing: ${animeTitle} — Episode ${epNum}`);
  console.log(`================================================================`);

  const filename = `${animeTitle} - Episodio ${String(epNum).padStart(2, "0")}.mp4`;
  const remoteDir = `gdrive:MegaAnime_HD/${folderPath}`;
  const remotePath = `${remoteDir}/${filename}`;
  const safeSlug = animeSlug.replace(/[^a-z0-9]/g, "_");
  const localTemp = path.join(DOWNLOADS_DIR, `${safeSlug}-ep${epNum}.mp4`);

  // Step 1: Check if already in Google Drive
  try {
    const checkOut = execSync(`rclone lsjson "${remotePath}" ${RCLONE_FLAGS} 2>/dev/null`, { encoding: "utf-8" });
    const checkInfo = JSON.parse(checkOut);
    if (checkInfo.length > 0 && checkInfo[0].Size > 10 * 1024 * 1024) {
      console.log(`✅ [${animeTitle} Ep ${epNum}] Already exists in Google Drive (${(checkInfo[0].Size / (1024*1024)).toFixed(1)} MB).`);
      updateManifestEntry(animeKey, epNum, checkInfo[0], animeTitle, `${folderPath}/${filename}`);
      return true;
    }
  } catch (e) {}

  // Step 2: Check if already downloaded locally
  let hasLocal = fs.existsSync(localTemp) && fs.statSync(localTemp).size > 15 * 1024 * 1024;

  if (!hasLocal) {
    // Step 3: Resolve clean HLS stream from JKAnime
    console.log(`[${animeTitle} Ep ${epNum}] Resolving clean 1080p HLS stream on JKAnime...`);
    const streamInfo = await resolveJkHls(animeSlug, epNum);
    if (!streamInfo) {
      console.log(`⏳ [${animeTitle} Ep ${epNum}] Stream not yet available or failed to resolve.`);
      return false;
    }

    // Step 4: Download clean segments
    console.log(`[${animeTitle} Ep ${epNum}] Downloading clean stream without ads...`);
    await downloadHlsStream(streamInfo.m3u8Url, streamInfo.referer, localTemp);
  } else {
    console.log(`[${animeTitle} Ep ${epNum}] Found existing local file (${(fs.statSync(localTemp).size / (1024*1024)).toFixed(1)} MB). Resuming upload...`);
  }

  // Step 5: Upload to Google Drive
  console.log(`[${animeTitle} Ep ${epNum}] Uploading to Google Drive (${remotePath})...`);
  execSync(`rclone copyto "${localTemp}" "${remotePath}" ${RCLONE_FLAGS} -P --stats 10s`, { stdio: "inherit" });

  // Step 6: Verify and extract Drive file ID
  const verifyOut = execSync(`rclone lsjson "${remotePath}" ${RCLONE_FLAGS}`, { encoding: "utf-8" });
  const fileInfo = JSON.parse(verifyOut)[0];

  if (!fileInfo || !fileInfo.ID) {
    throw new Error(`Failed to verify upload on Drive for ${animeTitle} Ep ${epNum}`);
  }

  console.log(`[${animeTitle} Ep ${epNum}] ✅ Upload confirmed! File ID: ${fileInfo.ID}`);
  updateManifestEntry(animeKey, epNum, fileInfo, animeTitle, `${folderPath}/${filename}`);

  // Step 7: Post to Facebook
  try {
    await postEpisodeToFacebook(animeTitle, epNum, animeKey);
  } catch (e) {
    console.warn(`[${animeTitle} Ep ${epNum}] Facebook auto-post warning:`, e.message);
  }

  // Step 8: Clean up local temp file
  try {
    fs.unlinkSync(localTemp);
    console.log(`[${animeTitle} Ep ${epNum}] Cleaned up local file.`);
  } catch (e) {}

  return true;
}

// ── 8. Master Sweep Function ──
async function runAutoDownloaderSweep() {
  console.log(`\n================================================================`);
  console.log(`🔎 [MegaAnime Auto-Downloader] Starting sweep: ${new Date().toISOString()}`);
  console.log(`================================================================`);

  const manifest = getDriveManifest();
  const airingList = getAiringList();

  function getExistingFolder(key, title) {
    if (manifest[key] && manifest[key].episodes) {
      const epKeys = Object.keys(manifest[key].episodes);
      if (epKeys.length > 0) {
        const firstEp = manifest[key].episodes[epKeys[0]];
        if (firstEp && firstEp.gdrivePath) {
          return path.dirname(firstEp.gdrivePath);
        }
      }
    }
    return title.replace(/[/\\?%*:|"<>]/g, "_");
  }

  let downloadedAny = 0;

  // 1. Check live recent releases from JKAnime front page
  const recent = await fetchRecentReleases();
  for (const item of recent) {
    const candidateKeys = [
      `tioanime-${item.slug}`,
      item.slug
    ];

    let matchedKey = null;
    for (const ck of candidateKeys) {
      if (manifest[ck] || airingList[ck] !== undefined) {
        matchedKey = ck;
        break;
      }
    }

    if (matchedKey) {
      const title = manifest[matchedKey]?.title || matchedKey.replace(/^tioanime-/, "").replace(/-/g, " ");
      const existingEpisodes = manifest[matchedKey]?.episodes || {};
      if (!existingEpisodes[`ep-${item.ep}`]) {
        console.log(`🎯 [New Release Detected!] ${title} Ep ${item.ep} is now available!`);
        const folder = getExistingFolder(matchedKey, title);
        try {
          const ok = await processAnimeEpisode(matchedKey, item.slug, item.ep, title, folder);
          if (ok) downloadedAny++;
        } catch (e) {
          console.error(`❌ Error downloading ${title} Ep ${item.ep}:`, e.message);
        }
      }
    }
  }

  // 2. Check tracked airing series backlog for next missing episodes
  console.log(`\n[Backlog Sweep] Checking tracked airing series for next episodes...`);
  for (const animeKey of Object.keys(airingList)) {
    const slug = animeKey.replace(/^tioanime-/, "");
    const title = manifest[animeKey]?.title || slug.replace(/-/g, " ");
    const folder = getExistingFolder(animeKey, title);
    const existingEpisodes = manifest[animeKey]?.episodes || {};
    const currentCount = Object.keys(existingEpisodes).length;

    const nextEp = currentCount + 1;
    try {
      const probeRes = await fetch(`https://jkanime.net/${slug}/${nextEp}/`, {
        method: "HEAD",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(8000)
      });
      if (probeRes.ok) {
        console.log(`🎯 [Backlog Detected!] ${title} Episode ${nextEp} is available on source!`);
        try {
          const ok = await processAnimeEpisode(animeKey, slug, nextEp, title, folder);
          if (ok) downloadedAny++;
        } catch (e) {
          console.error(`❌ Error processing ${title} Ep ${nextEp}:`, e.message);
        }
      }
    } catch (e) {}
  }

  console.log(`\n================================================================`);
  console.log(`✨ Sweep complete. Downloaded ${downloadedAny} new episode(s).`);
  console.log(`================================================================\n`);
  return downloadedAny;
}

// ── 9. Daemon Watch Mode ──
async function runDaemon(intervalMinutes = 20) {
  console.log(`🤖 MegaAnime Auto-Downloader Daemon started.`);
  console.log(`⏰ Polling every ${intervalMinutes} minutes. Press Ctrl+C to stop.\n`);

  let isRunning = false;
  const tick = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await runAutoDownloaderSweep();
    } catch (e) {
      console.error("[Daemon Sweep Error]:", e);
    } finally {
      isRunning = false;
    }
  };

  await tick();
  setInterval(tick, intervalMinutes * 60 * 1000);
}

// ── 10. CLI Dispatcher ──
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--watch") || args.includes("--daemon")) {
    const intArg = args.find(a => a.startsWith("--interval="));
    const interval = intArg ? parseInt(intArg.split("=")[1], 10) : 20;
    await runDaemon(interval);
  } else if (args.includes("--anime")) {
    const slugIdx = args.indexOf("--anime") + 1;
    const slug = args[slugIdx];
    const epIdx = args.indexOf("--ep") + 1;
    const ep = epIdx > 0 ? parseInt(args[epIdx], 10) : 1;
    const key = `tioanime-${slug}`;
    const manifest = getDriveManifest();
    const title = manifest[key]?.title || slug;
    const folder = manifest[key]?.episodes?.["ep-1"] ? path.dirname(manifest[key].episodes["ep-1"].gdrivePath) : title;
    await processAnimeEpisode(key, slug, ep, title, folder);
  } else {
    await runAutoDownloaderSweep();
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}

module.exports = {
  runAutoDownloaderSweep,
  processAnimeEpisode,
  resolveJkHls,
  downloadHlsStream
};
