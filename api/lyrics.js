export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // Vercel Edge Caching (Instant load for 24 hours)
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');

  // Rotate User-Agents to prevent scraper blocks
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
  ];
  const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  function stripNikud(str) {
    return str.replace(/[\u0591-\u05C7]/g, '');
  }

  // Ghost Translator for Transliterated Titles
  async function getHebrewTranslation(text) {
    try {
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=${encodeURIComponent(text)}`);
      const data = await res.json();
      return data[0].map(item => item[0]).join('');
    } catch (e) { return null; }
  }

  // 1. Unpack Artists
  const artistList = artist.split(/;|,/).map(a => a.trim()).filter(Boolean);
  const primaryArtist = artistList[0];

  // 2. Clean Title
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

  // 3. Handle Dual-Language Titles (e.g., "Shabbat Gan Eden - שבת גן עדן")
  const titleVariants = cleanedTitle.split(/[-/]/).map(t => t.trim()).filter(Boolean);
  if (!titleVariants.includes(cleanedTitle)) {
    titleVariants.push(cleanedTitle);
  }

  // Build Comprehensive Query Queue
  const searchQueries = [];
  for (const tVariant of titleVariants) {
    for (const a of artistList) {
      searchQueries.push(`${a} ${tVariant}`);
    }
  }

  // Check if Hebrew translation is needed
  const hasHebrew = /[\u0590-\u05FF]/.test(cleanedTitle);
  if (!hasHebrew) {
    const translatedTitle = await getHebrewTranslation(cleanedTitle);
    if (translatedTitle) {
      for (const a of artistList) {
        searchQueries.push(`${a} ${translatedTitle}`);
      }
    }
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

  function isValidLyrics(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (lower.includes('tracklist') || lower.includes('album credits') || lower.includes('q&a')) return false;
    if (text.length > 300 && !text.includes('\n')) return false;
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
      const res = await fetch(`https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`, { 
        headers: { 'User-Agent': randomUserAgent } 
      });
      const data = await res.json();
      const hits = data?.response?.sections?.find(s => s.type === 'song')?.hits || [];
      const bestHit = hits.find(h => !h.result.url.includes('-romanized-') && !h.result.url.includes('-english-translation-'));
      if (!bestHit) return null;

      const pageRes = await fetch(bestHit.result.url, { headers: { 'User-Agent': randomUserAgent } });
      const html = await pageRes.text();
      const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
      let matches = [];
      let match;
      while ((match = containerRegex.exec(html)) !== null) matches.push(match[1]);
      
      const cleanText = cleanLyricsText(matches.join('\n'));
      return isValidLyrics(cleanText) ? cleanText : null;
    } catch (e) { return null; }
  }

  async function searchWebFallback(artistName, songName) {
    try {
      // Shironet Scraper
      const shironetSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} site:shironet.mako.co.il`)}`;
      const shironetRes = await fetch(shironetSearch, { headers: { 'User-Agent': randomUserAgent } });
      const shironetHtml = await shironetRes.text();
      const shironetLink = shironetHtml.match(/https?:\/\/shironet\.mako\.co\.il\/artist\?type=lyrics[^"&]+/i);

      if (shironetLink) {
        const pageRes = await fetch(shironetLink[0], { headers: { 'User-Agent': randomUserAgent } });
        const pageHtml = await pageRes.text();
        const lyricMatch = pageHtml.match(/<span itemprop="Lyrics" class="artist_lyrics_text">([\s\S]*?)<\/span>/i);
        if (lyricMatch) {
          const cleanShironet = cleanLyricsText(lyricMatch[1]);
          if (isValidLyrics(cleanShironet)) return cleanShironet;
        }
      }

      // Genius Web Fallback
      const geniusSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const geniusRes = await fetch(geniusSearch, { headers: { 'User-Agent': randomUserAgent } });
      const html = await geniusRes.text();
      const validLink = (html.match(/https?:\/\/(?:[a-z]+\.)?genius\.com\/[^"&]+/gi) || []).find(link => !link.includes('-romanized-') && !link.includes('-english-translation-'));

      if (validLink) {
        const pageRes = await fetch(validLink, { headers: { 'User-Agent': randomUserAgent } });
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

  // Execution Loop
  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult && isValidLyrics(lrclibResult.text)) {
      return res.status(200).json({ lyrics: cleanLyricsText(lrclibResult.text), source: 'lrclib', synced: lrclibResult.type === 'synced' });
    }

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius', synced: false });
  }

  const webResult = await searchWebFallback(primaryArtist, titleVariants[0]);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-scraper', synced: false });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
