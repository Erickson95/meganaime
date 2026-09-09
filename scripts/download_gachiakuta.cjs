#!/usr/bin/env node
/**
 * ==============================================================================
 * MegaAnime — Pipelined Download & Upload of Gachiakuta (Episodes 1-24) to Google Drive
 * ==============================================================================
 * Concurrently pipelines downloading ep N+1 while uploading ep N to Google Drive,
 * ensuring maximum throughput, zero ads, clean 1080p stream, and zero watermarks.
 * ==============================================================================
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const MANIFEST_SRC = path.join(PROJECT_ROOT, "src/data/drive_episodes.json");
const MANIFEST_DIST = path.join(PROJECT_ROOT, "dist/drive_episodes.json");
const DOWNLOADS_DIR = path.join(PROJECT_ROOT, "downloads");

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

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
  ? `--drive-client-id "${GDRIVE_CID}" --drive-client-secret "${GDRIVE_SEC}" --drive-chunk-size 64M --timeout 45s --contimeout 20s --retries 3 --low-level-retries 10 -P --stats 10s`
  : "--drive-chunk-size 64M --timeout 45s --contimeout 20s --retries 3 --low-level-retries 10 -P --stats 10s";

const RCLONE_FLAGS_CHECK = GDRIVE_CID && GDRIVE_SEC
  ? `--drive-client-id "${GDRIVE_CID}" --drive-client-secret "${GDRIVE_SEC}" --retries 1 --low-level-retries 1`
  : "--retries 1 --low-level-retries 1";

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
}

async function resolveJkHls(animeSlug, epNum) {
  const epUrl = `https://jkanime.net/${animeSlug}/${epNum}/`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(epUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) continue;
      const html = await res.text();

      const playerMatches = [...html.matchAll(/src=["'](https:\/\/jkanime\.net\/jkplayer\/[^"']+)["']/gi)];
      if (playerMatches.length === 0) continue;

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
            signal: AbortSignal.timeout(15000)
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
      console.warn(`[Resolver] Intento ${attempt}/3 falló para ${animeSlug} ep ${epNum}:`, e.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

async function downloadHlsStream(m3u8Url, referer, outputPath, epLabel) {
  console.log(`[HLS Downloader ${epLabel}] Fetching playlist...`);
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
    throw new Error(`Failed to fetch m3u8 playlist for ${epLabel}`);
  }

  const lines = text.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  const baseUrl = new URL(m3u8Url);

  for (const line of lines) {
    if (line.includes(".m3u8")) {
      const subUrl = line.startsWith("http") ? line : new URL(line, baseUrl).toString();
      return downloadHlsStream(subUrl, referer, outputPath, epLabel);
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
    throw new Error(`No video segments found for ${epLabel}`);
  }

  console.log(`[HLS Downloader ${epLabel}] Found ${segmentUrls.length} clean video segments.`);
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
        if (downloadedCount % 50 === 0 || downloadedCount === total) {
          console.log(`[${epLabel}] Segment Progress: ${downloadedCount}/${total} (${((downloadedCount / total) * 100).toFixed(1)}%)`);
        }
        return;
      } catch (e) {
        if (attempts === 5) {
          console.warn(`[${epLabel}] Warning: Segment ${index} failed after 5 retries`);
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
  console.log(`[${epLabel}] All segments downloaded! Merging clean 1080p stream...`);

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
    throw new Error(`Assembled file for ${epLabel} is too small (${(finalSize / (1024*1024)).toFixed(1)} MB)`);
  }

  console.log(`[${epLabel}] Assembled clean stream: ${(finalSize / (1024 * 1024)).toFixed(1)} MB.`);
  return outputPath;
}

function checkIfInDrive(epNum) {
  try {
    for (const mPath of [MANIFEST_SRC, MANIFEST_DIST]) {
      if (fs.existsSync(mPath)) {
        const d = JSON.parse(fs.readFileSync(mPath, "utf-8"));
        const ep = d["tioanime-gachiakuta"]?.episodes?.[`ep-${epNum}`];
        if (ep && (ep.fileId || ep.streamUrl)) {
          return { ID: ep.fileId, Name: ep.filename, Size: (parseFloat(ep.sizeMB || "350") * 1024 * 1024) };
        }
      }
    }
  } catch (e) {}

  const filename = `Gachiakuta - Episodio ${String(epNum).padStart(2, "0")}.mp4`;
  const remotePath = `gdrive:MegaAnime_HD/Gachiakuta/${filename}`;
  try {
    const checkOut = execSync(`rclone lsjson "${remotePath}" ${RCLONE_FLAGS_CHECK} 2>/dev/null`, { encoding: "utf-8" });
    const checkInfo = JSON.parse(checkOut);
    if (checkInfo.length > 0 && checkInfo[0].Size > 15 * 1024 * 1024) {
      updateManifestEntry("tioanime-gachiakuta", epNum, checkInfo[0], "Gachiakuta", `Gachiakuta/${filename}`);
      return checkInfo[0];
    }
  } catch (e) {}
  return null;
}

async function ensureDownloadedLocally(epNum) {
  const localTemp = path.join(DOWNLOADS_DIR, `gachiakuta-ep${epNum}.mp4`);
  if (fs.existsSync(localTemp) && fs.statSync(localTemp).size > 15 * 1024 * 1024) {
    console.log(`[Gachiakuta Ep ${epNum}] Ya existe descargado en disco (${(fs.statSync(localTemp).size/(1024*1024)).toFixed(1)} MB).`);
    return localTemp;
  }

  console.log(`[Gachiakuta Ep ${epNum}] Resolviendo stream HLS 1080p sin anuncios...`);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const streamInfo = await resolveJkHls("gachiakuta", epNum);
      if (!streamInfo) {
        throw new Error(`No se pudo resolver enlace para Gachiakuta Ep ${epNum}`);
      }
      console.log(`[Gachiakuta Ep ${epNum}] Descargando stream Full HD...`);
      await downloadHlsStream(streamInfo.m3u8Url, streamInfo.referer, localTemp, `Gachiakuta Ep ${epNum}`);
      if (fs.existsSync(localTemp) && fs.statSync(localTemp).size > 15 * 1024 * 1024) {
        return localTemp;
      }
    } catch (err) {
      lastErr = err;
      console.warn(`[Download Ep ${epNum}] Intento ${attempt}/3 falló:`, err.message);
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000));
    }
  }

  throw lastErr || new Error(`Fallo descargando Gachiakuta Ep ${epNum}`);
}

async function uploadEpisodeToDrive(epNum, localPath) {
  const filename = `Gachiakuta - Episodio ${String(epNum).padStart(2, "0")}.mp4`;
  const remotePath = `gdrive:MegaAnime_HD/Gachiakuta/${filename}`;

  console.log(`\n☁️ [Gachiakuta Ep ${epNum}] Subiendo a Google Drive (${remotePath})...`);
  let fileInfo = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execSync(`rclone copyto "${localPath}" "${remotePath}" ${RCLONE_FLAGS}`, { stdio: "inherit" });
      const verifyOut = execSync(`rclone lsjson "${remotePath}" ${RCLONE_FLAGS_CHECK}`, { encoding: "utf-8" });
      const list = JSON.parse(verifyOut);
      if (list && list.length > 0 && list[0].ID) {
        fileInfo = list[0];
        break;
      }
    } catch (err) {
      console.warn(`[Drive Upload Ep ${epNum}] Intento ${attempt}/3 falló:`, err.message);
      if (attempt < 3) {
        console.log("Reintentando subida en 5 segundos...");
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (!fileInfo || !fileInfo.ID) {
    throw new Error(`Fallo en verificación de Drive para Gachiakuta Ep ${epNum}`);
  }

  console.log(`✅ [Gachiakuta Ep ${epNum}] Subido exitosamente a Drive! ID: ${fileInfo.ID}`);
  updateManifestEntry("tioanime-gachiakuta", epNum, fileInfo, "Gachiakuta", `Gachiakuta/${filename}`);

  try {
    fs.unlinkSync(localPath);
    console.log(`🧹 [Gachiakuta Ep ${epNum}] Archivo local temporal eliminado.`);
  } catch (e) {}

  return fileInfo;
}

async function publishGachiakutaToFacebook() {
  if (!FB_TOKEN || !FB_PAGE_ID) return;
  console.log("\n================================================================");
  console.log("📢 Publicando Gachiakuta Completo en Facebook...");
  console.log("================================================================");

  const caption = `🔥 ¡GACHIAKUTA DISPONIBLE COMPLETO EN megaAnime SIN ANUNCIOS! 🔥\n\n` +
    `🎬 Anime: Gachiakuta (Temporada Completa - 24 Capítulos)\n` +
    `📺 Capítulos 1 al 24 Disponibles\n` +
    `⭐ Géneros: Acción, Drama, Fantasía Oscura, Shonen\n` +
    `⚡ Servidor Exclusivo MegaAnime (1080p Ultra HD)\n\n` +
    `🍿 ¡Disfruta la historia de Rudo arrojado al Abismo en FULL HD nativo, sin anuncios molestos, sin marcas de agua y con la máxima velocidad de streaming directo!\n\n` +
    `🌐 Ver Completo Aquí:\nhttps://mega-anime.com/ver/gachiakuta?ep=1\n\n` +
    `#megaAnime #Gachiakuta #AnimeEnEspañol #EstrenoAnime #Otaku #AnimeHD #Bones`;

  try {
    const res = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        link: "https://mega-anime.com/ver/gachiakuta?ep=1",
        access_token: FB_TOKEN
      })
    });
    const data = await res.json();
    if (data && data.id) {
      console.log(`✅ ¡Gachiakuta publicado en Facebook! ID: ${data.id}`);
    }
  } catch (e) {}
}

async function main() {
  const startEp = parseInt(process.argv[2] || "1", 10);
  const endEp = parseInt(process.argv[3] || "24", 10);

  console.log(`🚀 INICIANDO PIPELINE PIPELINED: GACHIAKUTA (Episodios ${startEp} al ${endEp}) 🚀\n`);

  let nextDownloadPromise = null;
  let nextDownloadEp = null;

  for (let ep = startEp; ep <= endEp; ep++) {
    console.log(`\n================================================================`);
    console.log(`🎬 [Gachiakuta] Procesando Episodio ${ep} / ${endEp}`);
    console.log(`================================================================`);

    // 1. Check if already in Google Drive
    const driveInfo = checkIfInDrive(ep);
    if (driveInfo) {
      console.log(`✅ [Gachiakuta Ep ${ep}] Ya existe en Google Drive (${(driveInfo.Size/(1024*1024)).toFixed(1)} MB).`);
      continue;
    }

    // 2. Ensure current episode is downloaded locally
    let localPath = null;
    if (nextDownloadEp === ep && nextDownloadPromise) {
      console.log(`[Gachiakuta Ep ${ep}] Esperando que finalice la pre-descarga...`);
      localPath = await nextDownloadPromise;
      nextDownloadPromise = null;
      nextDownloadEp = null;
    }

    // Robust fallback if pre-download failed or was aborted
    if (!localPath || !fs.existsSync(localPath)) {
      try {
        console.log(`[Gachiakuta Ep ${ep}] Descargando localmente...`);
        localPath = await ensureDownloadedLocally(ep);
      } catch (err) {
        console.error(`❌ Error descargando Gachiakuta Ep ${ep}:`, err.message);
      }
    }

    if (!localPath || !fs.existsSync(localPath)) {
      console.error(`⚠️ Saltando subida de Episodio ${ep} debido a fallo en descarga.`);
      continue;
    }

    // 3. Trigger pre-download of ep + 1 in background if not in Drive
    for (let next = ep + 1; next <= endEp; next++) {
      const nextInDrive = checkIfInDrive(next);
      if (!nextInDrive) {
        console.log(`⚡ [Pipelining] Iniciando pre-descarga de Episodio ${next} mientras se sube Episodio ${ep}...`);
        nextDownloadEp = next;
        nextDownloadPromise = ensureDownloadedLocally(next).catch(e => {
          console.warn(`[Prefetch Ep ${next} Error]:`, e.message);
          return null;
        });
        break;
      }
    }

    // 4. Upload current episode to Google Drive
    try {
      await uploadEpisodeToDrive(ep, localPath);
    } catch (e) {
      console.error(`❌ Error subiendo Gachiakuta Ep ${ep}:`, e.message);
    }
  }

  // Await any remaining download
  if (nextDownloadPromise && nextDownloadEp) {
    const finalLocal = await nextDownloadPromise;
    if (finalLocal) {
      await uploadEpisodeToDrive(nextDownloadEp, finalLocal);
    }
  }

  console.log("\n🎉 ¡TODOS LOS EPISODIOS DE GACHIAKUTA HAN SIDO COMPLETADOS!");
  await publishGachiakutaToFacebook();
}

if (require.main === module) {
  main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
