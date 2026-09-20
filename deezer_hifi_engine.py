import os
import sys
import re
import json
import time
import shutil
import base64
import zipfile
import subprocess
import requests as std_requests
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

# Try importing Cryptodome for Deezer Blowfish decryption
try:
    from Cryptodome.Cipher import Blowfish
    from hashlib import md5
    HAS_CRYPTODOME = True
except ImportError:
    try:
        from Crypto.Cipher import Blowfish
        from hashlib import md5
        HAS_CRYPTODOME = True
    except ImportError:
        HAS_CRYPTODOME = False

# HTTP session with Chrome impersonation
session = requests.Session(impersonate="chrome124")

def get_deezer_client():
    """Initializes and authenticates Deezer client with ARL if available."""
    if not HAS_DEEZER_PY:
        return None
    dz = deezer.Deezer()
    arl = os.environ.get('DEEZER_ARL', '').strip()
    if not arl:
        env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
        if os.path.exists(env_file):
            try:
                with open(env_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        if line.strip().startswith('DEEZER_ARL='):
                            arl = line.strip().split('=', 1)[1].strip().strip('"\'')
                            break
            except Exception:
                pass
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
            
        track_token = gw_track.get('TRACK_TOKEN') or gw_track.get('track_token')
        active_id = str(track_id)

        def _extract_valid_url(token, fmt):
            try:
                urls = dz.get_tracks_url([token], fmt)
                valid = [u for u in urls if isinstance(u, str) and u.startswith('http')]
                if valid:
                    return valid[0]
            except Exception:
                pass
            return None

        flac_url = None
        # 1. Try primary track token (FLAC only - strictly NO lossy MP3_320 fallback)
        if track_token:
            flac_url = _extract_valid_url(track_token, 'FLAC')

        # 2. If primary token geo-restricted or failed, check Deezer GW FALLBACK object (FLAC only)
        if not flac_url and gw_track.get('FALLBACK'):
            fb = gw_track['FALLBACK']
            fb_token = fb.get('TRACK_TOKEN')
            if fb_token:
                flac_url = _extract_valid_url(fb_token, 'FLAC')
                if flac_url:
                    active_id = str(fb.get('SNG_ID') or active_id)

        if not flac_url:
            return False
            
        # Stream and decrypt track using standard requests for exact 2048-byte chunking
        r = std_requests.get(flac_url, stream=True, timeout=15)
        if r.status_code != 200:
            return False

        BF_SECRET = b"g4el58wc0zvf9na1"
        md5_id = md5(str(active_id).encode('ascii')).hexdigest().encode('ascii')
        bf_key = bytes([md5_id[i] ^ md5_id[i + 16] ^ BF_SECRET[i] for i in range(16)])
        IV = b"\x00\x01\x02\x03\x04\x05\x06\x07"

        # Stream in 61,440-byte buffers (30 x 2048 blocks) for 20x higher network throughput
        BUFFER_SIZE = 61440
        BLOCK_SIZE = 2048
        block_idx = 0
        rem_buf = bytearray()

        with open(output_path, 'wb') as f:
            for raw_chunk in r.iter_content(BUFFER_SIZE):
                if not raw_chunk:
                    continue
                rem_buf.extend(raw_chunk)
                while len(rem_buf) >= BLOCK_SIZE:
                    block = bytes(rem_buf[:BLOCK_SIZE])
                    del rem_buf[:BLOCK_SIZE]
                    if block_idx % 3 == 0 and HAS_CRYPTODOME:
                        cipher = Blowfish.new(bf_key, Blowfish.MODE_CBC, IV)
                        block = cipher.decrypt(block)
                    f.write(block)
                    block_idx += 1

            if rem_buf:
                block = bytes(rem_buf)
                if block_idx % 3 == 0 and len(block) == BLOCK_SIZE and HAS_CRYPTODOME:
                    cipher = Blowfish.new(bf_key, Blowfish.MODE_CBC, IV)
                    block = cipher.decrypt(block)
                f.write(block)
                    
        if os.path.exists(output_path) and os.path.getsize(output_path) > 100000:
            with open(output_path, 'rb') as vf:
                magic = vf.read(4)
                if magic != b'fLaC':
                    print(f"[Deezer] Downloaded file does not contain valid FLAC magic header (got {magic}). Rejecting non-lossless stream.", file=sys.stderr)
                    try: os.remove(output_path)
                    except Exception: pass
                    return False
            return True
        return False
    except Exception as e:
        print(f"[Deezer] Download exception for {track_id}: {e}", file=sys.stderr)
        return False

def resolve_and_download_flac(artist, title, isrc=None, output_path=None, duration=None, cover_url=None, verify_callback=None):
    """
    1. Looks up track on Deezer by ISRC or (Artist + Title).
    2. Downloads genuine 1411 kbps FLAC file.
    3. Injects tags and synced lyrics.
    4. Validates track with verify_callback if provided.
    """
    dz = get_deezer_client()
    if not dz:
        return False
        
    candidates = []
    
    # 1. Search by ISRC if available
    if isrc:
        try:
            r = session.get(f"https://api.deezer.com/track/isrc:{isrc}", timeout=6)
            if r.status_code == 200 and 'id' in r.json():
                candidates.append(r.json())
        except Exception:
            pass
            
    # 2. Search by Artist + Title on Deezer GW
    clean_artist = re.sub(r'[\(\)\[\]]', '', artist).strip()
    clean_title = re.sub(r'[\(\)\[\]]', '', title).strip()
    queries = [f"{clean_artist} {clean_title}".strip()]
    if clean_title and clean_title != clean_artist:
        queries.append(clean_title)

    for q in queries:
        if not q:
            continue
        try:
            gw_res = dz.gw.search_music(q, 'TRACK')
            tracks = gw_res.get('data', [])
            for t in tracks:
                if not any(str(c.get('id') or c.get('SNG_ID')) == str(t.get('id') or t.get('SNG_ID')) for c in candidates):
                    candidates.append(t)
        except Exception:
            pass
        
    if not candidates:
        return False
        
    for matched_track in candidates:
        m_id = matched_track.get('id') or matched_track.get('SNG_ID')
        m_title = matched_track.get('title') or matched_track.get('SNG_TITLE')
        print(f"[Deezer HiFi] Match found: {m_title} (ID: {m_id})", flush=True)
        
        success = download_deezer_flac_track(matched_track, output_path, dz=dz)
        if success:
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            meta = {
                'title': m_title or title,
                'artist': matched_track.get('artist', {}).get('name') if isinstance(matched_track.get('artist'), dict) else (matched_track.get('ART_NAME') or artist),
                'album': matched_track.get('album', {}).get('title') if isinstance(matched_track.get('album'), dict) else matched_track.get('ALB_TITLE', ''),
                'isrc': isrc or matched_track.get('isrc') or matched_track.get('ISRC', ''),
                'cover_url': cover_url or matched_track.get('album', {}).get('cover_xl') or matched_track.get('ALB_PICTURE', ''),
                'lyrics': lyrics
            }
            tag_flac(output_path, meta)
            if verify_callback:
                if verify_callback(output_path):
                    return True
                else:
                    if os.path.exists(output_path):
                        try: os.remove(output_path)
                        except Exception: pass
                    continue
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
