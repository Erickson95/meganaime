import fs from 'fs';
import path from 'path';

const catalogPath = path.join(process.cwd(), 'src/data/catalog.json');
const distPath = path.join(process.cwd(), 'dist');
const sitemapPath = path.join(distPath, 'sitemap.xml');

let catalog = [];
try {
  if (fs.existsSync(catalogPath)) {
    catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  }
} catch (e) {
  console.error("Error reading catalog for sitemap:", e);
}

const todayStr = new Date().toISOString().split('T')[0];

let urlsXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://mega-anime.com/</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>`;

catalog.forEach(anime => {
  if (!anime.id) return;
  const cleanId = encodeURIComponent(anime.id);
  urlsXml += `
  <url>
    <loc>https://mega-anime.com/anime/${cleanId}</loc>
    <lastmod>${todayStr}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
});

urlsXml += `\n</urlset>`;

if (!fs.existsSync(distPath)) {
  fs.mkdirSync(distPath, { recursive: true });
}

const publicSitemapPath = path.join(process.cwd(), 'public/sitemap.xml');
if (fs.existsSync(publicSitemapPath)) {
  fs.copyFileSync(publicSitemapPath, sitemapPath);
  console.log(`[SEO] Preserved custom public/sitemap.xml to dist/sitemap.xml`);
  fs.writeFileSync(path.join(distPath, 'sitemap-catalog.xml'), urlsXml, 'utf8');
  console.log(`[SEO] Successfully generated dist/sitemap-catalog.xml with ${catalog.length + 1} URLs.`);
} else {
  fs.writeFileSync(sitemapPath, urlsXml, 'utf8');
  console.log(`[SEO] Successfully generated dist/sitemap.xml with ${catalog.length + 1} URLs.`);
}

// Pre-render static /ver/[clean-slug]/index.html for every anime with exact OpenGraph tags
const baseHtmlPath = path.join(distPath, 'index.html');
if (fs.existsSync(baseHtmlPath)) {
  const baseHtml = fs.readFileSync(baseHtmlPath, 'utf8');
  let verCount = 0;

  catalog.forEach(anime => {
    if (!anime.title) return;
    const cleanSlug = anime.title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const ogTitle = `${anime.title} - Ver Online en HD | megaAnime`;
    const ogDesc = anime.synopsis ? anime.synopsis.slice(0, 200) + "..." : `Disfruta de ${anime.title} en calidad Full HD 1080p sin anuncios en megaAnime.`;
    let ogImage = anime.coverUrl || "https://mega-anime.com/icon-512.png";
    if (ogImage.includes("tioanime.com")) {
      ogImage = `https://mega-anime.com/api/image-proxy?url=${encodeURIComponent(ogImage)}`;
    }
    const ogUrl = `https://mega-anime.com/ver/${cleanSlug}`;

    let pageHtml = baseHtml
      .replace(/<title>.*?<\/title>/i, `<title>${ogTitle}</title>`)
      .replace(/<meta property="og:title" content=".*?"\s*\/?>/i, `<meta property="og:title" content="${ogTitle}" />`)
      .replace(/<meta property="og:description" content=".*?"\s*\/?>/i, `<meta property="og:description" content="${ogDesc}" />`)
      .replace(/<meta property="og:image" content=".*?"\s*\/?>/i, `<meta property="og:image" content="${ogImage}" /><meta property="og:image:secure_url" content="${ogImage}" /><meta property="og:image:type" content="image/jpeg" /><meta property="og:image:width" content="600" /><meta property="og:image:height" content="800" />`)
      .replace(/<meta property="og:url" content=".*?"\s*\/?>/i, `<meta property="og:url" content="${ogUrl}" />`)
      .replace(/<meta name="twitter:image" content=".*?"\s*\/?>/i, `<meta name="twitter:image" content="${ogImage}" />`);

    const verDir = path.join(distPath, 'ver', cleanSlug);
    fs.mkdirSync(verDir, { recursive: true });
    fs.writeFileSync(path.join(verDir, 'index.html'), pageHtml, 'utf8');

    if (anime.id && anime.id !== cleanSlug) {
      const verIdDir = path.join(distPath, 'ver', anime.id);
      fs.mkdirSync(verIdDir, { recursive: true });
      fs.writeFileSync(path.join(verIdDir, 'index.html'), pageHtml, 'utf8');
    }
    verCount++;
  });

  console.log(`[SEO] Generated ${verCount} static /ver/[anime]/ pages with high-res OpenGraph metadata.`);
}
