export default async function handler(req, res) {
  const { artist, title } = req.query;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  // Remove duet semicolons so search matches cleanly
  const mainArtist = artist.split(';')[0].trim();
  const query = `${mainArtist} ${title}`;

  try {
    // 1. Search Genius public endpoint (No API key required)
    const searchRes = await fetch(
      `https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      }
    );

    const searchData = await searchRes.json();
    const sections = searchData?.response?.sections || [];
    const songSection = sections.find(s => s.type === 'song');
    const firstHit = songSection?.hits?.[0]?.result;

    if (!firstHit || !firstHit.url) {
      return res.status(404).json({ error: 'Song not found' });
    }

    // 2. Fetch Genius lyrics page
    const pageRes = await fetch(firstHit.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });
    const html = await pageRes.text();

    // 3. Extract lyrics containers from HTML
    const containerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/g;
    let matches = [];
    let match;
    while ((match = containerRegex.exec(html)) !== null) {
      matches.push(match[1]);
    }

    if (matches.length === 0) {
      return res.status(404).json({ error: 'Lyrics container not found' });
    }

    // 4. Format line breaks and remove raw HTML tags
    let rawLyrics = matches.join('\n');
    let cleanLyrics = rawLyrics
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .trim();

    return res.status(200).json({ lyrics: cleanLyrics });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
}
