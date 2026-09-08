const fs = require("fs");
const path = require("path");
const https = require("https");
require("dotenv").config();

async function downloadFile() {
  const fileId = "135j4vZBDKRaAt0R5tP235_6xKtGVBe2w";
  const targetPath = path.join(process.cwd(), "downloads/bleach-tybw-ep46.mp4");

  console.log("Getting OAuth2 access token for Google Drive...");
  const tokenParams = new URLSearchParams({
    client_id: process.env.GDRIVE_CLIENT_ID,
    client_secret: process.env.GDRIVE_CLIENT_SECRET,
    refresh_token: process.env.GDRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });

  const tRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString()
  });
  const tData = await tRes.json();
  if (!tData.access_token) {
    throw new Error("Failed to get access token: " + JSON.stringify(tData));
  }

  console.log(`Starting download of ${fileId} to ${targetPath}...`);
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const outStream = fs.createWriteStream(targetPath);

  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        Authorization: `Bearer ${tData.access_token}`
      }
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`Drive responded with status ${res.statusCode}`));
      }

      const totalBytes = parseInt(res.headers["content-length"] || "167862530", 10);
      let downloadedBytes = 0;
      let lastReport = Date.now();

      res.on("data", (chunk) => {
        downloadedBytes += chunk.length;
        if (Date.now() - lastReport > 2000) {
          const pct = ((downloadedBytes / totalBytes) * 100).toFixed(1);
          const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
          const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
          console.log(`[Drive Download] ${pct}% (${mb} MB / ${totalMb} MB)`);
          lastReport = Date.now();
        }
      });

      res.pipe(outStream);

      outStream.on("finish", () => {
        console.log(`\nDownload completed successfully: ${targetPath} (${(downloadedBytes / (1024 * 1024)).toFixed(2)} MB)`);
        resolve(targetPath);
      });

      outStream.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
}

downloadFile()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Download failed:", err);
    process.exit(1);
  });
