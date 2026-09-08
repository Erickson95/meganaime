const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execSync } = require("child_process");
require("dotenv").config();

const GDRIVE_CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const GDRIVE_CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const GDRIVE_REFRESH_TOKEN = process.env.GDRIVE_REFRESH_TOKEN;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "03eb7e551485a689e275c860ff7bc91f";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "62c7d646b2c150ad4a830efd232b7299";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "70cf95ac2f3ecafef5de58fc03a0e17f455679234d0d4a6f2d551783deeafe97";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "megaanime-videos";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "https://pub-29ed66174d0d4ea1babf7251b145577a.r2.dev";

const FOLDER_NAME = "bleach-sennen-kessenhen";
const DRIVE_MANIFEST_PATH = path.join(process.cwd(), "src/data/drive_episodes.json");
const R2_PATH = path.join(process.cwd(), "src/data/r2_episodes.json");
const DIST_R2_PATH = path.join(process.cwd(), "dist/r2_episodes.json");

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }
  const params = new URLSearchParams({
    client_id: GDRIVE_CLIENT_ID,
    client_secret: GDRIVE_CLIENT_SECRET,
    refresh_token: GDRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Failed to get Google Drive access token: " + JSON.stringify(data));
  }
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + ((data.expires_in || 3600) * 1000);
  return cachedToken;
}

function downloadStreamToFile(url, headers, targetPath) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https:");
    const client = isHttps ? https : http;
    const req = client.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith("http")) {
          const u = new URL(url);
          redirectUrl = `${u.protocol}//${u.host}${redirectUrl}`;
        }
        return downloadStreamToFile(redirectUrl, headers, targetPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        return reject(new Error(`Download failed with status ${res.statusCode}`));
      }
      const outStream = fs.createWriteStream(targetPath);
      res.pipe(outStream);
      outStream.on("finish", () => {
        outStream.close();
        resolve();
      });
      outStream.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function downloadFromDrive(fileId, targetPath, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = await getAccessToken();
      const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      await downloadStreamToFile(url, { Authorization: `Bearer ${token}` }, targetPath);
      return true;
    } catch (e) {
      console.warn(`      (Drive intento ${attempt}/${retries} falló: ${e.message})`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  return false;
}

async function downloadFromScraper(epNum, targetPath) {
  try {
    const pageUrl = `https://tioanime.com/ver/bleach-sennen-kessenhen-${epNum}`;
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return false;
    const html = await res.text();
    const m = html.match(/var videos = (\[.*?\]);/);
    if (!m) return false;

    const videos = JSON.parse(m[1]);
    const yup = videos.find(v => v[0] === "YourUpload");
    if (yup && yup[1]) {
      const yupRes = await fetch(yup[1], {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://tioanime.com/" },
        signal: AbortSignal.timeout(10000)
      });
      if (yupRes.ok) {
        const yupHtml = await yupRes.text();
        const mp4Match = yupHtml.match(/file\s*:\s*["\x27](https?:\/\/[^"\x27]+\.mp4[^"\x27]*)["\x27]/i)
                      || yupHtml.match(/src\s*:\s*["\x27](https?:\/\/[^"\x27]+\.mp4[^"\x27]*)["\x27]/i)
                      || yupHtml.match(/(https?:\/\/[^"\\\x27`\s]+\.mp4\b[^"\\\x27`\s]*)/i);
        if (mp4Match) {
          const directUrl = mp4Match[1];
          await downloadStreamToFile(directUrl, {
            "User-Agent": "Mozilla/5.0",
            "Referer": yup[1]
          }, targetPath);
          return true;
        }
      }
    }
  } catch (err) {
    console.warn(`      (Scraper error para cap ${epNum}: ${err.message})`);
  }
  return false;
}

function uploadToR2(localPath, s3Key) {
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const cmd = `rclone copyto "${localPath}" ":s3:${R2_BUCKET_NAME}/${s3Key}" --s3-provider Cloudflare --s3-access-key-id ${R2_ACCESS_KEY_ID} --s3-secret-access-key ${R2_SECRET_ACCESS_KEY} --s3-endpoint ${endpoint} --s3-no-check-bucket`;
  execSync(cmd, { stdio: "pipe" });
}

function updateManifest(epKey, r2Url) {
  const seriesKeys = ["tioanime-bleach-sennen-kessenhen", "bleach-sennen-kessen-hen"];
  const paths = [R2_PATH, DIST_R2_PATH];

  for (const p of paths) {
    try {
      let data = {};
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, "utf-8"));
      }
      for (const sk of seriesKeys) {
        if (!data[sk]) {
          data[sk] = { title: "Bleach: Thousand-Year Blood War", episodes: {} };
        }
        if (!data[sk].episodes) data[sk].episodes = {};
        data[sk].episodes[epKey] = {
          url: r2Url,
          name: "⚡ MegaAnime PRO (Ultra HD)"
        };
      }
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("Failed to update " + p, e.message);
    }
  }
}

async function main() {
  if (!fs.existsSync("downloads")) {
    fs.mkdirSync("downloads", { recursive: true });
  }

  const driveData = JSON.parse(fs.readFileSync(DRIVE_MANIFEST_PATH, "utf-8"));
  const bleachDrive = driveData["tioanime-bleach-sennen-kessenhen"] || driveData["bleach-sennen-kessen-hen"] || { episodes: {} };

  let r2Data = {};
  if (fs.existsSync(R2_PATH)) {
    r2Data = JSON.parse(fs.readFileSync(R2_PATH, "utf-8"));
  }
  const existingR2 = r2Data["tioanime-bleach-sennen-kessenhen"]?.episodes || {};

  console.log("==================================================================");
  console.log("SUBIENDO TODOS LOS 47 CAPÍTULOS DE BLEACH A CLOUDFLARE R2");
  console.log(`Carpeta de destino en R2: ${FOLDER_NAME}/`);
  console.log(`Capítulos ya en Cloudflare: ${Object.keys(existingR2).length} de 47`);
  console.log("==================================================================\n");

  const totalEpisodes = 47;

  for (let epNum = 1; epNum <= totalEpisodes; epNum++) {
    const epKey = `ep-${epNum}`;
    const s3Key = `${FOLDER_NAME}/bleach-tybw-ep${String(epNum).padStart(2, "0")}.mp4`;
    const r2Url = `${R2_PUBLIC_URL}/${s3Key}`;

    // Verify if already present and points to the folder URL
    if (existingR2[epKey] && existingR2[epKey].url && existingR2[epKey].url.includes(FOLDER_NAME)) {
      console.log(`[${epNum}/${totalEpisodes}] Cap ${epNum} ya está en Cloudflare R2 (${FOLDER_NAME}/) ✅`);
      continue;
    }

    console.log(`[${epNum}/${totalEpisodes}] Procesando Capítulo ${epNum}...`);
    const tempFile = path.join(process.cwd(), `downloads/temp_ep${epNum}.mp4`);

    try {
      let downloaded = false;
      const driveEp = bleachDrive.episodes && bleachDrive.episodes[epKey];

      // 1. Try Google Drive if available in manifest
      if (driveEp && driveEp.fileId) {
        process.stdout.write(`   1. Descargando desde Google Drive (${driveEp.fileId})... `);
        const start = Date.now();
        downloaded = await downloadFromDrive(driveEp.fileId, tempFile);
        if (downloaded) {
          const sec = ((Date.now() - start) / 1000).toFixed(1);
          const sizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
          console.log(`Listo (${sec}s, ${sizeMB} MB)`);
        } else {
          console.log(`Fallo Drive`);
        }
      }

      // 2. Fallback to Scraper (YourUpload / Voe) if not downloaded yet
      if (!downloaded || !fs.existsSync(tempFile) || fs.statSync(tempFile).size < 10000000) {
        process.stdout.write(`   2. Descargando stream directo vía TioAnime/YourUpload... `);
        const start = Date.now();
        downloaded = await downloadFromScraper(epNum, tempFile);
        if (downloaded && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000000) {
          const sec = ((Date.now() - start) / 1000).toFixed(1);
          const sizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
          console.log(`Listo (${sec}s, ${sizeMB} MB)`);
        } else {
          console.log(`Fallo Scraper`);
        }
      }

      if (!downloaded || !fs.existsSync(tempFile) || fs.statSync(tempFile).size < 10000000) {
        console.error(`   ❌ No se pudo descargar el capítulo ${epNum}`);
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        continue;
      }

      // 3. Upload to Cloudflare R2 inside folder
      process.stdout.write(`   Subiendo a Cloudflare R2 (${s3Key})... `);
      const startUp = Date.now();
      uploadToR2(tempFile, s3Key);
      const upSec = ((Date.now() - startUp) / 1000).toFixed(1);
      console.log(`Listo (${upSec}s)`);

      // 4. Update manifest
      updateManifest(epKey, r2Url);
      console.log(`   ✅ Cap ${epNum} enlazado a Cloudflare: ${r2Url}\n`);

      // 5. Clean up temp file
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      // Small cooldown to prevent rate limits
      await new Promise(r => setTimeout(r, 1200));

    } catch (err) {
      console.error(`   ❌ Error procesando cap ${epNum}:`, err.message);
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
    }
  }

  console.log("\n==================================================================");
  console.log("🎉 Proceso completado. Todos los capítulos disponibles están en Cloudflare R2.");
  console.log("==================================================================");
}

main().catch(console.error);
