"""Local audio catalog and an authoritative, per-room playback clock."""
from dataclasses import dataclass
from hashlib import sha256
import math
from pathlib import Path
import threading
from typing import Optional
from urllib.parse import quote

import mutagen


MUSIC_TYPES = {".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
               ".ogg": "audio/ogg", ".wav": "audio/wav", ".webm": "audio/webm"}


class MusicCatalog:
    def __init__(self):
        self.cache = {}
        self.lock = threading.RLock()

    def files(self, folder):
        folder = Path(folder)
        if not folder.is_dir():
            return {}
        return {p.name: p for p in sorted(folder.iterdir(), key=lambda p: p.name.casefold())
                if not p.is_symlink() and p.is_file() and p.suffix.lower() in MUSIC_TYPES}

    def tracks(self, folder):
        with self.lock:
            tracks, keep = [], set()
            for name, path in self.files(folder).items():
                try:
                    stat = path.stat()
                except OSError:
                    continue  # Removed between directory listing and stat.
                key = (str(path.resolve()), stat.st_mtime_ns, stat.st_size)
                keep.add(key)
                if key not in self.cache:
                    try:
                        media = mutagen.File(path)
                        duration = float(media.info.length) if media is not None else None
                        if duration is not None and (not math.isfinite(duration) or duration <= 0):
                            duration = None
                    except (mutagen.MutagenError, OSError, ValueError, EOFError):
                        duration = None
                    version = sha256(repr(key).encode()).hexdigest()[:12]
                    self.cache[key] = dict(file=name, name=path.stem, duration=duration,
                                           version=version, url="/music/" + quote(name, safe="") + "?v=" + version)
                tracks.append(dict(self.cache[key]))
            self.cache = {k: v for k, v in self.cache.items() if k in keep}
            return tracks


@dataclass
class MusicState:
    file: Optional[str] = None
    version: Optional[str] = None
    playing: bool = False
    position: float = 0.0
    changed_at: float = 0.0
    revision: int = 0

    def set_track(self, track, now, position=0.0):
        self.file = track['file'] if track else None
        self.version = track['version'] if track else None
        self.position, self.changed_at = position, now
        if not track:
            self.playing = False
        self.revision += 1

    def elapsed(self, now):
        return self.position + (max(0.0, now - self.changed_at) if self.playing else 0.0)

    def synchronize(self, tracks, now):
        current = next((t for t in tracks if t['file'] == self.file), None)
        if current is None:
            if tracks or self.file is not None:
                self.set_track(tracks[0] if tracks else None, now)
            return
        if current['version'] != self.version:
            self.set_track(current, now)
            return
        if not self.playing or current['duration'] is None:
            return
        elapsed = self.elapsed(now)
        if elapsed < current['duration']:
            return
        # Skip complete loops arithmetically, even after hours without a client.
        if all(t['duration'] is not None for t in tracks):
            elapsed %= sum(t['duration'] for t in tracks)
        index = tracks.index(current)
        for _ in range(len(tracks)):
            duration = tracks[index]['duration']
            if duration is None or elapsed < duration:
                break
            elapsed -= duration
            index = (index + 1) % len(tracks)
        self.set_track(tracks[index], now, elapsed)

    def snapshot(self, tracks, now):
        self.synchronize(tracks, now)
        return dict(file=self.file, playing=self.playing, position=self.elapsed(now),
                    revision=self.revision, tracks=tracks)
