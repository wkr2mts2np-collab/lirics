export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // Enable Vercel Edge Caching (Caches lyrics for 24h for instant Tesla loading)
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');

  // Strip Hebrew Nikud (Vowel points) that cause database mismatches
  function stripNikud(str) {
    return str.replace(/[\u0591-\u05C7]/g, '');
  }

  // 1. Clean primary artist and extract Last Name
  const mainArtist = artist.split(';')[0].split(',')[0].trim();
  const artistParts = mainArtist.split(' ');
  const artistLastName = artistParts.length > 1 ? artistParts[artistParts.length - 1] : mainArtist;

  // 2. Ultimate Title Cleaning
  const cleanedTitle = stripNikud(rawTitle)
    .replace(/\(live.*?\)/gi, '')
    .replace(/\(acoustic.*?\)/gi, '')
    .replace(/\(cover.*?\)/gi, '')
    .replace(/\(a cappella.*?\)/gi, '')
    .replace(/\(vocal.*?\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/feat\..*$/gi, '')
    .replace(/ft\..*$/gi, '')
    .replace(/מארח.*$/g, '')
    .replace(/בשיתוף.*$/g, '')
    .replace(/["'״]/g, '')
    .trim();

  // 3. Separate Hebrew script and English/Transliterated parts
  const titleParts = cleanedTitle.split(/[-/]/).map(p => p.trim()).filter(Boolean);
  const hebrewParts = titleParts.filter(p => /[\u0590-\u05FF]/.test(p));
  const englishParts = titleParts.filter(p => !/[\u0590-\u05FF]/.test(p));

  // Build targeted search combinations
  const searchQueries = [];

  if (hebrewParts.length > 0) {
    searchQueries.push(`${mainArtist} ${hebrewParts.join(' ')}`);
    searchQueries.push(`${artistLastName} ${hebrewParts.join(' ')}`);
  }

  if (englishParts.length > 0) {
    searchQueries.push(`${mainArtist} ${englishParts.join(' ')}`);
    searchQueries.push(`${artistLastName} ${englishParts.join(' ')}`);
  }

  searchQueries.push(`${mainArtist} ${cleanedTitle}`);
  searchQueries.push(`${artistLastName} ${cleanedTitle}`);

  const uniqueQueries = [...new Set(searchQueries)];

  // Text Cleaner & Line Normalizer
  function cleanLyricsText(rawText) {
    return rawText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\[.*?\]/g, '') 
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n') 
      .trim();
  }

  // Helper 1: Search LRCLIB Fuzzy (Prioritize Synced)
  async function searchLrclib(q) {
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      if (!response.ok) return null;
      const data = await response.json();
      
      if (Array.isArray(data) && data.length > 0) {
        const syncedMatch = data.find(track => track.syncedLyrics);
        if (syncedMatch) return { text: syncedMatch.syncedLyrics, type: 'synced' };
        if (data[0].plainLyrics) return { text: data[0].plainLyrics, type: 'plain' };
      }
    } catch (e) { return null; }
    return null;
  }

  // Helper 2: Direct Genius Search
  async function searchGenius(q) {
    try {
      const res = await fetch(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      
      const bestHit = hits.find(h => 
        !h.result.url.includes('-romanized-') && 
        !h.result.url.includes('-english-translation-')
      );

      if (!bestHit) return null;

      const pageRes = await fetch(bestHit.result.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await pageRes.text();

      const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let matches = [];
      let match;
      while ((match = containerRegex.exec(html)) !== null) {
        matches.push(match[1]);
      }
      if (matches.length === 0) return null;

      return cleanLyricsText(matches.join('\n'));
    } catch (e) { return null; }
  }

  // Helper 3: Web Fallback
  async function searchWebFallback(artistName, songName) {
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();

      const allLinks = html.match(/https?:\/\/(?:[a-z]+\.)?genius\.com\/[^"&]+/gi) || [];
      const validLink = allLinks.find(link => 
        !link.includes('-romanized-') && 
        !link.includes('-english-translation-')
      );

      if (validLink) {
        const pageRes = await fetch(validLink, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const pageHtml = await pageRes.text();
        const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
        let matches = [];
        let match;
        while ((match = containerRegex.exec(pageHtml)) !== null) {
          matches.push(match[1]);
        }
        if (matches.length > 0) return cleanLyricsText(matches.join('\n'));
      }
    } catch (e) { return null; }
    return null;
  }

  // Execution: Process queries
  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult) {
      return res.status(200).json({ 
        lyrics: cleanLyricsText(lrclibResult.text), 
        source: 'lrclib',
        synced: lrclibResult.type === 'synced'
      });
    }

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius', synced: false });
  }

  const webResult = await searchWebFallback(mainArtist, cleanedTitle);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-fallback', synced: false });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
