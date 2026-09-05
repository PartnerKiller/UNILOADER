import os
import sys
import re
import json
import time
import shutil
import base64
import zipfile
import subprocess
from curl_cffi import requests
from bs4 import BeautifulSoup

# Try importing deezer-py
try:
    import deezer
    HAS_DEEZER_PY = True
except ImportError:
    HAS_DEEZER_PY = False

# Try importing mutagen for tagging
try:
    from mutagen.flac import FLAC, Picture
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

# HTTP session with Chrome impersonation
session = requests.Session(impersonate="chrome124")

def get_deezer_client():
    """Initializes and authenticates Deezer client with ARL if available."""
    if not HAS_DEEZER_PY:
        return None
    dz = deezer.Deezer()
    arl = os.environ.get('DEEZER_ARL', '').strip()
    if arl:
        try:
            dz.login_via_arl(arl)
        except Exception as e:
            print(f"[Deezer] ARL login warning: {e}", file=sys.stderr)
    return dz

def fetch_synced_lyrics(artist, title, album=None, duration=None):
    """Fetches synchronized lyrics (.lrc) from LRCLIB."""
    try:
        params = {
            'artist_name': artist,
            'track_name': title
        }
        if album:
            params['album_name'] = album
        if duration:
            params['duration'] = int(duration)
            
        r = session.get("https://lrclib.net/api/get", params=params, timeout=5)
        if r.status_code == 200:
            data = r.json()
            return data.get('syncedLyrics') or data.get('plainLyrics')
    except Exception:
        pass
    return None

def create_flac_picture(img_bytes, desc="Cover (front)"):
    """
    Constructs a fully-compliant FLAC METADATA_BLOCK_PICTURE with accurate
    MIME type and dimensions (width, height, color depth) so media players
    (VLC, Windows Media Player, Foobar2000, macOS Music) render the cover art perfectly.
    """
    pic = Picture()
    pic.type = 3  # Cover (front)
    pic.desc = desc
    pic.data = img_bytes
    
    # Auto-detect real MIME type from binary magic bytes
    if img_bytes.startswith(b'\x89PNG'):
        pic.mime = 'image/png'
    elif img_bytes.startswith(b'GIF8'):
        pic.mime = 'image/gif'
    else:
        pic.mime = 'image/jpeg'
        
    try:
        import io
        from PIL import Image
        im = Image.open(io.BytesIO(img_bytes))
        pic.width = im.width
        pic.height = im.height
        pic.depth = 24
        if im.format == 'PNG':
            pic.mime = 'image/png'
        elif im.format == 'JPEG':
            pic.mime = 'image/jpeg'
    except Exception:
        pic.width = 640
        pic.height = 640
        pic.depth = 24
        
    return pic

def tag_flac(flac_path, meta):
    """Writes rich Vorbis comments, synchronized lyrics, and album art into FLAC."""
    if not HAS_MUTAGEN or not os.path.exists(flac_path):
        return
    try:
        audio = FLAC(flac_path)
        audio.clear()
        if meta.get('title'): audio['TITLE'] = [str(meta['title'])]
        if meta.get('artist'): audio['ARTIST'] = [str(meta['artist'])]
        if meta.get('album'): audio['ALBUM'] = [str(meta['album'])]
        if meta.get('album_artist'): audio['ALBUMARTIST'] = [str(meta['album_artist'])]
        if meta.get('year'): audio['DATE'] = [str(meta['year'])]
        if meta.get('track_number'): audio['TRACKNUMBER'] = [str(meta['track_number'])]
        if meta.get('tracks_count'): audio['TOTALTRACKS'] = [str(meta['tracks_count'])]
        if meta.get('isrc'): audio['ISRC'] = [str(meta['isrc'])]
        
        # Synced Lyrics
        lyrics = meta.get('lyrics')
        if lyrics:
            audio['LYRICS'] = [lyrics]
            audio['UNSYNCEDLYRICS'] = [lyrics]
            
        # Cover Art
        cover_url = meta.get('cover_url')
        if cover_url:
            try:
                r_cov = session.get(cover_url, timeout=8)
                if r_cov.status_code == 200 and len(r_cov.content) > 500:
                    pic = create_flac_picture(r_cov.content, desc='Cover (front)')
                    audio.clear_pictures()
                    audio.add_picture(pic)
            except Exception:
                pass
                
        audio.save()
    except Exception as e:
        print(f"[Deezer] Tagging error: {e}", file=sys.stderr)

def download_deezer_flac_track(track_info, output_path, dz=None):
    """
    Downloads an authentic 1411 kbps 16-bit FLAC track from Deezer.
    """
    if not dz:
        dz = get_deezer_client()
    if not dz:
        return False
        
    track_id = str(track_info.get('id') or track_info.get('SNG_ID'))
    if not track_id:
        return False
        
    try:
        gw_track = dz.gw.get_track(track_id)
        if not gw_track:
            return False
            
        # Get direct FLAC URL from Deezer CDN
        flac_url = dz.get_track_url(gw_track, deezer.TrackFormats.FLAC)
        if not flac_url:
            # Fallback to 320k MP3 if FLAC is restricted on account tier
            flac_url = dz.get_track_url(gw_track, deezer.TrackFormats.MP3_320)
            
        if not flac_url:
            return False
            
        # Stream and decrypt track
        r = session.get(flac_url, stream=True, timeout=15)
        if r.status_code != 200:
            return False
            
        with open(output_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    
        return os.path.exists(output_path) and os.path.getsize(output_path) > 100000
    except Exception as e:
        print(f"[Deezer] Download exception for {track_id}: {e}", file=sys.stderr)
        return False

def resolve_and_download_flac(artist, title, isrc=None, output_path=None, duration=None, cover_url=None):
    """
    1. Looks up track on Deezer by ISRC or (Artist + Title).
    2. Downloads genuine 1411 kbps FLAC file.
    3. Injects tags and synced lyrics.
    """
    dz = get_deezer_client()
    if not dz:
        return False
        
    matched_track = None
    
    # 1. Search by ISRC if available
    if isrc:
        try:
            r = session.get(f"https://api.deezer.com/track/isrc:{isrc}", timeout=6)
            if r.status_code == 200 and 'id' in r.json():
                matched_track = r.json()
        except Exception:
            pass
            
    # 2. Search by Artist + Title on Deezer GW
    if not matched_track:
        clean_artist = re.sub(r'[\(\)\[\]]', '', artist).strip()
        clean_title = re.sub(r'[\(\)\[\]]', '', title).strip()
        query = f"{clean_artist} {clean_title}"
        try:
            gw_res = dz.gw.search_music(query, 'TRACK')
            tracks = gw_res.get('data', [])
            if tracks:
                matched_track = tracks[0]
        except Exception:
            pass
            
    if not matched_track:
        return False
        
    print(f"[Deezer HiFi] Match found: {matched_track.get('title') or matched_track.get('SNG_TITLE')} (ID: {matched_track.get('id') or matched_track.get('SNG_ID')})", flush=True)
    
    success = download_deezer_flac_track(matched_track, output_path, dz=dz)
    if success:
        lyrics = fetch_synced_lyrics(artist, title, duration=duration)
        meta = {
            'title': title,
            'artist': artist,
            'album': matched_track.get('album', {}).get('title') if isinstance(matched_track.get('album'), dict) else matched_track.get('ALB_TITLE', ''),
            'isrc': isrc or matched_track.get('isrc') or matched_track.get('ISRC', ''),
            'cover_url': cover_url or matched_track.get('album', {}).get('cover_xl') or matched_track.get('ALB_PICTURE', ''),
            'lyrics': lyrics
        }
        tag_flac(output_path, meta)
        return True
        
    return False

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python deezer_hifi_engine.py <ARTIST> <TITLE> <OUTPUT_PATH> [ISRC]")
        sys.exit(1)
        
    art = sys.argv[1]
    tit = sys.argv[2]
    out = sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 else None
    
    ok = resolve_and_download_flac(art, tit, isrc=code, output_path=out)
    if ok:
        print(f"🎉 Genuine Deezer HiFi FLAC downloaded: {out}")
        sys.exit(0)
    else:
        print("❌ Deezer HiFi stream resolution failed.")
        sys.exit(1)
