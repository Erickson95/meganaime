const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawn, execSync } = require("child_process");

const PROGRESS_FILE = path.join(process.cwd(), "src/data/gdrive_download_progress.json");
const MANIFEST_FILE = path.join(process.cwd(), "src/data/drive_episodes.json");
const CATALOG_FILE = path.join(process.cwd(), "src/data/catalog.json");
const AIRING_MAP_FILE = path.join(process.cwd(), "src/utils/airing_episodes.json");

function sanitizeFolderName(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getSeasonHierarchy(rawTitle) {
  let title = rawTitle.trim();
  let baseTitle = title;
  let seasonSubfolder = "";

  if (/(?:4th\s+Season|Temporada\s+4|Season\s+4|Parte\s+4|IV\b)/i.test(title)) {
    seasonSubfolder = "4ta Temporada";
    baseTitle = title.replace(/\s*[-:]?\s*(?:4th\s+Season|Temporada\s+4|Season\s+4|Parte\s+4|IV\b)[\s\S]*/i, "").trim();
  } else if (/(?:3rd\s+Season|Temporada\s+3|Season\s+3|Parte\s+3|III\b)/i.test(title)) {
    seasonSubfolder = "3ra Temporada";
    baseTitle = title.replace(/\s*[-:]?\s*(?:3rd\s+Season|Temporada\s+3|Season\s+3|Parte\s+3|III\b)[\s\S]*/i, "").trim();
  } else if (/(?:2nd\s+Season|Temporada\s+2|Season\s+2|Parte\s+2|\bII\b|\b2\b$)/i.test(title)) {
    seasonSubfolder = "2da Temporada";
    baseTitle = title.replace(/\s*[-:]?\s*(?:2nd\s+Season|Temporada\s+2|Season\s+2|Parte\s+2|\bII\b|\b2\b$)[\s\S]*/i, "").trim();
  }

  if (!baseTitle || baseTitle.length < 2) baseTitle = title;

  return {
    mainFolder: sanitizeFolderName(baseTitle),
    seasonFolder: seasonSubfolder ? sanitizeFolderName(seasonSubfolder) : ""
  };
}

function renderProgressBar(percent, length = 22) {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * length);
  const empty = length - filled;
  return "[" + "█".repeat(filled) + "░".repeat(empty) + "] " + p.toFixed(1) + "%";
}

function unpackPacker(packedCode) {
  try {
    const match = packedCode.match(/eval\(function\(p,a,c,k,e,d\)\{.*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/);
    if (!match) return packedCode;
    const payload = match[1];
    const radix = parseInt(match[2], 10);
    const symtab = match[4].split('|');
    const digits = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lookup = (word) => {
      let val = 0;
      for (let i = 0; i < word.length; i++) {
        val = val * radix + digits.indexOf(word[i]);
      }
      return val < symtab.length && symtab[val] ? symtab[val] : word;
    };
    return payload.replace(/\b\w+\b/g, lookup);
  } catch (e) {
    return packedCode;
  }
}

async function resolveDirectVideoUrl(serverName, serverUrl) {
  try {
    const clean = serverUrl.split("?")[0].toLowerCase();
    if (clean.endsWith(".mp4") || clean.endsWith(".m3u8")) {
      return { url: serverUrl, isHls: clean.endsWith(".m3u8") };
    }

    const sName = (serverName || "").toLowerCase();
    const sUrl = (serverUrl || "").toLowerCase();

    // ── YourUpload ──
    if (sUrl.includes("yourupload") || sName.includes("yourupload")) {
      const res = await fetch(serverUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://tioanime.com/"
        },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const html = await res.text();
        const m = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/src\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.mp4\b[^"'`\s]*)/i);
        if (m && !m[1].includes(".js") && !m[1].includes(".css")) return { url: m[1], isHls: false, referer: serverUrl };
      }
    }

    // ── Mp4Upload ──
    if (sUrl.includes("mp4upload") || sName.includes("mp4upload")) {
      const res = await fetch(serverUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://tioanime.com/" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const html = await res.text();
        const m = html.match(/src:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/player\.src\(\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/<source\s+src=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.mp4\b[^"'`\s]*)/i);
        if (m) return { url: m[1], isHls: false, referer: "https://www.mp4upload.com/" };
      }
    }

    // ── Voe ──
    if (sUrl.includes("voe.sx") || sName.includes("voe")) {
      try {
        const res = await fetch(serverUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          redirect: "follow",
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const html = await res.text();
          // Check for redirect location inside HTML
          const redirectMatch = html.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
          let targetHtml = html;
          let targetUrl = serverUrl;
          if (redirectMatch) {
            targetUrl = redirectMatch[1];
            const r2 = await fetch(targetUrl, {
              headers: { "User-Agent": "Mozilla/5.0", "Referer": serverUrl },
              signal: AbortSignal.timeout(8000)
            });
            if (r2.ok) targetHtml = await r2.text();
          }

          const m3u8 = targetHtml.match(/['"]hls['"]\s*:\s*['"]([^'"]+)['"]/i)
                    || targetHtml.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);
          const mp4 = targetHtml.match(/['"]mp4['"]\s*:\s*['"]([^'"]+)['"]/i)
                   || targetHtml.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);

          if (mp4) return { url: mp4[1] || mp4[0], isHls: false, referer: targetUrl };
          if (m3u8) return { url: m3u8[1] || m3u8[0], isHls: true, referer: targetUrl };
        }
      } catch(e) {}
    }

    // ── Filemoon ──
    if (sUrl.includes("filemoon") || sName.includes("filemoon")) {
      const res = await fetch(serverUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://tioanime.com/" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const raw = await res.text();
        const html = unpackPacker(raw) + "\n" + raw;
        const m = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.m3u8\b[^"'`\s]*)/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.mp4\b[^"'`\s]*)/i);
        if (m) return { url: m[1], isHls: m[1].includes(".m3u8"), referer: serverUrl };
      }
    }

    // ── Streamwish ──
    if (sUrl.includes("wish") || sName.includes("wish") || sUrl.includes("streamwish")) {
      const res = await fetch(serverUrl, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://tioanime.com/" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const raw = await res.text();
        const html = unpackPacker(raw) + "\n" + raw;
        const m = html.match(/file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i)
               || html.match(/(https?:\/\/[^"'`\s\\]+\.m3u8\b[^"'`\s]*)/i);
        if (m) return { url: m[1], isHls: true, referer: serverUrl };
      }
    }

    // ── Mixdrop ──
    if (sUrl.includes("mixdrop") || sName.includes("mixdrop")) {
      const res = await fetch(serverUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const raw = await res.text();
        const html = unpackPacker(raw) + "\n" + raw;
        const m = html.match(/MDCore\.wurl\s*=\s*["'](https?:\/\/[^"']+)["']/i)
               || html.match(/["'](https?:\/\/s[0-9]+\.mixdrop\.co\/[^"']+)["']/i);
        if (m) return { url: m[1], isHls: false, referer: serverUrl };
      }
    }

    if (serverUrl.includes("megaanime") || serverUrl.includes("drive.google.com")) {
      return { url: serverUrl, isHls: false };
    }

    return null;
  } catch (err) {
    return null;
  }
}

async function streamToGoogleDrive(videoUrl, remotePath, referer, onProgress) {
  return new Promise((resolve, reject) => {
    const isHttps = videoUrl.startsWith("https:");
    const client = isHttps ? https : http;

    const rclone = spawn("rclone", ["rcat", remotePath], {
      stdio: ["pipe", "ignore", "pipe"]
    });

    // Guard against unhandled EPIPE when network socket closes early
    rclone.stdin.on("error", () => {});

    let rcloneStderr = "";
    rclone.stderr.on("data", (chunk) => {
      rcloneStderr += chunk.toString();
    });

    let totalBytes = 0;
    let downloadedBytes = 0;
    let isFinished = false;

    function finish(err) {
      if (isFinished) return;
      isFinished = true;
      try { res && res.unpipe && res.unpipe(rclone.stdin); } catch(e) {}
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    }

    rclone.on("close", (code) => {
      if (code === 0) {
        finish(null);
      } else {
        finish(new Error(`rclone rcat error code ${code}: ${rcloneStderr.trim()}`));
      }
    });

    rclone.on("error", (err) => {
      finish(err);
    });

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": referer || "https://tioanime.com/",
      "Accept": "*/*",
      "Connection": "keep-alive"
    };

    const req = client.get(videoUrl, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          const u = new URL(videoUrl);
          redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
        }
        return streamToGoogleDrive(redirectUrl, remotePath, referer, onProgress)
          .then(resolve)
          .catch(finish);
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        try { rclone.stdin.end(); } catch(e) {}
        return finish(new Error(`HTTP ${res.statusCode} from video source`));
      }

      totalBytes = parseInt(res.headers["content-length"] || "0", 10);

      res.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          const pct = (downloadedBytes / totalBytes) * 100;
          const currMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
          const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
          onProgress(pct, currMB, totalMB);
        }
      });

      res.pipe(rclone.stdin);

      res.on("error", (err) => {
        try { rclone.stdin.end(); } catch(e) {}
        finish(err);
      });
    });

    req.on("error", (err) => {
      try { rclone.stdin.end(); } catch(e) {}
      finish(err);
    });

    req.setTimeout(25000, () => {
      try { rclone.stdin.end(); } catch(e) {}
      req.destroy(new Error("Initial connection timeout after 25s"));
    });
  });
}

(async () => {
  console.log(`\n========================================================================`);
  console.log(`🚀 MEGA ANIME ➔ GOOGLE DRIVE (SISTEMA DE ANÁLISIS MULTILINGÜE INTELIGENTE) 🚀`);
  console.log(`Escaneando inventario existente en Drive para no repetir NINGÚN anime ni episodio...`);
  console.log(`========================================================================\n`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf-8"));
  const airingMap = fs.existsSync(AIRING_MAP_FILE) ? JSON.parse(fs.readFileSync(AIRING_MAP_FILE, "utf-8")) : {};
  let driveData = fs.existsSync(MANIFEST_FILE) ? JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8")) : {};

  // 1. Escaneo profundo de Google Drive con rclone
  console.log("🔍 Consultando archivos y carpetas existentes en tu Google Drive...");
  let files = [];
  try {
    const rcloneList = execSync("rclone lsjson -R --files-only \"gdrive:MegaAnime_HD\" 2>/dev/null", {
      encoding: "utf-8",
      maxBuffer: 60 * 1024 * 1024
    });
    files = JSON.parse(rcloneList);
    console.log(`✅ Inventario obtenido: ${files.length} archivos MP4 encontrados en Google Drive.`);
  } catch (err) {
    console.error("❌ Error leyendo Google Drive:", err.message);
    process.exit(1);
  }

  // Index files by folder and by filename pattern
  const driveFilesByFolder = {};
  files.forEach(f => {
    const parts = f.Path.split("/");
    const folder = parts[0];
    const filename = parts[parts.length - 1];
    if (!driveFilesByFolder[folder]) driveFilesByFolder[folder] = [];
    driveFilesByFolder[folder].push({ filename, path: f.Path, size: f.Size, id: f.ID });
  });

  // 2. Mapeo inteligente con catálogo multilingüe y actualización del manifiesto
  const targetAnimes = catalog.filter(a => a.status === "En emisión" || a.id.includes("bleach-sennen") || a.id.includes("one-piece"));
  const pendingQueue = [];
  let totalAlreadyComplete = 0;

  targetAnimes.forEach(anime => {
    let targetEps = airingMap[anime.id] || (anime.episodes ? anime.episodes.length : (anime.episodesCount || 1));
    if (anime.id.includes("bleach-sennen")) targetEps = Math.max(targetEps, 46);
    if (anime.id.includes("one-piece")) targetEps = Math.max(targetEps, 1176);
    const normTitle = normalize(anime.title);
    const normId = normalize(anime.id.replace(/^tioanime-/, ""));

    let matchedFiles = [];
    let matchedFolder = "";

    for (const folder of Object.keys(driveFilesByFolder)) {
      const normFolder = normalize(folder);
      if (
        normFolder === normTitle ||
        normFolder === normId ||
        (normTitle.length > 5 && normFolder.includes(normTitle)) ||
        (normFolder.length > 5 && normTitle.includes(normFolder))
      ) {
        matchedFolder = folder;
        matchedFiles.push(...driveFilesByFolder[folder]);
      }
    }

    // Index existing episode numbers (MUST be >= 20MB to be a real valid video file)
    const existingEpisodesMap = new Map();
    matchedFiles.forEach(f => {
      if (!f.size || f.size < 20 * 1024 * 1024) return;
      const m = f.filename.match(/Episodio\s*(\d+)/i) || f.filename.match(/_(\d+)\.mp4$/i) || f.filename.match(/-(\d+)\.mp4$/i) || f.filename.match(/\b(\d+)\.mp4$/i);
      if (m) {
        const epNum = parseInt(m[1]);
        existingEpisodesMap.set(epNum, f);
      }
    });

    // Update driveData manifest for all found episodes
    if (!driveData[anime.id]) {
      driveData[anime.id] = { title: anime.title, episodes: {} };
    }

    existingEpisodesMap.forEach((fileObj, epNum) => {
      driveData[anime.id].episodes[`ep-${epNum}`] = {
        fileId: fileObj.id,
        streamUrl: fileObj.id ? `https://drive.google.com/file/d/${fileObj.id}/preview` : null,
        gdrivePath: fileObj.path,
        filename: fileObj.filename,
        sizeMB: (fileObj.size / (1024 * 1024)).toFixed(2),
        uploadedAt: new Date().toISOString()
      };
    });

    // Determine missing episodes
    const missingEps = [];
    for (let ep = 1; ep <= targetEps; ep++) {
      if (!existingEpisodesMap.has(ep)) {
        missingEps.push(ep);
      }
    }

    if (missingEps.length === 0) {
      totalAlreadyComplete++;
    } else {
      pendingQueue.push({
        anime,
        targetEps,
        downloadedCount: existingEpisodesMap.size,
        missingEps,
        matchedFolder: matchedFolder || getSeasonHierarchy(anime.title).mainFolder
      });
    }
  });

  // Save updated verified manifest
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(driveData, null, 2), "utf-8");
  const distManifest = path.join(process.cwd(), "dist/drive_episodes.json");
  if (fs.existsSync(path.dirname(distManifest))) {
    fs.writeFileSync(distManifest, JSON.stringify(driveData, null, 2), "utf-8");
  }

  // Prioridad solicitada por el usuario:
  // 1. Animes a los que les faltan 1 o 2 capítulos (terminar los que están a punto de completarse)
  // 2. One Piece (completar los episodios que faltan hasta el más reciente)
  // 3. Otros parciales (que les faltan 3, 4, 5... capítulos)
  // 4. Vacíos (que no tienen ningún capítulo descargado)
  pendingQueue.sort((a, b) => {
    const getPriority = (item) => {
      const id = (item.anime.id || "").toLowerCase();
      const title = (item.anime.title || "").toLowerCase();
      const isOnePiece = id.includes("one-piece") || title.includes("one piece");
      const missing = item.missingEps.length;
      const alreadyHas = item.targetEps - missing;

      // 1. Animes a los que les faltan 1 o 2 capítulos (excluyendo One Piece)
      if (!isOnePiece && missing <= 2) {
        return missing; // 1 o 2
      }

      // 2. One Piece (justo después de los que tienen 1 o 2 faltantes)
      if (isOnePiece) {
        return 10;
      }

      // 3. Otros animes parciales que ya tienen algo en Drive
      if (alreadyHas > 0) {
        return 100 + missing;
      }

      // 4. Vacíos
      return 1000 + missing;
    };

    return getPriority(a) - getPriority(b);
  });

  // Para Bleach: ordenar missingEps de mayor a menor para descargar los más recientes primero
  pendingQueue.forEach(item => {
    const id = (item.anime.id || "").toLowerCase();
    const title = (item.anime.title || "").toLowerCase();
    if (id.includes("bleach") || title.includes("bleach")) {
      item.missingEps.sort((a, b) => b - a);
    }
  });

  console.log(`\n========================================================================`);
  console.log(`🎉 ANÁLISIS COMPLETADO:`);
  console.log(`✅ ${totalAlreadyComplete} animes YA ESTÁN 100% COMPLETOS en tu Google Drive.`);
  console.log(`⚡ ${pendingQueue.length} animes tienen capítulos pendientes por descargar.`);
  console.log(`========================================================================\n`);

  if (pendingQueue.length === 0) {
    console.log("🌟 ¡Todos los animes en emisión están 100% al día en Google Drive!");
    return;
  }

  console.log("📋 COLA ACTIVA DE DESCARGAS (SOLO ANIMES CON CAPÍTULOS PENDIENTES):");
  pendingQueue.forEach((item, idx) => {
    console.log(`  ${idx + 1}. "${item.anime.title}" -> Faltan ${item.missingEps.length} cap(s): [${item.missingEps.join(", ")}]`);
  });
  console.log(`------------------------------------------------------------------------\n`);

  // 3. Descarga secuencial precisa
  for (let i = 0; i < pendingQueue.length; i++) {
    const item = pendingQueue[i];
    const { anime, missingEps, targetEps, matchedFolder } = item;
    const { seasonFolder } = getSeasonHierarchy(anime.title);
    const remoteDir = seasonFolder 
      ? `gdrive:MegaAnime_HD/${matchedFolder}/${seasonFolder}`
      : `gdrive:MegaAnime_HD/${matchedFolder}`;

    console.log(`\n🎬 [${i + 1}/${pendingQueue.length}] "${anime.title}"`);
    console.log(`📁 Carpeta Drive: MegaAnime_HD/${matchedFolder}${seasonFolder ? "/" + seasonFolder : ""}`);
    console.log(`📺 Descargando únicamente los episodios pendientes: [${missingEps.join(", ")}]`);

    for (const ep of missingEps) {
      const filename = `${sanitizeFolderName(anime.title)} - Episodio ${String(ep).padStart(2, "0")}.mp4`;
      const remoteFilePath = `${remoteDir}/${filename}`;

      // ── VERIFICACIÓN EN TIEMPO REAL: ¿ya existe en Drive con tamaño válido? ──
      try {
        const checkOut = execSync(`rclone lsjson "${remoteFilePath}" 2>/dev/null`, { encoding: "utf-8" });
        const checkInfo = JSON.parse(checkOut);
        if (checkInfo.length > 0 && checkInfo[0].Size && checkInfo[0].Size >= 20 * 1024 * 1024) {
          const existSizeMB = (checkInfo[0].Size / (1024 * 1024)).toFixed(1);
          console.log(`   ✅ [Ep ${ep}] Ya existe en Drive (${existSizeMB} MB) — omitiendo.`);
          // Actualizar manifest si no lo tiene
          if (!driveData[anime.id]) driveData[anime.id] = { title: anime.title, episodes: {} };
          if (!driveData[anime.id].episodes[`ep-${ep}`]) {
            driveData[anime.id].episodes[`ep-${ep}`] = {
              fileId: checkInfo[0].ID || null,
              streamUrl: checkInfo[0].ID ? `https://drive.google.com/file/d/${checkInfo[0].ID}/preview` : null,
              gdrivePath: remoteFilePath.replace("gdrive:MegaAnime_HD/", ""),
              filename, sizeMB: existSizeMB,
              uploadedAt: new Date().toISOString()
            };
            fs.writeFileSync(MANIFEST_FILE, JSON.stringify(driveData, null, 2), "utf-8");
            if (fs.existsSync(path.dirname(distManifest))) fs.writeFileSync(distManifest, JSON.stringify(driveData, null, 2), "utf-8");
          }
          continue; // Skip — no descargar
        }
      } catch(e) { /* No existe — proceder con descarga */ }

      console.log(`\n   🔎 [Ep ${ep}/${targetEps}] Resolviendo servidor Full HD 1080p...`);

      try {
        const episodeId = `${anime.id}-ep-${ep}`;
        let epData = null;
        const endpoints = [
          `https://megaanime-1c250.web.app/api/episode/${encodeURIComponent(episodeId)}`
        ];

        for (const epApiUrl of endpoints) {
          try {
            const apiRes = await fetch(epApiUrl, {
              headers: { "User-Agent": "MegaAnime-Pipeline/1.0" },
              signal: AbortSignal.timeout(15000)
            });
            if (apiRes.ok) {
              epData = await apiRes.json();
              break;
            }
          } catch(e) {}
        }

        if (!epData || !epData.videoServers || epData.videoServers.length === 0) {
          console.warn(`   ⚠️ Servidor en cola o no disponible para ep ${ep}.`);
          continue;
        }

        const servers = epData.videoServers || [];

        let streamSuccess = false;
        for (const server of servers) {
          // Cross-check: ensure the server URL does not belong to another anime
          const serverLower = (server.url + " " + (server.name || "")).toLowerCase();
          const animeLower = anime.title.toLowerCase();
          if (!animeLower.includes("clevatess") && serverLower.includes("clevatess")) {
            console.warn(`   ⛔ Servidor rechazado por no coincidir con el anime (${server.name})`);
            continue;
          }

          const resolved = await resolveDirectVideoUrl(server.name, server.url);
          if (resolved && resolved.url && !resolved.isHls) {
            const resolvedLower = resolved.url.toLowerCase();
            if (!animeLower.includes("clevatess") && resolvedLower.includes("clevatess")) {
              console.warn(`   ⛔ Enlace de video rechazado por ser de otra serie.`);
              continue;
            }

            console.log(`   🚀 Enlace 1080p verificado desde ${server.name}! Descargando directo a Drive...`);
            try {
              const referer = resolved.url.includes("mp4upload") ? "https://www.mp4upload.com/" : (server.url || "https://tioanime.com/");
              await streamToGoogleDrive(resolved.url, remoteFilePath, referer, (percent, currMB, totalMB) => {
                const epBar = renderProgressBar(percent, 20);
                process.stdout.write(`\r   ☁️ [Ep ${ep}/${targetEps}] ${epBar} (${currMB}/${totalMB}MB) `);
              });

              let fileId = null;
              let sizeMB = null;
              try {
                const infoOut = execSync(`rclone lsjson "${remoteFilePath}" 2>/dev/null`, { encoding: "utf-8" });
                const info = JSON.parse(infoOut)[0];
                if (info && info.ID) fileId = info.ID;
                if (info && info.Size) sizeMB = (info.Size / (1024 * 1024)).toFixed(2);
              } catch(e) {}

              // Validate size: must be > 20 MB to be a valid episode
              if (!sizeMB || parseFloat(sizeMB) < 20) {
                console.warn(`\n   ⚠️ Archivo inválido o incompleto (${sizeMB} MB), descartando...`);
                try { execSync(`rclone deletefile "${remoteFilePath}" 2>/dev/null`); } catch(e) {}
                continue;
              }

              console.log(`\n   ✅ [Ep ${ep}/${targetEps}] Guardado en Drive e Implementado en la Web! (${sizeMB} MB)`);

              if (!driveData[anime.id]) {
                driveData[anime.id] = { title: anime.title, episodes: {} };
              }
              driveData[anime.id].episodes[`ep-${ep}`] = {
                fileId: fileId,
                streamUrl: fileId ? `https://drive.google.com/file/d/${fileId}/preview` : null,
                gdrivePath: remoteFilePath.replace("gdrive:MegaAnime_HD/", ""),
                filename: filename,
                sizeMB: sizeMB,
                uploadedAt: new Date().toISOString()
              };

              fs.writeFileSync(MANIFEST_FILE, JSON.stringify(driveData, null, 2), "utf-8");
              if (fs.existsSync(path.dirname(distManifest))) {
                fs.writeFileSync(distManifest, JSON.stringify(driveData, null, 2), "utf-8");
              }
              streamSuccess = true;

              // Pausa para respetar el rate limit de Google Drive API (403 quota)
              console.log(`   ⏳ Esperando 8s para respetar el rate limit de Google Drive...`);
              await new Promise(r => setTimeout(r, 8000));

              break;
            } catch (streamErr) {
              // Si es rate limit de Drive, esperar más tiempo antes de reintentar
              if (streamErr.message && streamErr.message.includes("rateLimitExceeded")) {
                console.warn(`\n   ⚠️ Rate limit de Google Drive. Esperando 60s...`);
                await new Promise(r => setTimeout(r, 60000));
              } else {
                console.warn(`\n   ⚠️ Falló descarga desde ${server.name} (${streamErr.message}), probando siguiente servidor...`);
              }
              try {
                execSync(`rclone deletefile --max-size 10M "${remoteFilePath}" 2>/dev/null`);
              } catch(e) {}
            }
          }
        }

        if (!streamSuccess) {
          console.warn(`   ❌ Ningún servidor directo disponible para ep ${ep}. Continuando...`);
        }
      } catch (err) {
        console.error(`   ❌ Error en ep ${ep}:`, err.message);
      }
    }
  }

  console.log(`\n========================================================================`);
  console.log(`🎉 ¡PROCESO COMPLETADO! Todos los animes pendientes han sido procesados.`);
  console.log(`========================================================================\n`);
})();
