const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
require("dotenv").config();

const filePath = process.argv[2] || path.join(process.cwd(), "downloads/bleach-tybw-ep46.mp4");
const accountId = process.env.R2_ACCOUNT_ID || process.argv[3];
const accessKey = process.env.R2_ACCESS_KEY_ID || "62c7d646b2c150ad4a830efd232b7299";
const secretKey = process.env.R2_SECRET_ACCESS_KEY || "70cf95ac2f3ecafef5de58fc03a0e17f455679234d0d4a6f2d551783deeafe97";
const bucket = process.env.R2_BUCKET_NAME || "megaanime-videos";

if (!fs.existsSync(filePath)) {
  console.error(`Error: File does not exist at ${filePath}`);
  process.exit(1);
}

if (!accountId) {
  console.log("\n=======================================================");
  console.log("CLOUDFLARE ACCOUNT ID REQUERIDO PARA SUBIDA AUTOMÁTICA");
  console.log("=======================================================");
  console.log("Para subir directamente por terminal/script necesitas tu Account ID.");
  console.log("Lo encuentras en la URL de tu panel de Cloudflare:");
  console.log("https://dash.cloudflare.com/<TU_ACCOUNT_ID>/r2/overview");
  console.log("\nUso:");
  console.log(`node scripts/upload_to_r2.cjs "${filePath}" <TU_ACCOUNT_ID>`);
  console.log("=======================================================\n");
  process.exit(0);
}

const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
const fileName = path.basename(filePath);

console.log(`Subiendo ${fileName} (${(fs.statSync(filePath).size / (1024 * 1024)).toFixed(2)} MB) al bucket "${bucket}" en Cloudflare R2...`);

try {
  // Use rclone with S3 Cloudflare provider
  const cmd = `rclone copyto "${filePath}" ":s3,provider=Cloudflare,access_key_id=${accessKey},secret_access_key=${secretKey},endpoint=${endpoint}:${bucket}/${fileName}" -P`;
  execSync(cmd, { stdio: "inherit" });
  console.log(`\n¡Subida completada con éxito!`);
  console.log(`URL pública: ${process.env.R2_PUBLIC_URL || "https://pub-29ed66174d0d4ea1babf7251b145577a.r2.dev"}/${fileName}`);
} catch (err) {
  console.error("Error al subir a Cloudflare R2:", err.message);
  process.exit(1);
}
