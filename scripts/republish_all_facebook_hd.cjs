const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

const pageId = process.env.FACEBOOK_PAGE_ID || "1375353446122077";
const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const CATALOG_PATH = path.join(__dirname, "../src/data/catalog.json");
const POSTED_FILE = path.join(__dirname, "../src/utils/facebook_posted.json");

if (!token || !pageId) {
  console.error("❌ Faltan credenciales de Facebook en .env");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));

function norm(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findAnimeInCatalog(rawTitle) {
  const tNorm = norm(rawTitle);
  let match = catalog.find(c => norm(c.title) === tNorm);
  if (match) return match;

  match = catalog.find(c => norm(c.title).includes(tNorm) || tNorm.includes(norm(c.title)));
  if (match) return match;

  const words = rawTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  for (const c of catalog) {
    const cTitleLower = (c.title || "").toLowerCase();
    const allWords = words.every(w => cTitleLower.includes(w));
    if (allWords) return c;
  }

  return null;
}

async function fetchImageBuffer(coverUrl) {
  if (!coverUrl) return null;
  try {
    let res = await fetch(coverUrl, {
      headers: {
        "Referer": coverUrl.includes("tioanime") ? "https://tioanime.com/" : "",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      res = await fetch(`https://mega-anime.com/api/image-proxy?url=${encodeURIComponent(coverUrl)}`, {
        signal: AbortSignal.timeout(10000)
      });
    }
    if (res.ok) {
      return await res.arrayBuffer();
    }
  } catch (e) {
    console.warn(`[Image Fetch] Error fetching cover ${coverUrl}:`, e.message);
  }
  return null;
}

async function run() {
  console.log("==================================================================");
  console.log("🚀 MEGAANIME — REPARADOR DE PORTADAS HD EN FACEBOOK 🚀");
  console.log("==================================================================");
  console.log(`Página ID: ${pageId}\n`);

  // 1. Escanear posts del feed desde ayer (2026-09-08) hasta hoy
  console.log("🔎 Paso 1: Escaneando publicaciones del feed...");
  let url = `https://graph.facebook.com/v19.0/${pageId}/feed?fields=id,message,created_time,full_picture,attachments&limit=100&access_token=${token}`;
  const badPosts = [];

  while (url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.data || data.data.length === 0) break;

    let reachedOlder = false;
    for (const p of data.data) {
      const created = new Date(p.created_time);
      // Sólo desde 2026-09-08 00:00 UTC
      if (created < new Date("2026-09-08T00:00:00Z")) {
        reachedOlder = true;
        break;
      }

      const isBad = (p.full_picture && p.full_picture.includes("external")) || !p.full_picture;
      if (isBad && p.message && p.message.includes("megaAnime")) {
        badPosts.push(p);
      }
    }
    if (reachedOlder) break;
    url = data.paging?.next;
  }

  console.log(`\n📊 Encontrados ${badPosts.length} posts con vista previa externa (logo genérico) para corregir.\n`);

  // Agrupar y preparar para republicar
  const uniqueItems = new Map();
  for (const p of badPosts) {
    const titleMatch = p.message.match(/🎬 Anime:\s*(.+)/);
    const epMatch = p.message.match(/📺\s*(?:Capítulo|Episodio)\s*(\d+)/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : "";
    const ep = epMatch ? parseInt(epMatch[1], 10) : 1;

    const anime = findAnimeInCatalog(rawTitle);
    const cleanTitle = anime ? anime.title : rawTitle;
    const cleanSlug = anime ? anime.id.replace(/^tioanime-/, "") : norm(rawTitle);
    const coverUrl = anime ? anime.coverUrl : null;
    const genres = anime?.genres || ["Anime", "HD"];
    const key = `${cleanSlug}-ep-${ep}`;

    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, {
        title: cleanTitle,
        ep: ep,
        slug: cleanSlug,
        coverUrl: coverUrl,
        genres: genres,
        postIdsToDelete: [p.id]
      });
    } else {
      uniqueItems.get(key).postIdsToDelete.push(p.id);
    }
  }

  console.log(`🎯 Se procesarán ${uniqueItems.size} episodios únicos para republicación Full HD.`);

  // 2. Eliminar posts malos
  console.log("\n🗑️  Paso 2: Eliminando publicaciones defectuosas de Facebook...");
  let deletedCount = 0;
  for (const item of uniqueItems.values()) {
    for (const pid of item.postIdsToDelete) {
      try {
        const delRes = await fetch(`https://graph.facebook.com/v19.0/${pid}?access_token=${token}`, {
          method: "DELETE"
        });
        const delData = await delRes.json();
        if (delData.success) {
          deletedCount++;
          process.stdout.write(`\r🗑️  Eliminados: ${deletedCount}/${badPosts.length} posts...`);
        }
      } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
  }
  console.log(`\n✅ Se eliminaron exitosamente ${deletedCount} posts defectuosos.\n`);

  // 3. Republicar con Foto Full HD
  console.log("📸 Paso 3: Republicando con portada oficial Full HD...");
  let postedCount = 0;
  let postedSet = new Set();
  try {
    if (fs.existsSync(POSTED_FILE)) {
      postedSet = new Set(JSON.parse(fs.readFileSync(POSTED_FILE, "utf8")));
    }
  } catch (e) {}

  for (const item of uniqueItems.values()) {
    const webUrl = `https://mega-anime.com/ver/${item.slug}?ep=${item.ep}`;
    const hashtag = item.title.replace(/[^a-zA-Z0-9]/g, "");
    const genresText = item.genres?.length ? `\n⭐ Géneros: ${item.genres.join(", ")}` : "";

    const caption = `🔥 ¡YA DISPONIBLE EN megaAnime SIN ANUNCIOS! 🔥\n\n` +
      `🎬 Anime: ${item.title}\n` +
      `📺 Capítulo ${item.ep}${genresText}\n` +
      `⚡ Servidor Exclusivo MegaAnime PRO HD (1080p Ultra HD)\n\n` +
      `🍿 ¡Disfrútalo ahora mismo en FULL HD nativo, con carga inmediata y sin molestos anuncios!\n\n` +
      `🌐 Ver Directo Aquí:\n${webUrl}\n\n` +
      `#megaAnime #AnimeEnEspañol #${hashtag} #EstrenosAnime #Otaku #AnimeHD #AnimeOnline`;

    console.log(`\n📌 [${postedCount + 1}/${uniqueItems.size}] Publicando: ${item.title} Ep ${item.ep}...`);

    let imgBuf = await fetchImageBuffer(item.coverUrl);
    if (!imgBuf || imgBuf.byteLength < 1000) {
      console.warn(`⚠️ No se pudo obtener buffer para ${item.title}, usando coverUrl directo...`);
    }

    try {
      let postRes;
      if (imgBuf && imgBuf.byteLength > 1000) {
        const formData = new FormData();
        formData.append("source", new Blob([imgBuf], { type: "image/jpeg" }), "cover.jpg");
        formData.append("caption", caption);
        formData.append("access_token", token);

        postRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          method: "POST",
          body: formData
        });
      } else if (item.coverUrl) {
        const params = new URLSearchParams();
        params.append("url", item.coverUrl);
        params.append("caption", caption);
        params.append("access_token", token);

        postRes = await fetch(`https://graph.facebook.com/v19.0/${pageId}/photos`, {
          method: "POST",
          body: params
        });
      }

      const resData = await postRes.json();
      if (resData && (resData.id || resData.post_id)) {
        const pid = resData.post_id || resData.id;
        console.log(`✅ Publicado con Foto HD! Post ID: ${pid}`);
        postedCount++;
        postedSet.add(`${item.slug}-ep-${item.ep}`);
      } else {
        console.warn(`❌ Error al publicar ${item.title} Ep ${item.ep}:`, resData);
      }
    } catch (e) {
      console.error(`❌ Excepción al publicar ${item.title}:`, e.message);
    }

    // Pausa para cuidar el rate limit de Meta
    await new Promise(r => setTimeout(r, 600));
  }

  try {
    fs.writeFileSync(POSTED_FILE, JSON.stringify(Array.from(postedSet), null, 2), "utf8");
  } catch (e) {}

  console.log("\n==================================================================");
  console.log(`🎉 PROCESO COMPLETADO: ${postedCount} episodios republicados con portada Full HD.`);
  console.log("==================================================================");
}

run().catch(console.error);
