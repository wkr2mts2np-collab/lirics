export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');

  function stripNikud(str) {
    return str.replace(/[\u0591-\u05C7]/g, '');
  }

  const mainArtist = artist.split(';')[0].split(',')[0].trim();
  
  const cleanedTitle = stripNikud(rawTitle)
    .replace(/\(live.*?\)/gi, '')
    .replace(/\(acoustic.*?\)/gi, '')
    .replace(/\(cover.*?\)/gi, '')
    .replace(/\(vocal.*?\)/gi, '')
    .replace(/\[.*?\]/g, '')
    .replace(/feat\..*$/gi, '')
    .replace(/ft\..*$/gi, '')
    .replace(/["'״]/g, '')
    .trim();

  const hebrewRegex = /[\u0590-\u05FF]/;
  const hasHebrew = hebrewRegex.test(cleanedTitle) || hebrewRegex.test(mainArtist);

  // GHOST TRANSLATOR: Auto-converts English/Romanized to Hebrew script via Google Translate API
  async function getHebrewTranslation(text) {
    try {
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=${encodeURIComponent(text)}`);
      const data = await res.json();
      return data[0].map(item => item[0]).join('');
    } catch (e) { return null; }
  }

  const searchQueries = [];
  searchQueries.push(`${mainArtist} ${cleanedTitle}`);

  // If there is no Hebrew in the title, generate it automatically
  if (!hasHebrew) {
    const translatedTitle = await getHebrewTranslation(cleanedTitle);
    const translatedArtist = await getHebrewTranslation(mainArtist);
    if (translatedTitle) searchQueries.push(`${mainArtist} ${translatedTitle}`);
    if (translatedArtist && translatedTitle) searchQueries.push(`${translatedArtist} ${translatedTitle}`);
  }

  const uniqueQueries = [...new Set(searchQueries)];

  function cleanLyricsText(rawText) {
    return rawText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\[.*?\]/g, '') 
      .replace(/[\u200B-\u200D\uFEFF]/g, '') 
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n') 
      .trim();
  }

  // GARBAGE FILTER: Detects if Genius handed us a band biography or tracklist (Fixes Zusha)
  function isValidLyrics(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (lower.includes('tracklist') || lower.includes('album credits') || lower.includes('q&a')) return false;
    // Reject if it's a massive block of text with no line breaks (like a bio)
    if (text.length > 250 && !text.includes('\n')) return false;
    return true;
  }

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

  async function searchGenius(q) {
    try {
      const res = await fetch(`https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await res.json();
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      const bestHit = hits.find(h => !h.result.url.includes('-romanized-') && !h.result.url.includes('-english-translation-'));
      if (!bestHit) return null;

      const pageRes = await fetch(bestHit.result.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await pageRes.text();
      const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let matches = [];
      let match;
      while ((match = containerRegex.exec(html)) !== null) matches.push(match[1]);
      
      const cleanText = cleanLyricsText(matches.join('\n'));
      return isValidLyrics(cleanText) ? cleanText : null;
    } catch (e) { return null; }
  }

  // MEGA-SCRAPER: Uses DuckDuckGo to hunt for Shironet and Genius
  async function searchWebFallback(artistName, songName) {
    try {
      // 1. Try to find the Israeli site Shironet first
      const shironetSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} site:shironet.mako.co.il`)}`;
      const shironetRes = await fetch(shironetSearch, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const shironetHtml = await shironetRes.text();
      const shironetLink = shironetHtml.match(/https?:\/\/shironet\.mako\.co\.il\/artist\?type=lyrics[^"&]+/i);

      if (shironetLink) {
        const pageRes = await fetch(shironetLink[0], { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const pageHtml = await pageRes.text();
        const lyricMatch = pageHtml.match(/<span itemprop="Lyrics" class="artist_lyrics_text">([\s\S]*?)<\/span>/i);
        if (lyricMatch) {
          const cleanShironet = cleanLyricsText(lyricMatch[1]);
          if (isValidLyrics(cleanShironet)) return cleanShironet;
        }
      }

      // 2. Fallback to Genius web search
      const geniusSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const geniusRes = await fetch(geniusSearch, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const html = await geniusRes.text();
      const validLink = (html.match(/https?:\/\/(?:[a-z]+\.)?genius\.com\/[^"&]+/gi) || []).find(link => !link.includes('-romanized-') && !link.includes('-english-translation-'));

      if (validLink) {
        const pageRes = await fetch(validLink, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const pageHtml = await pageRes.text();
        const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
        let matches = [];
        let match;
        while ((match = containerRegex.exec(pageHtml)) !== null) matches.push(match[1]);
        const cleanText = cleanLyricsText(matches.join('\n'));
        if (isValidLyrics(cleanText)) return cleanText;
      }
    } catch (e) { return null; }
    return null;
  }

  // Execution: Process everything
  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult && isValidLyrics(lrclibResult.text)) {
      return res.status(200).json({ lyrics: cleanLyricsText(lrclibResult.text), source: 'lrclib', synced: lrclibResult.type === 'synced' });
    }

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius', synced: false });
  }

  // Final Mega-Scraper Fallback
  const webResult = await searchWebFallback(mainArtist, cleanedTitle);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-scraper', synced: false });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
