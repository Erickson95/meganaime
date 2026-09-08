const fs = require("fs");
const path = require("path");
const https = require("https");
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

const MANIFEST_PATH = path.join(process.cwd(), "src/data/drive_episodes.json");
const R2_PATH = path.join(process.cwd(), "src/data/r2_episodes.json");
const DIST_R2_PATH = path.join(process.cwd(), "dist/r2_episodes.json");
const TEMP_FILE = path.join(process.cwd(), "downloads/temp_r2_transfer.mp4");

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

function downloadDriveFile(fileId, targetPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getAccessToken();
      const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const outStream = fs.createWriteStream(targetPath);

      https.get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Drive download status ${res.statusCode}`));
        }
        res.pipe(outStream);
        outStream.on("finish", () => resolve());
        outStream.on("error", reject);
        res.on("error", reject);
      }).on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

function uploadToR2(localPath, r2FileName) {
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const cmd = `rclone copyto "${localPath}" ":s3:${R2_BUCKET_NAME}/${r2FileName}" --s3-provider Cloudflare --s3-access-key-id ${R2_ACCESS_KEY_ID} --s3-secret-access-key ${R2_SECRET_ACCESS_KEY} --s3-endpoint ${endpoint} --s3-no-check-bucket`;
  execSync(cmd, { stdio: "pipe" });
}

function updateR2Manifest(seriesKey, epKey, r2Url) {
  const paths = [R2_PATH, DIST_R2_PATH];
  for (const p of paths) {
    try {
      let data = {};
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, "utf-8"));
      }
      if (!data[seriesKey]) {
        data[seriesKey] = { title: "Bleach: Thousand-Year Blood War", episodes: {} };
      }
      data[seriesKey].episodes[epKey] = {
        url: r2Url,
        name: "⚡ MegaAnime PRO (Ultra HD)"
      };
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("Failed updating manifest at " + p, e);
    }
  }
}

async function main() {
  if (!fs.existsSync("downloads")) {
    fs.mkdirSync("downloads", { recursive: true });
  }

  const driveData = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const bleach = driveData["tioanime-bleach-sennen-kessenhen"] || driveData["bleach-sennen-kessen-hen"];

  let r2Data = {};
  if (fs.existsSync(R2_PATH)) {
    r2Data = JSON.parse(fs.readFileSync(R2_PATH, "utf-8"));
  }
  const existingR2 = r2Data["tioanime-bleach-sennen-kessenhen"]?.episodes || {};

  const allEps = Object.keys(bleach.episodes || {}).sort((a, b) => {
    return parseInt(a.replace("ep-", ""), 10) - parseInt(b.replace("ep-", ""), 10);
  });

  const pendingEps = allEps.filter(epKey => !existingR2[epKey]);

  console.log(`\n======================================================`);
  console.log(`INICIANDO TRANSFERENCIA DE BLEACH A CLOUDFLARE R2`);
  console.log(`Episodios totales en Drive: ${allEps.length}`);
  console.log(`Episodios ya en Cloudflare R2: ${Object.keys(existingR2).length}`);
  console.log(`Episodios pendientes por subir: ${pendingEps.length}`);
  console.log(`======================================================\n`);

  let count = 0;
  for (const epKey of pendingEps) {
    count++;
    const epNum = epKey.replace("ep-", "");
    const epObj = bleach.episodes[epKey];
    const fileId = epObj.fileId;
    const r2FileName = `bleach-tybw-ep${epNum.padStart(2, "0")}.mp4`;
    const r2Url = `${R2_PUBLIC_URL}/${r2FileName}`;

    console.log(`[${count}/${pendingEps.length}] Procesando Capítulo ${epNum} (File ID: ${fileId}, ${epObj.sizeMB || "160"} MB)...`);

    try {
      const startDl = Date.now();
      process.stdout.write(`   Descargando desde Google Drive... `);
      await downloadDriveFile(fileId, TEMP_FILE);
      const dlSec = ((Date.now() - startDl) / 1000).toFixed(1);
      process.stdout.write(`Listo (${dlSec}s)\n`);

      const startUp = Date.now();
      process.stdout.write(`   Subiendo a Cloudflare R2 (${r2FileName})... `);
      uploadToR2(TEMP_FILE, r2FileName);
      const upSec = ((Date.now() - startUp) / 1000).toFixed(1);
      process.stdout.write(`Listo (${upSec}s)\n`);

      updateR2Manifest("tioanime-bleach-sennen-kessenhen", epKey, r2Url);
      updateR2Manifest("bleach-sennen-kessen-hen", epKey, r2Url);

      if (fs.existsSync(TEMP_FILE)) {
        fs.unlinkSync(TEMP_FILE);
      }

      console.log(`   ✅ Capítulo ${epNum} conectado a Cloudflare R2: ${r2Url}\n`);
    } catch (err) {
      console.error(`   ❌ Error procesando capítulo ${epNum}:`, err.message);
      if (fs.existsSync(TEMP_FILE)) {
        try { fs.unlinkSync(TEMP_FILE); } catch (e) {}
      }
    }
  }

  console.log(`\n🎉 Transferencia completa. Todos los capítulos disponibles en Drive han sido transferidos a Cloudflare R2.`);
}

main().catch(err => {
  console.error("Fatal transfer error:", err);
  process.exit(1);
});
