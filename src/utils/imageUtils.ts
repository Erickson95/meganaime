import React from "react";
import { getApiUrl, isNativePlatform } from "./apiConfig";

/**
 * Generates a beautiful fallback image URL using a high-quality, branded SVG placeholder.
 * This features the anime's actual title in bold display typography and a modern custom theme palette,
 * ensuring that even if external CDNs fail, the card displays a pristine, official-looking asset.
 */
export function getAnimePlaceholder(title: string, isBanner: boolean = false): string {
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
  
  // Cap lines to prevent overflow
  const displayedLines = lines.slice(0, 4);
  
  // SVG Text blocks
  const textYStart = height / 2 - (displayedLines.length - 1) * (isBanner ? 22 : 18);
  const textElements = displayedLines.map((line, idx) => {
    const y = textYStart + idx * (isBanner ? 44 : 36);
    return `<text x="50%" y="${y}" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="${isBanner ? "36px" : "28px"}" letter-spacing="-0.02em">${escapeSvgText(line)}</text>`;
  }).join("\n");
  
  const svg = `
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
  `;
  
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Proxies external image URLs through our custom Express proxy route to bypass hotlinking and geo-blocking restrictions.
 * Robust against empty URLs, Unicode domains, and encoding failures.
 */
export function getProxyImageUrl(url: string | undefined, title: string = "Anime", isBanner: boolean = false): string {
  const trimmedUrl = (url || "").trim();

  // Return as-is if it's already a local data URI
  if (trimmedUrl.startsWith("data:")) {
    return trimmedUrl;
  }

  // Empty / obviously broken URL → serve the SVG placeholder directly from the client
  if (!trimmedUrl || trimmedUrl.length < 10) {
    return getAnimePlaceholder(title, isBanner);
  }

  // Direct HTTPS CDN URLs (AniList, TioAnime, Cloudinary, MyAnimeList, Imgur, Supabase, R2) load 100x faster directly without server proxy!
  if (
    trimmedUrl.startsWith("https://s4.anilist.co/") ||
    trimmedUrl.startsWith("https://tioanime.com/") ||
    trimmedUrl.startsWith("http://tioanime.com/") ||
    trimmedUrl.startsWith("https://cdn.myanimelist.net/") ||
    trimmedUrl.startsWith("https://artworks.thetvdb.com/") ||
    trimmedUrl.startsWith("https://images.unsplash.com/") ||
    trimmedUrl.startsWith("https://media.kitsu.io/") ||
    trimmedUrl.includes("r2.dev") ||
    trimmedUrl.startsWith("https://images.weserv.nl/") ||
    trimmedUrl.startsWith("https://wsrv.nl/") ||
    trimmedUrl.startsWith("https://res.cloudinary.com/") ||
    trimmedUrl.startsWith("https://i.imgur.com/") ||
    (isNativePlatform() && (trimmedUrl.startsWith("http://") || trimmedUrl.startsWith("https://")))
  ) {
    return trimmedUrl;
  }

  // If it's a relative path (already proxied), return as-is
  if (trimmedUrl.startsWith("/")) {
    return getApiUrl(trimmedUrl);
  }

  // Try base64 encoding for cleaner URL (avoids adblocker blocking external domain params)
  let encodedUrl: string;
  let useBase64 = true;
  try {
    // Safe base64 with Unicode support
    encodedUrl = btoa(unescape(encodeURIComponent(trimmedUrl)));
  } catch (e) {
    // Fall back to plain URI encoding if btoa fails (e.g. characters btoa can't handle)
    try {
      encodedUrl = encodeURIComponent(trimmedUrl);
      useBase64 = false;
    } catch (e2) {
      // Absolute fallback: return placeholder
      return getAnimePlaceholder(title, isBanner);
    }
  }

  const encodeParam = useBase64 ? "&encode=base64" : "";
  const bannerParam = isBanner || trimmedUrl.includes("banner") || trimmedUrl.includes("cover-large") || trimmedUrl.includes("bannerUrl") || trimmedUrl.includes("banner_url") ? "&isBanner=1" : "";
  return getApiUrl(`/api/image-proxy?url=${encodedUrl}${encodeParam}&title=${encodeURIComponent(title)}${bannerParam}`);
}


/**
 * Resolves and recovers a broken cover image by calling the server-side /api/resolve-cover route,
 * mutating the image element source in real-time.
 */
export async function recoverCoverImageInHotPath(
  e: React.SyntheticEvent<HTMLImageElement, Event>,
  title: string,
  animeId: string,
  mediaType?: "ANIME" | "MANGA"
): Promise<void> {
  const imgElement = e.currentTarget;
  // Disable onerror temporarily to prevent infinite loop recursion in case fallback fails
  imgElement.onerror = null;
  
  try {
    const isManga = mediaType === "MANGA" || animeId.startsWith("manga-") ? "MANGA" : "ANIME";
    const res = await fetch(`/api/resolve-cover?title=${encodeURIComponent(title)}&animeId=${encodeURIComponent(animeId)}&type=${isManga}`);
    if (res.ok) {
      const data = await res.json();
      if (data.coverUrl) {
        // Set the recovered cover using fast whitelist / proxy handler
        imgElement.src = getProxyImageUrl(trimmed, title);


        // NO-REGRESSION / SYNC FIX: Persist resolved cover back into the user's continue watching local storage cache
        try {
          const keys = Object.keys(localStorage);
          for (const key of keys) {
            if (key.startsWith("megaAnime_progress_")) {
              const raw = localStorage.getItem(key);
              if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed[animeId]) {
                  parsed[animeId].animeCoverUrl = trimmed;
                  localStorage.setItem(key, JSON.stringify(parsed));
                }
              }
            }
          }
        } catch (localErr) {
          console.warn("Failed to persist hot resolved cover inside progress cache:", localErr);
        }

        return;
      }
    }
  } catch (err) {
    console.warn(`Failed cover hot recovery for: ${title}`, err);
  }

  // Final fallback to beautiful dynamic SVG vector placeholder
  imgElement.src = getAnimePlaceholder(title, false);
}

