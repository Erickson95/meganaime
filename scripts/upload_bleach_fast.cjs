const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "03eb7e551485a689e275c860ff7bc91f";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "62c7d646b2c150ad4a830efd232b7299";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "70cf95ac2f3ecafef5de58fc03a0e17f455679234d0d4a6f2d551783deeafe97";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "megaanime-videos";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "https://pub-29ed66174d0d4ea1babf7251b145577a.r2.dev";

const FOLDER = "bleach-sennen-kessenhen";
const MANIFEST_PATH = path.join(process.cwd(), "src/data/drive_episodes.json");
const R2_PATH = path.join(process.cwd(), "src/data/r2_episodes.json");
const DIST_R2_PATH = path.join(process.cwd(), "dist/r2_episodes.json");

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
      if (fs.existsSync(p)) data = JSON.parse(fs.readFileSync(p, "utf-8"));
      for (const sk of seriesKeys) {
        if (!data[sk]) data[sk] = { title: "Bleach: Thousand-Year Blood War", episodes: {} };
        if (!data[sk].episodes) data[sk].episodes = {};
        data[sk].episodes[epKey] = {
          url: r2Url,
          name: "⚡ MegaAnime PRO (Ultra HD)"
        };
      }
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn("Manifest update err:", e.message);
    }
  }
}

async function main() {
  if (!fs.existsSync("downloads")) fs.mkdirSync("downloads", { recursive: true });

  const driveData = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  const bleach = driveData["tioanime-bleach-sennen-kessenhen"] || driveData["bleach-sennen-kessen-hen"];

  let r2Data = {};
  if (fs.existsSync(R2_PATH)) r2Data = JSON.parse(fs.readFileSync(R2_PATH, "utf-8"));
  const existingR2 = r2Data["tioanime-bleach-sennen-kessenhen"]?.episodes || {};

  const allDriveEps = Object.keys(bleach.episodes || {}).sort((a, b) => {
    return parseInt(a.replace("ep-", ""), 10) - parseInt(b.replace("ep-", ""), 10);
  });

  const pending = allDriveEps.filter(epKey => !existingR2[epKey]);

  console.log("==================================================================");
  console.log(`SUBIENDO EPISODIOS DE BLEACH A CLOUDFLARE R2 (${FOLDER}/)`);
  console.log(`Disponibles en Drive: ${allDriveEps.length}`);
  console.log(`Ya en Cloudflare R2: ${Object.keys(existingR2).length}`);
  console.log(`Pendientes de subir: ${pending.length}`);
  console.log("==================================================================\n");

  let count = 0;
  for (const epKey of pending) {
    count++;
    const epNum = epKey.replace("ep-", "");
    const epObj = bleach.episodes[epKey];
    const fileId = epObj.fileId;
    const s3Key = `${FOLDER}/bleach-tybw-ep${epNum.padStart(2, "0")}.mp4`;
    const r2Url = `${R2_PUBLIC_URL}/${s3Key}`;
    const tempFile = path.join(process.cwd(), `downloads/temp_fast_${epNum}.mp4`);

    console.log(`[${count}/${pending.length}] Procesando Capítulo ${epNum} (File ID: ${fileId})...`);

    try {
      // 1. Download via direct usercontent URL with curl (fast and robust)
      process.stdout.write(`   Descargando desde Drive (directo)... `);
      const startDl = Date.now();
      const dlUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
      execSync(`curl -L -s --max-time 120 -o "${tempFile}" "${dlUrl}"`);
      
      if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size < 10000000) {
        throw new Error("Archivo descargado inválido o incompleto");
      }
      const dlSec = ((Date.now() - startDl) / 1000).toFixed(1);
      const sizeMB = (fs.statSync(tempFile).size / (1024 * 1024)).toFixed(1);
      console.log(`Listo (${dlSec}s, ${sizeMB} MB)`);

      // 2. Upload to Cloudflare R2 inside folder
      process.stdout.write(`   Subiendo a Cloudflare R2 (${s3Key})... `);
      const startUp = Date.now();
      uploadToR2(tempFile, s3Key);
      const upSec = ((Date.now() - startUp) / 1000).toFixed(1);
      console.log(`Listo (${upSec}s)`);

      // 3. Update manifest
      updateManifest(epKey, r2Url);
      console.log(`   ✅ Cap ${epNum} listo en Cloudflare: ${r2Url}\n`);

      // 4. Delete temp file
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

      // Cooldown 1s
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`   ❌ Error en cap ${epNum}:`, err.message);
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      }
    }
  }

  console.log("🎉 Transferencia de episodios de Drive completada.");
}

main().catch(console.error);
