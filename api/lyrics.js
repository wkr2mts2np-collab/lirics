import { getLyrics } from 'genius-lyrics-api';

export default async function handler(req, res) {
  const { artist, title } = req.query;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Missing artist or title' });
  }

  const mainArtist = artist.split(';')[0].trim();

  try {
    const options = {
      apiKey: process.env.GENIUS_API_KEY,
      title: title,
      artist: mainArtist,
      optimizeQuery: true
    };

    const lyricsText = await getLyrics(options);

    if (lyricsText) {
      return res.status(200).json({ lyrics: lyricsText });
    } else {
      return res.status(404).json({ error: 'Lyrics not found on Genius' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch lyrics' });
  }
}
