export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // 1. Clean primary artist and extract Last Name for fallbacks
  const mainArtist = artist.split(';')[0].split(',')[0].trim();
  const artistParts = mainArtist.split(' ');
  const artistLastName = artistParts.length > 1 ? artistParts[artistParts.length - 1] : mainArtist;

  // 2. Aggressively clean track title (removes live, cover, acoustic, ft., feat.)
  const cleanedTitle = rawTitle
    .replace(/\(live.*?\)/gi, '')
    .replace(/\(acoustic.*?\)/gi, '')
    .replace(/\(cover.*?\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/feat\..*$/gi, '')
    .replace(/ft\..*$/gi, '')
    .trim();

  // 3. Separate Hebrew script and English/Transliterated parts
  const titleParts = cleanedTitle.split(/[-/]/).map(p => p.trim()).filter(Boolean);
  const hebrewParts = titleParts.filter(p => /[\u0590-\u05FF]/.test(p));
  const englishParts = titleParts.filter(p => !/[\u0590-\u05FF]/.test(p));

  // Build targeted search combinations (Highest priority first)
  const searchQueries = [];

  if (hebrewParts.length > 0) {
    searchQueries.push(`${mainArtist} ${hebrewParts.join(' ')}`);
    searchQueries.push(`${artistLastName} ${hebrewParts.join(' ')}`); // Last name fallback
  }

  if (englishParts.length > 0) {
    searchQueries.push(`${mainArtist} ${englishParts.join(' ')}`);
    searchQueries.push(`${artistLastName} ${englishParts.join(' ')}`);
  }

  searchQueries.push(`${mainArtist} ${cleanedTitle}`);
  searchQueries.push(`${artistLastName} ${cleanedTitle}`);

  const uniqueQueries = [...new Set(searchQueries)];

  // Text Cleaner: Removes [Chorus], [Verse], and weird HTML artifacts
  function cleanLyricsText(rawText) {
    return rawText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '') // Strip remaining HTML
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\[.*?\]/g, '') // Remove [Chorus], [Verse 1], etc.
      .replace(/\n{3,}/g, '\n\n') // Fix massive gaps
      .trim();
  }

  // Helper 1: Search LRCLIB Fuzzy
  async function searchLrclib(q) {
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      if (!response.ok) return null;
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[0].syncedLyrics || data[0].plainLyrics || null;
      }
    } catch (e) { return null; }
    return null;
  }

  // Helper 2: Direct Genius Search (With Romanization Blocker)
  async function searchGenius(q) {
    try {
      const res = await fetch(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      
      // Find the first hit that IS NOT a translation or romanized version
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

  // Helper 3: Web Fallback (DuckDuckGo Search with "מילים" and Romanization Blocker)
  async function searchWebFallback(artistName, songName) {
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await res.text();

      // Find Genius links, reject translation/romanized links
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

  // 4. Execution: Process queries sequentially
  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult) return res.status(200).json({ lyrics: cleanLyricsText(lrclibResult), source: 'lrclib' });

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius' });
  }

  // Final fallback: Web Search
  const webResult = await searchWebFallback(mainArtist, cleanedTitle);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-fallback' });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
