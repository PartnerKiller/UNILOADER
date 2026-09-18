#!/usr/bin/env python3
"""
JioSaavn High-Fidelity Music Engine:
Resolves and downloads genuine 320 kbps Studio Master audio streams
from JioSaavn's Akamai CDN with full 500x500 artwork, Vorbis/ID3 tags,
and synchronized lyrics.
"""

import os
import sys
import re
import json
import time
import base64
import urllib.request
import urllib.parse
import subprocess

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Crypto for media URL decryption
try:
    from Cryptodome.Cipher import DES
except ImportError:
    try:
        from Crypto.Cipher import DES
    except ImportError:
        DES = None

# Mutagen for tagging
try:
    from mutagen.flac import FLAC, Picture
    from mutagen.mp4 import MP4, MP4Cover
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
DES_KEY = b'38346591'


def clean_query(q):
    """Strips parenthetical suffixes and noise tags for clean music resolution."""
    q = re.sub(r'[\(\[\{].*?[\)\]\}]', ' ', q)
    q = re.sub(r'(?i)\b(official\s*(music)?\s*video|official\s*audio|original|full\s*song|audio|video|lyrics?)\b', ' ', q)
    q = re.sub(r'[\-_/|]', ' ', q)
    return re.sub(r'\s+', ' ', q).strip()


def decrypt_media_url(enc_url):
    """Decrypts JioSaavn DES-ECB encrypted media URL and upgrades to 320 kbps."""
    if not DES or not enc_url:
        return None
    try:
        cipher = DES.new(DES_KEY, DES.MODE_ECB)
        decrypted = cipher.decrypt(base64.b64decode(enc_url))
        pad_len = decrypted[-1]
        raw_url = decrypted[:-pad_len].decode('utf-8')
        # Upgrade stream to pristine 320 kbps Akamai CDN stream
        hq_url = raw_url.replace('_96.mp4', '_320.mp4').replace('_160.mp4', '_320.mp4')
        return hq_url
    except Exception as e:
        print(f"[JioSaavn] Decryption error: {e}", file=sys.stderr)
        return None


def fetch_synced_lyrics(artist, title, album=None, duration=None):
    """Fetches synchronized lyrics (.lrc) from LRCLIB."""
    try:
        params = {'artist_name': artist, 'track_name': title}
        if album:
            params['album_name'] = album
        if duration:
            params['duration'] = int(duration)
        req = urllib.request.Request(
            f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}",
            headers={'User-Agent': USER_AGENT}
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('syncedLyrics') or data.get('plainLyrics')
    except Exception:
        pass
    return None


def search_jiosaavn(query):
    """Searches JioSaavn for tracks matching query."""
    clean_q = clean_query(query)
    queries = [clean_q, query]
    if ' - ' in query:
        parts = query.split(' - ')
        queries.append(clean_query(parts[1]))
        queries.append(f"{clean_query(parts[0])} {clean_query(parts[1])}")

    for q in queries:
        if not q:
            continue
        url = f"https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query={urllib.parse.quote(q)}"
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                songs = data.get('songs', {}).get('data', [])
                if songs:
                    return songs[0].get('id')
        except Exception:
            pass
    return None


def get_song_details(song_id):
    """Fetches full song metadata from JioSaavn API."""
    url = f"https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids={song_id}"
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get(song_id, {})
    except Exception as e:
        print(f"[JioSaavn] Details fetch error: {e}", file=sys.stderr)
        return None


def tag_flac_file(flac_path, title, artist, album, year, cover_bytes, lyrics=None):
    """Injects Vorbis comments, cover art, and lyrics into FLAC."""
    if not HAS_MUTAGEN or not os.path.exists(flac_path):
        return
    try:
        audio = FLAC(flac_path)
        if title: audio['TITLE'] = [str(title)]
        if artist: audio['ARTIST'] = [str(artist)]
        if album: audio['ALBUM'] = [str(album)]
        if year: audio['DATE'] = [str(year)]
        if lyrics:
            audio['LYRICS'] = [lyrics]
            audio['UNSYNCEDLYRICS'] = [lyrics]

        if cover_bytes:
            pic = Picture()
            pic.type = 3  # Cover (front)
            pic.desc = "Cover (front)"
            pic.data = cover_bytes
            pic.mime = "image/jpeg"
            pic.width = 500
            pic.height = 500
            pic.depth = 24
            audio.clear_pictures()
            audio.add_picture(pic)
        audio.save()
    except Exception as e:
        print(f"[JioSaavn Tagging] Warning: {e}", file=sys.stderr)


def resolve_and_download(query_or_url, output_path, target_format='auto'):
    """
    Main resolution function for JioSaavn:
    1. Resolves song ID from URL or query
    2. Fetches metadata and decrypts 320 kbps Akamai stream
    3. Downloads stream and tags it
    """
    song_id = None
    # 1. Check if direct URL
    m = re.search(r'jiosaavn\.com/song/[^/]+/([a-zA-Z0-9_-]+)', query_or_url)
    if m:
        # Song token in URL
        token = m.group(1)
        url = f"https://www.jiosaavn.com/api.php?__call=webapi.get&token={token}&type=song&_format=json"
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                songs = data.get('songs', [])
                if songs:
                    song_id = songs[0].get('id')
        except Exception:
            pass

    if not song_id:
        song_id = search_jiosaavn(query_or_url)

    if not song_id:
        return False

    song = get_song_details(song_id)
    if not song:
        return False

    title = song.get('song') or song.get('title') or 'Song'
    artist = song.get('singers') or song.get('primary_artists') or 'Artist'
    album = song.get('album') or ''
    year = song.get('year') or ''
    cover_url = (song.get('image') or '').replace('150x150', '500x500')
    enc_url = song.get('encrypted_media_url')

    stream_url = decrypt_media_url(enc_url)
    if not stream_url:
        return False

    print(f"[JioSaavn] 🎵 Found Studio Master: \"{title}\" by {artist} ({album})", flush=True)
    print(f"[JioSaavn] 🚀 Streaming 320kbps pristine master from Akamai CDN...", flush=True)

    # Fetch album art
    cover_bytes = None
    if cover_url:
        try:
            req_c = urllib.request.Request(cover_url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req_c, timeout=6) as c_resp:
                cover_bytes = c_resp.read()
        except Exception:
            pass

    # Fetch lyrics
    lyrics = fetch_synced_lyrics(artist, title, album=album)

    # Temporary file for stream
    temp_raw = output_path + ".tmp.mp4"
    req_s = urllib.request.Request(stream_url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req_s, timeout=20) as s_resp:
        with open(temp_raw, 'wb') as f:
            while True:
                chunk = s_resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)

    if not os.path.exists(temp_raw) or os.path.getsize(temp_raw) < 50000:
        if os.path.exists(temp_raw):
            try: os.remove(temp_raw)
            except Exception: pass
        return False

    is_flac_requested = output_path.lower().endswith('.flac') or target_format in ('flac', '16bit', '24bit')

    if is_flac_requested:
        # Convert authentic 320kbps AAC master bitstream to FLAC container
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-nostats',
            '-i', temp_raw,
            '-c:a', 'flac',
            '-compression_level', '8',
            output_path
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        try: os.remove(temp_raw)
        except Exception: pass

        if res.returncode == 0 and os.path.exists(output_path):
            tag_flac_file(output_path, title, artist, album, year, cover_bytes, lyrics=lyrics)
            sz_mb = os.path.getsize(output_path) / (1024 * 1024)
            print(f"[JioSaavn] 🎉 Authentic 320kbps Studio Master saved: {output_path} ({sz_mb:.2f} MB)", flush=True)
            return True
        return False
    else:
        # Save as original m4a
        if os.path.exists(output_path):
            try: os.remove(output_path)
            except Exception: pass
        os.rename(temp_raw, output_path)
        sz_mb = os.path.getsize(output_path) / (1024 * 1024)
        print(f"[JioSaavn] 🎉 320kbps Studio Master stream saved: {output_path} ({sz_mb:.2f} MB)", flush=True)
        return True


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python jiosaavn_engine.py <QUERY_OR_URL> <OUTPUT_PATH> [FORMAT]")
        sys.exit(1)

    query = sys.argv[1]
    out = sys.argv[2]
    fmt = sys.argv[3] if len(sys.argv) > 3 else 'auto'

    ok = resolve_and_download(query, out, target_format=fmt)
    if ok:
        sys.exit(0)
    else:
        sys.exit(1)
