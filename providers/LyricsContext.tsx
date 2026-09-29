import { Karoke, Lyric, PlainLyrics, SyncedLyrics } from "@/typings/Lyrics";
import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { useSong, useTime } from "./SongContext";
import useInterval from "@/lib/useInterval";

import { extractAndRemoveParentheses } from "@/lib/extract";

const LyricContext = createContext<SyncedLyrics | PlainLyrics | null>(null);
const CurrentContext = createContext<Karoke | null>(null);

export function useLyrics() {
  return useContext(LyricContext);
}

export function useKaroke() {
  return useContext(CurrentContext);
}

export function LyricsProvider({ children }: { children: ReactNode }) {
  const song = useSong();
  const currentTime = useTime();

  const [lyric, setLyric] = useState<SyncedLyrics | PlainLyrics | null>(null);
  const [current, setCurrent] = useState<Karoke | null>(null);

  const [prevSong, setPrevSong] = useState<string>("");

  useInterval(() => {
    if (lyric && lyric.synced) {
      const cur = lyric.lyrics
        .filter(
          (a) => currentTime >= a.seconds && currentTime <= a.seconds + 1
        )
        .splice(-1)[0];

      if (cur && cur.lyrics != null) {
        const [ext, clean] = extractAndRemoveParentheses(
          cur.lyrics === "" ? "..." : cur.lyrics
        );
        setCurrent({
          index: lyric.lyrics.findIndex((a) => a.seconds === cur.seconds),
          lyric: { seconds: cur.seconds, lyrics: clean.toString() },
        });
      } else if (currentTime < 5) {
        setCurrent(null);
      }
    }
  }, 800);

  useEffect(() => {
    if (song && song.name && song.artist && prevSong !== song.name) {
      setCurrent(null);

      const title = encodeURIComponent(song.name);
      const artist = encodeURIComponent(song.artist);

      // Pass both title and track so backend route matches cleanly
      fetch(`/api/lyrics?title=${title}&track=${title}&artist=${artist}`)
        .then((res) => res.json())
        .then((d) => {
          if (!d || d.error) {
            setLyric(null);
            return;
          }

          // Format plain-text fallback response from Genius or plain LRCLIB
          if (typeof d.lyrics === "string") {
            setLyric({
              synced: false,
              lyrics: d.lyrics,
              song: song.name,
            } as PlainLyrics);
          } else {
            setLyric({
              ...d,
              song: d.song || song.name,
            });
          }
          setPrevSong(song.name);
        })
        .catch((err) => {
          console.warn("Failed to fetch lyrics:", err);
          setLyric(null);
        });
    }
  }, [song, prevSong]);

  return (
    <LyricContext.Provider value={lyric}>
      <CurrentContext.Provider value={current}>
        {children}
      </CurrentContext.Provider>
    </LyricContext.Provider>
  );
}
