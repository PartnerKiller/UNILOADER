import os
import sys
import re
import time
import json
import base64
import shutil
from curl_cffi import requests

# Try importing mutagen for tagging
try:
    from mutagen.flac import FLAC, Picture
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

session = requests.Session(impersonate="chrome124")

# Open Tidal / Monochrome endpoint mirrors
TIDAL_API_MIRRORS = [
    "https://monochrome.tf/api",
    "https://api.monochrome-music.com",
    "https://tritil.top/api",
    "https://tidal.hifi-audio.org/api"
]

def fetch_synced_lyrics(artist, title, album=None, duration=None):
    """Fetches synchronized lyrics (.lrc) from LRCLIB."""
    try:
        params = {'artist_name': artist, 'track_name': title}
        if album: params['album_name'] = album
        if duration: params['duration'] = int(duration)
        r = session.get("https://lrclib.net/api/get", params=params, timeout=5)
        if r.status_code == 200:
            data = r.json()
            return data.get('syncedLyrics') or data.get('plainLyrics')
    except Exception:
        pass
    return None

def tag_flac(flac_path, meta):
    """Writes rich Vorbis tags, lyrics, and album art into FLAC."""
    if not HAS_MUTAGEN or not os.path.exists(flac_path):
        return
    try:
        audio = FLAC(flac_path)
        if meta.get('title'): audio['TITLE'] = [str(meta['title'])]
        if meta.get('artist'): audio['ARTIST'] = [str(meta['artist'])]
        if meta.get('album'): audio['ALBUM'] = [str(meta['album'])]
        if meta.get('album_artist'): audio['ALBUMARTIST'] = [str(meta['album_artist'])]
        if meta.get('year'): audio['DATE'] = [str(meta['year'])]
        if meta.get('isrc'): audio['ISRC'] = [str(meta['isrc'])]
        
        lyrics = meta.get('lyrics')
        if lyrics:
            audio['LYRICS'] = [lyrics]
            audio['UNSYNCEDLYRICS'] = [lyrics]
            
        cover_url = meta.get('cover_url')
        if cover_url:
            try:
                r_cov = session.get(cover_url, timeout=8)
                if r_cov.status_code == 200:
                    pic = Picture()
                    pic.type = 3
                    pic.mime = 'image/jpeg' if 'jpg' in cover_url.lower() else 'image/png'
                    pic.desc = 'Cover'
                    pic.data = r_cov.content
                    audio.clear_pictures()
                    audio.add_picture(pic)
            except Exception:
                pass
        audio.save()
    except Exception as e:
        print(f"[Tidal Tagging] Warning: {e}", file=sys.stderr)

def get_tidal_stream_url(isrc=None, query=None):
    """Resolves Tidal Hi-Res / Lossless FLAC stream URL via Monochrome API."""
    # 1. Search by ISRC
    if isrc:
        for mirror in TIDAL_API_MIRRORS:
            try:
                r = session.get(f"{mirror}/track", params={'isrc': isrc, 'quality': 'LOSSLESS'}, timeout=4)
                if r.status_code == 200:
                    data = r.json()
                    stream_url = data.get('stream_url') or data.get('url') or data.get('downloadUrl')
                    if stream_url:
                        return stream_url, data
            except Exception:
                pass

    # 2. Search by Query
    if query:
        for mirror in TIDAL_API_MIRRORS:
            try:
                r = session.get(f"{mirror}/search", params={'q': query, 'quality': 'LOSSLESS'}, timeout=4)
                if r.status_code == 200:
                    data = r.json()
                    items = data.get('tracks') or data.get('items') or data.get('data') or []
                    if items:
                        t = items[0]
                        stream_url = t.get('stream_url') or t.get('url') or t.get('downloadUrl')
                        if stream_url:
                            return stream_url, t
            except Exception:
                pass
                
    return None, None

def download_tidal_flac(artist, title, output_path, isrc=None, cover_url=None, duration=None):
    """
    Downloads authentic 16-bit/24-bit Lossless FLAC directly from Tidal Hi-Res via Monochrome.
    """
    clean_art = re.sub(r'[\(\)\[\],&]', ' ', artist).strip()
    clean_tit = re.sub(r'[\(\)\[\],&]', ' ', title).strip()
    query = f"{clean_art} {clean_tit}"
    
    print(f"[Tidal Hi-Res] Querying Monochrome Tidal engine for '{query}' (ISRC: {isrc or 'N/A'})...", flush=True)
    
    stream_url, track_meta = get_tidal_stream_url(isrc=isrc, query=query)
    if not stream_url:
        return False
        
    print(f"[Tidal Hi-Res] Streaming Studio Master FLAC from Tidal CDN...", flush=True)
    
    try:
        r_stream = session.get(stream_url, stream=True, timeout=15)
        if r_stream.status_code != 200:
            return False
            
        with open(output_path, 'wb') as f:
            for chunk in r_stream.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    
        if os.path.exists(output_path) and os.path.getsize(output_path) > 100000:
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            meta = {
                'title': title,
                'artist': artist,
                'isrc': isrc or (track_meta.get('isrc') if track_meta else None),
                'album': track_meta.get('album', {}).get('title', '') if track_meta and isinstance(track_meta.get('album'), dict) else '',
                'cover_url': cover_url or (track_meta.get('cover_url') if track_meta else None),
                'lyrics': lyrics
            }
            tag_flac(output_path, meta)
            print(f"[Tidal Hi-Res] 🎉 Authentic Tidal Lossless FLAC saved: {output_path} ({os.path.getsize(output_path)/(1024*1024):.1f}MB)", flush=True)
            return True
    except Exception as e:
        print(f"[Tidal Hi-Res] Stream download error: {e}", file=sys.stderr)
        
    return False

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python tidal_monochrome_engine.py <ARTIST> <TITLE> <OUTPUT_PATH> [ISRC]")
        sys.exit(1)
        
    art = sys.argv[1]
    tit = sys.argv[2]
    out = sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 else None
    
    ok = download_tidal_flac(art, tit, out, isrc=code)
    if ok:
        print(f"🎉 Success: {out}")
        sys.exit(0)
    else:
        print("❌ Tidal stream not available")
        sys.exit(1)
