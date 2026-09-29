export default async function handler(req, res) {
  const { artist, title } = req.query;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // 1. Clean Artist (Take main artist from duets like "Yaakov Shwekey;Eliad")
  const mainArtist = artist.split(';')[0].trim();

  // 2. Clean Title (Extract clean parts from "Shabbat Gan Eden - שבת גן עדן")
  const titleParts = title.split(/[-/]/).map(t => t.trim()).filter(Boolean);
  const primaryTitle = titleParts[0];

  // Variations to attempt searching
  const queries = [
    `${mainArtist} ${primaryTitle}`,
    `${mainArtist} ${title}`,
    primaryTitle
  ];

  // Helper: Search LRCLIB Fuzzy Search (Catches tracks even if length is 1-2s off)
  async function searchLrclib(q) {
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) return null;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[0].syncedLyrics || data[0].plainLyrics || null;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Helper: Search Genius Public API
  async function searchGenius(q) {
    try {
      const searchRes = await fetch(
        `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }
      );
      if (!searchRes.ok) return null;
      const searchData = await searchRes.json();
      const hits = searchData?.response?.sections?.find(s => s.type === 'song')?.hits || [];
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

  // Run searches across queries
  for (const q of queries) {
    // Check LRCLIB Fuzzy first
    const lrclibResult = await searchLrclib(q);
    if (lrclibResult) return res.status(200).json({ lyrics: lrclibResult, source: 'lrclib' });

    // Fallback to Genius
    const geniusResult = await searchGenius(q);
    if (geniusResult) return res.status(200).json({ lyrics: geniusResult, source: 'genius' });
  }

  return res.status(404).json({ error: 'Lyrics not found' });
}
