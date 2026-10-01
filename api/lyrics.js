export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // 1. Clean primary artist (handles duets like "Yaakov Shwekey; Eliad")
  const mainArtist = artist.split(';')[0].split(',')[0].trim();

  // 2. Clean track title (strips remix tags, live tags, and brackets)
  const cleanedTitle = rawTitle
    .replace(/\(live.*?\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .trim();

  // 3. Separate Hebrew script and English/Transliterated parts
  const titleParts = cleanedTitle.split(/[-/]/).map(p => p.trim()).filter(Boolean);
  const hebrewParts = titleParts.filter(p => /[\u0590-\u05FF]/.test(p));
  const englishParts = titleParts.filter(p => !/[\u0590-\u05FF]/.test(p));

  // Build targeted search combinations
  const searchQueries = [];

  // Hebrew-first query if Hebrew text exists in title
  if (hebrewParts.length > 0) {
    searchQueries.push(`${mainArtist} ${hebrewParts.join(' ')}`);
    searchQueries.push(`${hebrewParts.join(' ')}`);
  }

  // English/Transliterated query
  if (englishParts.length > 0) {
    searchQueries.push(`${mainArtist} ${englishParts.join(' ')}`);
  }

  // Combined fallback query
  searchQueries.push(`${mainArtist} ${cleanedTitle}`);

  const uniqueQueries = [...new Set(searchQueries)];

  // Helper 1: Search LRCLIB Fuzzy
  async function searchLrclib(q) {
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[0].syncedLyrics || data[0].plainLyrics || null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Helper 2: Direct Genius Search
  async function searchGenius(q) {
    try {
      const res = await fetch(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      if (hits.length === 0) return null;

      const pageRes = await fetch(hits[0].result.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const html = await pageRes.text();

      const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let matches = [];
      let match;
      while ((match = containerRegex.exec(html)) !== null) {
        matches.push(match[1]);
      }
      if (matches.length === 0) return null;

      return matches.join('\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim();
    } catch (e) {
      return null;
    }
  }

  // Helper 3: Search Web Fallback (DuckDuckGo Search with "מילים")
  async function searchWebFallback(artistName, songName) {
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      const html = await res.text();

      // Find first Genius link in search results
      const geniusUrlMatch = html.match(/https?:\/\/(?:[a-z]+\.)?genius\.com\/[^"&]+/i);
      if (geniusUrlMatch) {
        const pageRes = await fetch(geniusUrlMatch[0], {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const pageHtml = await pageRes.text();
        const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
        let matches = [];
        let match;
        while ((match = containerRegex.exec(pageHtml)) !== null) {
          matches.push(match[1]);
        }
        if (matches.length > 0) {
          return matches.join('\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&#x27;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .trim();
        }
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Process queries sequentially across providers
  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult) return res.status(200).json({ lyrics: lrclibResult, source: 'lrclib' });

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius' });
  }

  // Final fallback: Web Search with Hebrew search keyword "מילים"
  const webResult = await searchWebFallback(mainArtist, cleanedTitle);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-fallback' });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
