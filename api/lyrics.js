export default async function handler(req, res) {
  const { artist, title, track } = req.query;
  const rawTitle = title || track;

  if (!artist || !rawTitle) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=43200');

  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
  ];
  const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  function stripNikud(str) {
    return str.replace(/[\u0591-\u05C7]/g, '');
  }

  async function getHebrewTranslation(text) {
    try {
      const res = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=iw&dt=t&q=${encodeURIComponent(text)}`);
      const data = await res.json();
      return data[0].map(item => item[0]).join('');
    } catch (e) { return null; }
  }

  const artistList = artist.split(/;|,/).map(a => a.trim()).filter(Boolean);
  const primaryArtist = artistList[0];

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

  const titleVariants = cleanedTitle.split(/[-/]/).map(t => t.trim()).filter(Boolean);
  if (!titleVariants.includes(cleanedTitle)) {
    titleVariants.push(cleanedTitle);
  }

  const searchQueries = [];

  for (const tVariant of titleVariants) {
    for (const a of artistList) {
      searchQueries.push(`${a} ${tVariant}`);
    }
  }

  const isArtistHebrew = /[\u0590-\u05FF]/.test(primaryArtist);
  const isTitleHebrew = /[\u0590-\u05FF]/.test(cleanedTitle);

  let translatedArtist = primaryArtist;
  if (!isArtistHebrew) {
    const translated = await getHebrewTranslation(primaryArtist);
    if (translated) translatedArtist = translated;
  }

  let translatedTitle = cleanedTitle;
  if (!isTitleHebrew) {
    const translated = await getHebrewTranslation(cleanedTitle);
    if (translated) translatedTitle = translated;
  }

  if (translatedArtist !== primaryArtist || translatedTitle !== cleanedTitle) {
    searchQueries.push(`${translatedArtist} ${translatedTitle}`);
    searchQueries.push(`${translatedArtist} ${cleanedTitle}`);
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
      const queryStr = `${artistName} ${songName} site:shironet.mako.co.il`;
      const shironetSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryStr)}`;
      const shironetRes = await fetch(shironetSearch, { headers: { 'User-Agent': randomUserAgent } });
      const shironetHtml = await shironetRes.text();

      const uddgMatches = shironetHtml.match(/uddg=([^&"#]+)/g) || [];
      let targetShironetUrl = null;

      for (const rawMatch of uddgMatches) {
        const decoded = decodeURIComponent(rawMatch.replace('uddg=', ''));
        if (decoded.includes('shironet.mako.co.il/artist?type=lyrics')) {
          targetShironetUrl = decoded;
          break;
        }
      }

      if (targetShironetUrl) {
        const pageRes = await fetch(targetShironetUrl, { headers: { 'User-Agent': randomUserAgent } });
        const pageHtml = await pageRes.text();
        
        // AGGRESSIVE SHIRONET SCRAPING: Look for multiple possible container classes
        const lyricMatch = pageHtml.match(/<span itemprop="Lyrics" class="artist_lyrics_text">([\s\S]*?)<\/span>/i) ||
                           pageHtml.match(/<span class="artist_lyrics_text">([\s\S]*?)<\/span>/i) ||
                           pageHtml.match(/<div class="lyrics">([\s\S]*?)<\/div>/i);
                           
        if (lyricMatch) {
          const cleanShironet = cleanLyricsText(lyricMatch[1]);
          if (isValidLyrics(cleanShironet)) return cleanShironet;
        }
      }

      const geniusSearch = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artistName}${songName} מילים genius`)}`;
      const geniusRes = await fetch(geniusSearch, { headers: { 'User-Agent': randomUserAgent } });
      const html = await geniusRes.text();
      
      const geniusUddgMatches = html.match(/uddg=([^&"#]+)/g) || [];
      let targetGeniusUrl = null;

      for (const rawMatch of geniusUddgMatches) {
        const decoded = decodeURIComponent(rawMatch.replace('uddg=', ''));
        if (decoded.includes('genius.com/') && !decoded.includes('-romanized-') && !decoded.includes('-english-translation-')) {
          targetGeniusUrl = decoded;
          break;
        }
      }

      if (targetGeniusUrl) {
        const pageRes = await fetch(targetGeniusUrl, { headers: { 'User-Agent': randomUserAgent } });
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

  for (const query of uniqueQueries) {
    const lrclibResult = await searchLrclib(query);
    if (lrclibResult && isValidLyrics(lrclibResult.text)) {
      return res.status(200).json({ lyrics: cleanLyricsText(lrclibResult.text), source: 'lrclib', synced: lrclibResult.type === 'synced' });
    }

    const geniusResult = await searchGenius(query);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius', synced: false });
  }

  const webResult = await searchWebFallback(translatedArtist || primaryArtist, translatedTitle || titleVariants[0]);
  if (webResult) {
    return res.status(200).json({ lyrics: webResult, source: 'web-scraper', synced: false });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
