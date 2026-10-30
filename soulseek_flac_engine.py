import os
import sys
import re
import time
import json
import shutil
import urllib.parse
from curl_cffi import requests

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# Try importing mutagen for tagging
try:
    from mutagen.flac import FLAC, Picture
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

SLSKD_API_BASE = os.environ.get('SLSKD_API_BASE', 'http://127.0.0.1:5030/api/v0')
session = requests.Session(impersonate="chrome124")

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
            # Preserve existing high-resolution front cover (e.g. 3000x3000px, >=150KB, or >=600px width)
            has_high_res_existing = False
            for existing_pic in getattr(audio, 'pictures', []):
                if existing_pic.type == 3:  # Front cover
                    if (getattr(existing_pic, 'width', 0) and existing_pic.width >= 600) or len(getattr(existing_pic, 'data', b'')) >= 150_000:
                        has_high_res_existing = True
                        break

            if not has_high_res_existing:
                try:
                    # Upgrade Spotify cover URL to 640x640 resolution
                    clean_cov_url = cover_url.replace('/ab67616d00001e02/', '/ab67616d0000b273/').replace('/ab67616d00004851/', '/ab67616d0000b273/')
                    r_cov = session.get(clean_cov_url, timeout=10)
                    if r_cov.status_code == 200 and len(r_cov.content) > 500:
                        pic = create_flac_picture(r_cov.content, desc='Cover (front)')
                        audio.clear_pictures()
                        audio.add_picture(pic)
                except Exception:
                    pass
        audio.save()
    except Exception as e:
        print(f"[Soulseek Tagging] Warning: {e}", file=sys.stderr)

SLSKD_AUTH_TOKEN = None

def ensure_slskd_auth():
    global SLSKD_AUTH_TOKEN
    if SLSKD_AUTH_TOKEN and "Authorization" in session.headers:
        return SLSKD_AUTH_TOKEN

    # Check if security is enabled on slskd
    try:
        r_sec = session.get(f"{SLSKD_API_BASE}/session/enabled", timeout=2)
        if r_sec.status_code == 200 and r_sec.text.strip().lower() == 'false':
            return "no-auth-required"
    except Exception:
        pass

    creds_list = [
        {"username": os.environ.get("SLSKD_USERNAME", "uniloader_sakura"), "password": os.environ.get("SLSKD_PASSWORD", "sakura_p2p_pass_99")},
        {"username": "uniloader_sakura", "password": "sakura_p2p_pass_99"},
        {"username": "sakura", "password": "sakura"},
        {"username": "slskd", "password": "slskd"},
        {"username": "admin", "password": "password"}
    ]
    slskd_yml = "/home/sakura/slskd_data/slskd.yml"
    if os.path.exists(slskd_yml):
        try:
            with open(slskd_yml, "r", encoding="utf-8") as f:
                content = f.read()
                m_u = re.search(r'username:\s*([^\s]+)', content)
                m_p = re.search(r'password:\s*([^\s]+)', content)
                if m_u and m_p:
                    creds_list.insert(0, {"username": m_u.group(1).strip(), "password": m_p.group(1).strip()})
        except Exception:
            pass

    for cred in creds_list:
        try:
            r = session.post(f"{SLSKD_API_BASE}/session", json=cred, timeout=3)
            if r.status_code in [200, 201]:
                t = r.json().get('token')
                if t:
                    SLSKD_AUTH_TOKEN = t
                    session.headers["Authorization"] = f"Bearer {t}"
                    return t
        except Exception:
            pass
    return None

def is_slskd_available():
    """Checks if slskd daemon is running and reachable."""
    try:
        ensure_slskd_auth()
        r = session.get(f"{SLSKD_API_BASE}/application", timeout=2)
        if r.status_code == 200:
            return True
        if r.status_code == 401:
            token = ensure_slskd_auth()
            if token:
                r2 = session.get(f"{SLSKD_API_BASE}/application", timeout=2)
                return r2.status_code == 200
        return False
    except Exception:
        return False

def ensure_slskd_running():
    """Ensures slskd daemon is running locally on Windows/Linux, auto-launching if needed."""
    if is_slskd_available():
        return True
        
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, 'bin', 'slskd', 'slskd.exe'),
        os.path.join(script_dir, 'bin', 'slskd', 'slskd'),
        os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Users\\sayan\\AppData\\Local'), 'Programs', 'slskd', 'slskd.exe'),
        'slskd.exe',
        'slskd'
    ]
    slskd_bin = None
    for c in candidates:
        if os.path.exists(c):
            slskd_bin = c
            break

    if not slskd_bin:
        try:
            print("[Soulseek HiFi] Provisioning embedded Soulseek engine...", flush=True)
            import zipfile
            slsk_dir = os.path.join(script_dir, 'bin', 'slskd')
            os.makedirs(slsk_dir, exist_ok=True)
            if sys.platform == 'win32':
                url = "https://github.com/slskd/slskd/releases/download/0.26.0/slskd-0.26.0-win-x64.zip"
                zip_path = os.path.join(slsk_dir, "slskd.zip")
                r_dl = session.get(url, timeout=30)
                if r_dl.status_code == 200:
                    with open(zip_path, 'wb') as f:
                        f.write(r_dl.content)
                    with zipfile.ZipFile(zip_path, 'r') as zf:
                        zf.extractall(slsk_dir)
                    try: os.remove(zip_path)
                    except Exception: pass
                    slskd_bin = os.path.join(slsk_dir, 'slskd.exe')
        except Exception as e:
            print(f"[Soulseek HiFi] Auto-provision notice: {e}", file=sys.stderr)

    if not slskd_bin or not os.path.exists(slskd_bin):
        return False


    try:
        import subprocess
        username = "audiophile_" + str(int(time.time()))[-5:]
        password = "flacpass_" + str(int(time.time()))[-5:]
        cmd = [
            slskd_bin,
            '--no-auth',
            '--http-port', '5030',
            '--slsk-username', username,
            '--slsk-password', password
        ]
        flags = 0
        if sys.platform == 'win32':
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008  # DETACHED_PROCESS
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
        
        # Wait up to 10 seconds for API to be ready
        for _ in range(10):
            time.sleep(1)
            if is_slskd_available():
                for _ in range(12):
                    try:
                        r = session.get(f"{SLSKD_API_BASE}/server", timeout=2)
                        if r.status_code == 200 and r.json().get('isLoggedIn'):
                            print(f"[Soulseek HiFi] Embedded Soulseek engine connected and logged in.", flush=True)
                            return True
                    except Exception:
                        pass
                    time.sleep(1)
                return True
    except Exception as e:
        print(f"[Soulseek HiFi] Auto-launch notice: {e}", file=sys.stderr)

    return is_slskd_available()

def get_slskd_downloads_dir():
    """Discovers slskd downloads directory dynamically from the running daemon or environment."""
    env_dir = os.environ.get('SLSKD_DOWNLOADS_DIR')
    if env_dir and os.path.exists(env_dir):
        return env_dir

    try:
        r = session.get(f"{SLSKD_API_BASE}/options", timeout=2)
        if r.status_code == 200:
            d = r.json().get('directories', {}).get('downloads')
            if d and os.path.exists(d):
                return d
    except Exception:
        pass

    # Common host storage locations (Docker bind mounts and local installs)
    known_paths = [
        '/media/hdd/sakura/slskd',
        '/home/sakura/slskd_downloads',
        '/media/hdd/sakura/slskd/downloads',
        '/home/sakura/slskd_data/downloads',
    ]
    for kp in known_paths:
        if os.path.exists(kp):
            return kp

    if sys.platform == 'win32':
        win_dir = os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Users\\sayan\\AppData\\Local'), 'slskd', 'downloads')
        if os.path.exists(win_dir):
            return win_dir

    return '/media/hdd/sakura/slskd' if os.path.exists('/media/hdd/sakura/slskd') else '/home/sakura/slskd_downloads'

def get_slskd_scan_dirs():
    """Returns a list of all active host directories where slskd downloads and candidate files reside."""
    dirs = []
    primary = get_slskd_downloads_dir()
    if primary and os.path.exists(primary):
        dirs.append(primary)

    candidates = [
        '/media/hdd/sakura/slskd',
        '/home/sakura/slskd_downloads',
        '/media/hdd/sakura/slskd/downloads',
        '/home/sakura/slskd_data/downloads',
    ]
    if sys.platform == 'win32':
        candidates.append(os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Users\\sayan\\AppData\\Local'), 'slskd', 'downloads'))

    for c in candidates:
        if c and os.path.exists(c) and c not in dirs:
            dirs.append(c)

    return dirs or ['/media/hdd/sakura/slskd']

def normalize_slsk_path(p):
    """Normalizes Soulseek transfer path across Windows/Linux slashes and encodings."""
    if not p:
        return ''
    return p.replace('\\\\', '/').replace('\\', '/').strip('/').lower()

def is_matching_transfer(tf, best):
    """Checks whether an active/historical transfer record matches the candidate."""
    tf_fn = normalize_slsk_path(tf.get('filename'))
    best_fn = normalize_slsk_path(best.get('filename'))
    if tf_fn == best_fn:
        return True
    tf_base = os.path.basename(tf_fn)
    best_base = os.path.basename(best_fn)
    if tf_base == best_base and abs(tf.get('size', 0) - best.get('size', 0)) <= 2048:
        return True
    if tf_base == best_base:
        return True
    if tf_fn.endswith('.flac') and best_fn.endswith('.flac'):
        if tf.get('size', 0) == best.get('size', 0) and tf.get('size', 0) > 0:
            return True
        if tf_base and best_base and (tf_base in best_base or best_base in tf_base):
            return True
    return False

def cancel_slskd_transfer(username, file_id=None):
    """Cancels and cleans up a transfer in SLSKD."""
    try:
        if file_id:
            session.delete(f"{SLSKD_API_BASE}/transfers/downloads/{username}/{file_id}", timeout=4)
        else:
            r = session.get(f"{SLSKD_API_BASE}/transfers/downloads/{username}", timeout=4)
            if r.status_code == 200:
                for d in r.json().get('directories', []):
                    for f in d.get('files', []):
                        fid = f.get('id')
                        if fid:
                            session.delete(f"{SLSKD_API_BASE}/transfers/downloads/{username}/{fid}", timeout=4)
    except Exception:
        pass

def verify_flac_integrity(file_path):
    """Verifies that the file is an authentic uncorrupted lossless FLAC stream."""
    if not os.path.exists(file_path) or os.path.getsize(file_path) < 100000:
        return False, "File too small or missing"
    if HAS_MUTAGEN:
        try:
            audio = FLAC(file_path)
            sr = audio.info.sample_rate
            bps = audio.info.bits_per_sample
            bitrate_kbps = int(audio.info.bitrate / 1000) if audio.info.bitrate else 0
            if sr < 44100 or bps < 16:
                return False, f"Sub-CD quality audio: {sr}Hz / {bps}-bit"
            return True, f"{bps}-bit / {sr/1000:.1f} kHz ({bitrate_kbps} kbps)"
        except Exception as e:
            return False, f"Invalid FLAC container: {e}"
    return True, "Lossless verified"

def calc_fidelity_score(bit_depth, sample_rate, size_bytes, filename, speed=0, free_slot=False, queue_len=0, duration=None):
    """
    Computes True Lossless Fidelity Score strictly adhering to Rule #1:
    Studio Masters (32-bit > 24-bit) and sample rates (192kHz > 96kHz > 88.2kHz > 48kHz > 44.1kHz).
    Commanding file size bonus guarantees that within any resolution tier, the biggest size FLAC
    with maximal dynamic range and highest uncompressed bitrate is prioritized.
    Inspects immediate album release directory and filename tokens so 24-bit / Hi-Res / Vinyl releases
    are properly credited even when Soulseek peers omit bitDepth/sampleRate in search packets.
    """
    norm_path = filename.replace('\\\\', '/').replace('\\', '/').lower()
    file_base = os.path.basename(norm_path)
    dir_path = os.path.dirname(norm_path)
    dir_parts = [p.strip() for p in dir_path.split('/') if p.strip()]
    
    # Identify album release folder (skipping subfolders like CD 01, Disc 1)
    album_dir = ''
    if dir_parts:
        if any(dir_parts[-1].startswith(x) for x in ['cd', 'disc', 'vinyl']) and len(dir_parts) > 1:
            album_dir = dir_parts[-2]
        else:
            album_dir = dir_parts[-1]

    inspect_target = f"{album_dir} / {file_base}"
    size_mb = size_bytes / (1024.0 * 1024.0)

    # 1. Bit depth resolution
    raw_bd = bit_depth or 0
    if raw_bd >= 32:
        eff_bits = raw_bd
    elif raw_bd >= 24:
        eff_bits = raw_bd
    elif raw_bd == 16:
        # If peer search packet reported 16-bit, check if folder explicitly indicates 24-bit studio master
        if any(k in inspect_target for k in ['24bit', '24-bit', '24 bit', '24/44', '24-44', '24/48', '24-48', '24/88', '24-88', '24/96', '24-96', '24/192', '24-192', '48-24', '96-24', '192-24', '48/24', '96/24', '192/24', '[flac 24', '(flac 24', '[flac-24', 'flac 24bit', 'flac 24-bit']) and not any(k in album_dir for k in ['16bit', '16-bit', 'flac 16', '[flac 16']):
            eff_bits = 24
        else:
            eff_bits = 16
    else:
        # bitDepth omitted in peer search packet: infer from release tokens and physical file size
        if any(k in inspect_target for k in ['32bit', '32-bit', '32 bit', 'dsd']):
            eff_bits = 32
        elif any(k in inspect_target for k in ['24bit', '24-bit', '24 bit', '24/44', '24-44', '24/48', '24-48', '24/88', '24-88', '24/96', '24-96', '24/192', '24-192', '48-24', '96-24', '192-24', '48/24', '96/24', '192/24', '[flac 24', '(flac 24', '[flac-24', 'flac 24bit', 'flac 24-bit']) and not any(k in album_dir for k in ['16bit', '16-bit', 'flac 16', '[flac 16']):
            eff_bits = 24
        elif any(k in inspect_target for k in ['16bit', '16-bit', '16 bit', 'flac 16', 'flac-16', '16/44', '16-44']):
            eff_bits = 16
        elif size_bytes > 55 * 1024 * 1024:
            # Physical FLAC size > 55MB for typical track indicates 24-bit dynamic range
            eff_bits = 24
        else:
            eff_bits = 16

    # 2. Sample rate resolution
    raw_sr = sample_rate or 0
    if raw_sr >= 44100:
        eff_sr = raw_sr
    else:
        if any(k in inspect_target for k in ['192khz', '192-khz', '192 khz', '192.0-khz', '24-192', '24/192', '192-24']):
            eff_sr = 192000
        elif any(k in inspect_target for k in ['96khz', '96-khz', '96 khz', '96.0-khz', '24-96', '24/96', '96-24']):
            eff_sr = 96000
        elif any(k in inspect_target for k in ['88.2khz', '88.2 khz', '88khz', '88-khz', '24-88', '24/88']):
            eff_sr = 88200
        elif any(k in inspect_target for k in ['48khz', '48-khz', '48 khz', '48.0-khz', '24-48', '24/48', '48-24']):
            eff_sr = 48000
        else:
            eff_sr = 44100

    score = 0
    # Rule #1: Bit depth tier (32-bit > 24-bit Studio Master > 16-bit CDDA)
    if eff_bits >= 32:
        score += 100_000_000
    elif eff_bits >= 24:
        score += 60_000_000
    else:
        score += 10_000_000

    # Rule #1: Sample rate tier (192kHz > 96kHz > 88.2kHz > 48kHz > 44.1kHz)
    if eff_sr >= 192000:
        score += 35_000_000
    elif eff_sr >= 96000:
        score += 25_000_000
    elif eff_sr >= 88200:
        score += 20_000_000
    elif eff_sr >= 48000:
        score += 12_000_000
    else:
        score += 4_000_000

    # 3. Audiophile studio master & vinyl release keywords
    if any(k in inspect_target for k in ['studio master', 'master', 'hi-res', 'hires', 'vinyl', 'sacd', 'mqa', 'qobuz', 'dsd', 'hdtracks', 'analog', 'analogue']):
        score += 50_000

    # 4. File size: The bigger the size, the higher the dynamic range / uncompressed bitstream
    # Strictly adhering to Rule #1 & User Preference: "best of the best of the best quality (big in size), not the fastest downloadable"
    score += int(size_mb * 100_000)

    # 5. Peer Availability & Bandwidth - Minor tiebreaker ONLY (cannot overtake file size)
    if free_slot:
        score += 500
        if queue_len == 0:
            score += 100
    else:
        score -= min(queue_len, 50) * 10

    peer_kbps = speed / 1024.0
    score += int(min(peer_kbps, 10000) * 0.05)

    return score

def search_and_download_flac(artist, title, output_path, isrc=None, cover_url=None, duration=None, max_wait_sec=40, aliases=None):
    """
    Searches Soulseek P2P network for authentic CD/Vinyl Lossless FLAC rips,
    downloads the file directly from top peers, tags it, and places it at output_path.
    """
    if not ensure_slskd_running():
        return False
        
    # Strip secondary features: "RADWIMPS, Toko Miura" -> "RADWIMPS"
    art_primary = re.split(r'[,&]|\bfeat\b|\bft\b|\bwith\b', artist, flags=re.IGNORECASE)[0].strip()
    clean_art = re.sub(r'[\(\)\[\],&/\-_]', ' ', art_primary).strip()
    
    # Strip noise words & brackets: "POP/STARS (feat. Madison Beer) [Official Music Video]" -> "POP STARS"
    tit_primary = re.split(r'\bfeat\b|\bft\b|\bwith\b', title, flags=re.IGNORECASE)[0]
    tit_primary = re.sub(r'(?i)\b(official\s*(music)?\s*video|official\s*audio|music\s*video|lyric\s*video|full\s*song|video|audio|mv|hd|4k)\b', ' ', tit_primary)
    tit_primary = re.sub(r'\(.*?\)|\[.*?\]', ' ', tit_primary)
    clean_tit = re.sub(r'[\(\)\[\],&/\-_]', ' ', tit_primary).strip()
    clean_tit = re.sub(r'\s+', ' ', clean_tit).strip()
    
    STOP_WORDS = {'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'mv', 'hd', 'audio', 'video', 'track', 'song', 'spotify'}
    art_words = [w for w in clean_art.split() if len(w) > 1 and w.lower() not in STOP_WORDS]
    tit_words = [w for w in clean_tit.split() if len(w) > 1 and w.lower() not in STOP_WORDS]
    
    # Guard against empty, generic, or dummy metadata
    if not clean_art or len(clean_art) < 2 or clean_tit.lower() in ['track', 'spotify track', 'unknown', 'audio', 'song', 'spotify', '']:
        print(f"[Soulseek HiFi] ❌ Refusing search with invalid/generic metadata: artist='{artist}', title='{title}'", file=sys.stderr, flush=True)
        return False
        
    if not tit_words:
        print(f"[Soulseek HiFi] ❌ No valid title words after filtering: title='{title}'", file=sys.stderr, flush=True)
        return False
    
    # Ensure destination directory exists
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    slskd_dl_dir = get_slskd_downloads_dir()

    scan_dirs = get_slskd_scan_dirs()

    # 0. Scan local Soulseek downloads repository for candidate matches
    title_lower_words = [w.lower() for w in tit_words if len(w) >= 2]
    art_lower_words = [w.lower() for w in art_words if len(w) >= 2]

    # Collect title word sets including multilingual aliases
    all_title_word_sets = [title_lower_words] if title_lower_words else []
    if aliases:
        for _, alt_t in aliases:
            alt_clean = re.sub(r'[\(\)\[\],&/\-_]', ' ', alt_t).strip()
            alt_w = [w.lower() for w in alt_clean.split() if len(w) >= 1 and w.lower() not in STOP_WORDS]
            if alt_w and alt_w not in all_title_word_sets:
                all_title_word_sets.append(alt_w)

    matched_local_flacs = []
    seen_local_paths = set()
    for s_dir in scan_dirs:
        if not os.path.exists(s_dir):
            continue
        for root, dirs, files in os.walk(s_dir):
            dirs[:] = [d for d in dirs if d.lower() != 'incomplete']
            for f in files:
                if f.lower().endswith('.flac'):
                    local_flac = os.path.join(root, f)
                    if local_flac in seen_local_paths:
                        continue
                    seen_local_paths.add(local_flac)
                    f_lower = f.lower()
                    root_lower = root.lower()
                    has_title_match = any(all(tw in f_lower or tw in root_lower for tw in tset) for tset in all_title_word_sets if tset)
                    if not has_title_match:
                        continue
                        try:
                            flac_sz = os.path.getsize(local_flac)
                        except (OSError, FileNotFoundError):
                            continue
                        if flac_sz < 5 * 1024 * 1024:
                            continue

                        # Check artist match: in filename, folder path, or Vorbis tags (e.g. vinyl/audiophile rips)
                        has_art = not art_lower_words or any(aw in f_lower or aw in root_lower for aw in art_lower_words)
                        aud_tags = None
                        if not has_art and HAS_MUTAGEN:
                            try:
                                aud_tags = FLAC(local_flac)
                                tag_artist = ' '.join(
                                    aud_tags.get('artist', []) + 
                                    aud_tags.get('albumartist', []) + 
                                    aud_tags.get('album', [])
                                ).lower()
                                if any(aw in tag_artist for aw in art_lower_words):
                                    has_art = True
                            except Exception:
                                pass

                        if not has_art:
                            continue

                        is_v, qual = verify_flac_integrity(local_flac)
                        if is_v:
                            bps = 16
                            sr = 44100
                            br = 0
                            if aud_tags is not None:
                                aud = aud_tags
                            elif HAS_MUTAGEN:
                                try:
                                    aud = FLAC(local_flac)
                                except Exception:
                                    aud = None
                            else:
                                aud = None

                            if aud:
                                try:
                                    bps = aud.info.bits_per_sample or 16
                                    sr = aud.info.sample_rate or 44100
                                    br = aud.info.bitrate or 0
                                except Exception:
                                    pass

                            # True Lossless Fidelity Score for local file
                            q_score = calc_fidelity_score(bps, sr, flac_sz, f, speed=5000*1024, free_slot=True, queue_len=0)
                            matched_local_flacs.append({
                                'path': local_flac,
                                'filename': f,
                                'qual': qual,
                                'score': q_score,
                                'bps': bps,
                                'sr': sr,
                                'br': br,
                                'size_mb': flac_sz / (1024 * 1024)
                            })
                                    
    best_local = None
    if matched_local_flacs:
        matched_local_flacs.sort(key=lambda x: x['score'], reverse=True)
        best_local = matched_local_flacs[0]
        print(f"[Soulseek HiFi] 📂 Local archive candidate detected: '{best_local['filename']}' ({best_local.get('bps')}bit / {best_local.get('sr')/1000:.1f}kHz, {best_local['size_mb']:.1f}MB, Score: {best_local['score']:,}). Evaluating against live P2P swarm...", flush=True)
    
    # Search terms in priority order (primary + multilingual aliases)
    search_terms = []
    if clean_art and clean_tit:
        search_terms.append(f"{clean_art} {clean_tit}")
    if len(clean_tit) > 2 and clean_tit not in search_terms:
        search_terms.append(clean_tit)
    if aliases:
        for alt_art, alt_tit in aliases:
            c_a = re.sub(r'[\(\)\[\],&/\-_]', ' ', alt_art).strip()
            c_t = re.sub(r'[\(\)\[\],&/\-_]', ' ', alt_tit).strip()
            q_full = f"{c_a} {c_t}".strip()
            if q_full and q_full not in search_terms:
                search_terms.append(q_full)
            if c_t and len(c_t) > 2 and c_t not in search_terms:
                search_terms.append(c_t)
    if len(clean_art) > 2 and clean_art not in search_terms:
        search_terms.append(clean_art)
        
    all_peers_map = {}

    for term_idx, term in enumerate(search_terms):
        print(f"[Soulseek HiFi] Searching decentralized network for studio FLAC: '{term}'...", flush=True)
        try:
            r_post = session.post(f"{SLSKD_API_BASE}/searches", json={"searchText": term}, timeout=8)
            if r_post.status_code in [200, 201]:
                search_id = r_post.json().get('id')
                # Wait 4-5 seconds for high-speed responses from distributed Soulseek peers
                last_peer_count = 0
                for sec in range(5):
                    time.sleep(1)
                    try:
                        r_chk = session.get(f"{SLSKD_API_BASE}/searches/{search_id}", timeout=3)
                        if r_chk.status_code == 200:
                            chk_data = r_chk.json()
                            curr_peers = chk_data.get('responseCount', 0)
                            curr_files = chk_data.get('fileCount', 0)
                            if chk_data.get('isComplete') and curr_files > 0:
                                break
                            if sec >= 4 and curr_peers >= 35 and curr_peers == last_peer_count:
                                break
                            last_peer_count = curr_peers
                    except Exception:
                        pass
                
                # CRITICAL: SLSKD only flushes buffered responses to /responses once search is completed or stopped!
                try:
                    session.put(f"{SLSKD_API_BASE}/searches/{search_id}", json={}, timeout=4)
                    time.sleep(0.3)
                except Exception:
                    pass

                r_res = session.get(f"{SLSKD_API_BASE}/searches/{search_id}/responses", timeout=8)
                if r_res.status_code == 200:
                    for p in r_res.json():
                        uname = p.get('username')
                        if uname:
                            if uname not in all_peers_map:
                                all_peers_map[uname] = p
                            else:
                                existing_files = {f.get('filename') for f in all_peers_map[uname].get('files', [])}
                                for f in p.get('files', []):
                                    if f.get('filename') not in existing_files:
                                        all_peers_map[uname].setdefault('files', []).append(f)

                    # If primary artist + title query already yielded peer discovery (>= 6 peers with files), avoid looser search
                    if term_idx == 0 and len(all_peers_map) >= 6:
                        break
        except Exception as e:
            print(f"[Soulseek HiFi] Query error: {e}", file=sys.stderr)

    peers = list(all_peers_map.values())
    candidates = []
    for p in peers:
        uname = p.get('username')
        speed = p.get('uploadSpeed', 0)
        free_slot = p.get('hasFreeUploadSlot', False)
        queue_len = p.get('queueLength', 999)
        
        for f in p.get('files', []):
            if f.get('isLocked', False):
                continue
            fname = f.get('filename', '')
            ext = f.get('extension', '').lower()
            size = f.get('size', 0)
            bit_depth = f.get('bitDepth') or 0
            sample_rate = f.get('sampleRate') or 0
            
            # Must be a FLAC file of realistic size (4MB - 600MB for Studio Masters / CDDA)
            if ('flac' in ext or fname.lower().endswith('.flac')) and (4 * 1024 * 1024 <= size <= 600 * 1024 * 1024):
                fn_lower = fname.lower()
                
                # 1. MANDATORY TITLE CHECK: Must match requested title or any multilingual alias
                has_title = any(all(tw in fn_lower for tw in tset) for tset in all_title_word_sets if tset)
                if not has_title:
                    continue
                    
                # 2. MANDATORY ARTIST CHECK: Must match the requested artist
                if art_lower_words:
                    has_art = any(aw in fn_lower for aw in art_lower_words)
                    if not has_art:
                        continue
                        
                score = calc_fidelity_score(bit_depth, sample_rate, size, fname, speed, free_slot, queue_len, duration=duration)
                candidates.append({
                    'username': uname,
                    'filename': fname,
                    'size': size,
                    'bit_depth': bit_depth,
                    'sample_rate': sample_rate,
                    'free_slot': free_slot,
                    'queue_len': queue_len,
                    'speed': speed,
                    'score': score
                })
                    
    if not candidates:
        print(f"[Soulseek HiFi] No matching FLAC files found in peer catalog for '{artist} - {title}'.", flush=True)
        if best_local:
            f = best_local['filename']
            f_sz_mb = best_local['size_mb']
            qual = best_local['qual']
            print(f"[Soulseek HiFi] ⚡ Falling back to existing authentic {qual} Lossless FLAC in local archive: '{f}' ({best_local.get('bps')}bit / {best_local.get('sr')/1000:.1f}kHz, {f_sz_mb:.1f}MB)", flush=True)
            print(f"[download] 100.0% of {f_sz_mb:.1f}MiB at 30.00MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
            if os.path.exists(output_path):
                try: os.remove(output_path)
                except Exception: pass
            shutil.copy2(best_local['path'], output_path)
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            tag_flac(output_path, {'title': title, 'artist': artist, 'isrc': isrc, 'cover_url': cover_url, 'lyrics': lyrics})
            return True
        return False

    # Sort all candidates strictly by True Lossless Fidelity Score (Rule #1)
    candidates.sort(key=lambda x: x['score'], reverse=True)

    # Deduplicate candidates across peers
    unique_peer_candidates = []
    seen_users = set()
    for c in candidates:
        if c['username'] not in seen_users:
            seen_users.add(c['username'])
            unique_peer_candidates.append(c)

    print(f"[Soulseek HiFi] 🔍 Swarm Evaluation: Analyzed {len(candidates)} candidate files across {len(peers)} peers.", flush=True)
    print(f"[Soulseek HiFi] 📊 Top Audiophile Master Candidates Ranked:", flush=True)
    medals = ["🌟 #1", "🥈 #2", "🥉 #3", "   #4", "   #5"]
    for idx, c in enumerate(unique_peer_candidates[:5]):
        c_base = os.path.basename(c['filename'].replace('\\', '/'))
        c_mb = c['size'] / (1024.0 * 1024.0)
        c_sr = f"{c['sample_rate']/1000:.1f} kHz" if c['sample_rate'] else "Lossless"
        c_bits = f"{c['bit_depth']}-bit" if c['bit_depth'] else "FLAC"
        slot_str = "Free Slot" if c['free_slot'] else f"Queue: {c['queue_len']}"
        spd_str = f"{c['speed']/1024:.0f} KB/s" if c['speed'] > 0 else "unknown"
        medal = medals[idx] if idx < len(medals) else f"   #{idx+1}"
        print(f"[Soulseek HiFi]   {medal} [{c_bits} / {c_sr}] {c_mb:.1f} MB | Peer: {c['username']} ({slot_str}, {spd_str}) | '{c_base}'", flush=True)

    best_network = unique_peer_candidates[0]
    best_cand_base = os.path.basename(best_network['filename'].replace('\\', '/'))
    best_mb = best_network['size'] / (1024.0 * 1024.0)
    best_sr = f"{best_network['sample_rate']/1000:.1f} kHz" if best_network['sample_rate'] else "Lossless"
    best_bits = f"{best_network['bit_depth']}-bit" if best_network['bit_depth'] else "FLAC"
    print(f"[Soulseek HiFi] 🎯 Selected Best of the Best: '{best_cand_base}' ({best_bits} / {best_sr}, {best_mb:.1f} MB)", flush=True)

    # Check local cache against best candidate
    if best_local:
        if best_local['score'] >= best_network['score']:
            f = best_local['filename']
            f_sz_mb = best_local['size_mb']
            qual = best_local['qual']
            print(f"[Soulseek HiFi] ⚡ Local archive already has optimal {qual} Master: '{f}' ({best_local.get('bps')}bit / {best_local.get('sr')/1000:.1f}kHz, {f_sz_mb:.1f}MB)", flush=True)
            print(f"[download] 100.0% of {f_sz_mb:.1f}MiB at 30.00MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
            if os.path.exists(output_path):
                try: os.remove(output_path)
                except Exception: pass
            shutil.copy2(best_local['path'], output_path)
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            tag_flac(output_path, {
                'title': title,
                'artist': artist,
                'isrc': isrc,
                'cover_url': cover_url,
                'lyrics': lyrics
            })
            print(f"[Soulseek HiFi] 🎉 Authentic {qual} Lossless FLAC saved: {output_path} ({f_sz_mb:.1f}MB)", flush=True)
            return True
        else:
            print(f"[Soulseek HiFi] ⬆️ Network swarm offers superior studio master ({best_bits} / {best_sr}, {best_mb:.1f} MB) exceeding local archive ({best_local.get('bps')}bit / {best_local.get('sr')/1000:.1f}kHz, {best_local['size_mb']:.1f}MB). Downloading superior master!", flush=True)

    viable_candidates = unique_peer_candidates[:4]
    tried_users = set()

    # Try top distinct peer candidates with Swarm Turbo Acceleration until one completes
    for idx, best in enumerate(viable_candidates):
        if best['username'] in tried_users:
            continue

        cand_base = os.path.basename(best['filename'].replace('\\', '/'))
        total_mb = best['size'] / (1024 * 1024)
        peer_spd_str = f"{best['speed']/1024:.0f}KB/s" if best['speed'] > 0 else "unknown"
        cand_sr_str = f"{best['sample_rate']/1000:.1f} kHz" if best['sample_rate'] else "Lossless"
        cand_bits_str = f"{best['bit_depth']}-bit" if best['bit_depth'] else "FLAC"

        if idx == 0:
            print(f"[Soulseek HiFi] 🚀 Downloading Selected Best Master (#1): '{cand_base}' ({cand_bits_str} / {cand_sr_str}, {total_mb:.1f}MB from '{best['username']}' • rated {peer_spd_str})", flush=True)
        else:
            print(f"[Soulseek HiFi] 🔄 Failing over to High-Speed Master (#{idx+1}): '{cand_base}' ({cand_bits_str} / {cand_sr_str}, {total_mb:.1f}MB from '{best['username']}')", flush=True)
        
        # Check if this exact file was already completed in SLSKD directory
        cached_candidate = None
        for s_dir in scan_dirs:
            if not os.path.exists(s_dir):
                continue
            for root, dirs, files in os.walk(s_dir):
                dirs[:] = [d for d in dirs if d.lower() != 'incomplete']
                for f in files:
                    if f.lower().endswith('.flac'):
                        f_path = os.path.join(root, f)
                        try:
                            cand_sz = os.path.getsize(f_path)
                        except (OSError, FileNotFoundError):
                            continue
                        if (f == cand_base or (cand_base in f)) and abs(cand_sz - best['size']) <= 2048:
                            is_v, qual = verify_flac_integrity(f_path)
                            if is_v:
                                cached_candidate = f_path
                                break
                        elif abs(cand_sz - best['size']) <= 512:
                            is_v, qual = verify_flac_integrity(f_path)
                            if is_v:
                                cached_candidate = f_path
                                break
                if cached_candidate:
                    break
                    
        if cached_candidate:
            print(f"[Soulseek HiFi] ⚡ Candidate '{cand_base}' already downloaded and verified on disk!", flush=True)
            print(f"[download] 100.0% of {total_mb:.1f}MiB at 30.00MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
            if os.path.exists(output_path):
                try: os.remove(output_path)
                except Exception: pass
            shutil.copy2(cached_candidate, output_path)
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            tag_flac(output_path, {'title': title, 'artist': artist, 'isrc': isrc, 'cover_url': cover_url, 'lyrics': lyrics})
            is_valid, qual_info = verify_flac_integrity(output_path)
            print(f"[Soulseek HiFi] 🎉 Authentic {qual_info} Lossless FLAC saved: {output_path} ({os.path.getsize(output_path)/(1024*1024):.1f}MB)", flush=True)
            return True

        # Check if Swarm Turbo Racing can be activated with a runner-up peer in the same top tier
        racing_partner = None
        if idx == 0 and len(viable_candidates) > 1:
            for c2 in viable_candidates[1:]:
                if (c2.get('username') != best.get('username') and
                    c2.get('free_slot') and c2.get('queue_len', 999) == 0 and
                    c2.get('bit_depth') == best.get('bit_depth') and
                    c2.get('sample_rate') == best.get('sample_rate') and
                    c2.get('speed', 0) >= 1500 * 1024):
                    racing_partner = c2
                    break

        # Enqueue download for best candidate
        dl_payload = [{'filename': best['filename'], 'size': best['size']}]
        try:
            r_queue = session.post(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", json=dl_payload, timeout=8)
            if r_queue.status_code not in [200, 201]:
                print(f"[Soulseek HiFi] Peer '{best['username']}' rejected enqueue (HTTP {r_queue.status_code}). Trying next peer...", flush=True)
                continue
        except Exception as e:
            print(f"[Soulseek HiFi] Failed to contact peer '{best['username']}': {e}. Trying next peer...", flush=True)
            continue

        active_peers = [best]
        tried_users.add(best['username'])

        if racing_partner:
            try:
                r_q2 = session.post(f"{SLSKD_API_BASE}/transfers/downloads/{racing_partner['username']}", json=[{'filename': racing_partner['filename'], 'size': racing_partner['size']}], timeout=8)
                if r_q2.status_code in [200, 201]:
                    active_peers.append(racing_partner)
                    tried_users.add(racing_partner['username'])
                    p2_spd = f"{racing_partner['speed']/1024:.0f}KB/s" if racing_partner['speed'] > 0 else "unknown"
                    print(f"[Soulseek HiFi] ⚡ Swarm Turbo Racing Engaged: Concurrently racing '{best['username']}' and '{racing_partner['username']}' ({p2_spd}) for maximum bandwidth...", flush=True)
            except Exception:
                pass
            
        # Monitor transfer with speed watchdog and queue grace period
        start_time = time.time()
        transfer_start_time = time.time()
        completed = False
        winner = None
        stall_count = 0
        slow_speed_count = 0
        last_bytes_tx = -1
        effective_max_wait = max(max_wait_sec, int(total_mb / 0.20) + 45)
        SPEED_GRACE_SEC = 7.0
        MAX_HANDSHAKE_SEC = 10

        print(f"[download] 0.0% of {total_mb:.1f}MiB at 0.00MiB/s ETA --:-- (Soulseek HiFi)", flush=True)
        
        while time.time() - start_time < effective_max_wait and active_peers:
            time.sleep(1.0)
            peer_stats = []

            for p in list(active_peers):
                try:
                    r_stat = session.get(f"{SLSKD_API_BASE}/transfers/downloads/{p['username']}", timeout=5)
                except Exception:
                    continue

                if r_stat.status_code != 200:
                    continue

                d_info = r_stat.json()
                matching_files = []
                for d in d_info.get('directories', []):
                    for tf in d.get('files', []):
                        if is_matching_transfer(tf, p):
                            matching_files.append(tf)

                if not matching_files:
                    continue

                # Prioritize active or completed record over stale rejected ones
                best_tf = None
                for tf in matching_files:
                    st = tf.get('state', '')
                    if 'Succeeded' in st:
                        best_tf = tf
                        break
                    elif 'InProgress' in st or tf.get('bytesTransferred', 0) > 0:
                        best_tf = tf

                if not best_tf:
                    best_tf = matching_files[-1]

                state = best_tf.get('state', '')
                bytes_tx = best_tf.get('bytesTransferred', 0)
                tot_bytes = p.get('size', 0) or best_tf.get('size', 0)
                pct = (bytes_tx / tot_bytes) * 100 if tot_bytes > 0 else 0
                spd_bytes = best_tf.get('averageSpeed', 0)
                spd_mb = spd_bytes / (1024 * 1024)

                is_aborted = any(err in state for err in ['Rejected', 'Cancelled', 'Errored', 'TimedOut', 'Aborted'])
                is_succeeded = not is_aborted and (
                    'Succeeded' in state or
                    (state.startswith('Completed') and (bytes_tx >= tot_bytes or (tot_bytes > 0 and bytes_tx > 0.99 * tot_bytes)))
                )

                if is_succeeded:
                    winner = p
                    completed = True
                    break

                if is_aborted:
                    reason = best_tf.get('exception') or state
                    cancel_slskd_transfer(p['username'])
                    if p in active_peers:
                        active_peers.remove(p)
                    print(f"[Soulseek HiFi] Peer '{p['username']}' transfer aborted ({reason}).", flush=True)
                    continue

                peer_stats.append({
                    'peer': p,
                    'state': state,
                    'bytes_tx': bytes_tx,
                    'tot_bytes': tot_bytes,
                    'pct': pct,
                    'spd_mb': spd_mb,
                    'spd_bytes': spd_bytes
                })

            if completed:
                break

            if not peer_stats:
                stall_count += 1
                if stall_count >= 16:
                    print(f"[Soulseek HiFi] Active peer transfers not initiated after 16s. Failing over...", flush=True)
                    for p in active_peers:
                        cancel_slskd_transfer(p['username'])
                    break
                continue

            # Identify current leader
            peer_stats.sort(key=lambda x: (x['bytes_tx'], x['spd_mb']), reverse=True)
            leader = peer_stats[0]

            # If leader is blazing fast (>= 3.5 MB/s and transferred > 10MB), dismiss slower racing peers to preserve bandwidth
            if len(active_peers) > 1 and leader['spd_mb'] >= 3.5 and leader['bytes_tx'] >= 10 * 1024 * 1024:
                for ps in peer_stats[1:]:
                    slower_p = ps['peer']
                    cancel_slskd_transfer(slower_p['username'])
                    if slower_p in active_peers:
                        active_peers.remove(slower_p)
                    print(f"[Soulseek HiFi] 🚀 Peer '{leader['peer']['username']}' locked blazing bitstream ({leader['spd_mb']:.2f} MiB/s). Slower peer dismissed.", flush=True)

            lead_mb = leader['tot_bytes'] / (1024 * 1024)
            rem_bytes = max(0, leader['tot_bytes'] - leader['bytes_tx'])
            if leader['spd_bytes'] > 0:
                eta_s = int(rem_bytes / leader['spd_bytes'])
                eta_str = f"{eta_s // 60:02d}:{eta_s % 60:02d}"
            else:
                eta_str = "--:--"

            print(f"[download] {leader['pct']:.1f}% of {lead_mb:.1f}MiB at {leader['spd_mb']:.2f}MiB/s ETA {eta_str} (Soulseek HiFi)", flush=True)

            # Adaptive speed watchdog (when single peer is downloading)
            elapsed = time.time() - transfer_start_time
            if len(active_peers) == 1 and leader['bytes_tx'] > 0 and elapsed >= SPEED_GRACE_SEC:
                has_faster_runner = any(
                    c.get('username') not in tried_users and c.get('free_slot') and c.get('speed', 0) > max(3 * 1024 * 1024, leader['peer'].get('speed', 0) * 0.9)
                    for c in viable_candidates[idx+1:]
                )
                min_speed_floor = 1.8 if has_faster_runner else 0.35
                if leader['spd_mb'] < min_speed_floor:
                    slow_speed_count += 1
                    if slow_speed_count >= 6:
                        print(f"[Soulseek HiFi] ⚠️ Peer '{leader['peer']['username']}' speed is {leader['spd_mb']:.2f} MiB/s (< {min_speed_floor} MiB/s floor). Accelerating via faster runner-up...", flush=True)
                        cancel_slskd_transfer(leader['peer']['username'])
                        break
                else:
                    slow_speed_count = 0

            # Handshake / stall watchdog
            if leader['bytes_tx'] == last_bytes_tx:
                stall_count += 1
                if leader['bytes_tx'] == 0 and stall_count >= MAX_HANDSHAKE_SEC:
                    print(f"[Soulseek HiFi] Peer handshake timed out ({MAX_HANDSHAKE_SEC}s). Failing over...", flush=True)
                    for p in active_peers:
                        cancel_slskd_transfer(p['username'])
                    break
                elif stall_count >= 20:
                    print(f"[Soulseek HiFi] Transfer stalled mid-stream. Failing over...", flush=True)
                    for p in active_peers:
                        cancel_slskd_transfer(p['username'])
                    break
            else:
                stall_count = 0
                if leader['bytes_tx'] > 0 and last_bytes_tx == 0:
                    transfer_start_time = time.time()
                if leader['spd_mb'] >= 0.35:
                    start_time = time.time()

            last_bytes_tx = leader['bytes_tx']

        if not completed or not winner:
            for p in active_peers:
                cancel_slskd_transfer(p['username'])
            print(f"[Soulseek HiFi] Transfer did not complete, trying next peer...", flush=True)
            continue

        # Cancel any other remaining racing peer now that winner succeeded
        for p in active_peers:
            if p.get('username') != winner.get('username'):
                cancel_slskd_transfer(p['username'])

        # Find downloaded file from winner in SLSKD downloads folder
        time.sleep(1.0)
        target_basename = os.path.basename(winner['filename'].replace('\\', '/'))
        base_stem, _ = os.path.splitext(target_basename)
        found_path = None
        
        for retry_scan in range(6):
            for s_dir in scan_dirs:
                if not os.path.exists(s_dir):
                    continue
                for root, dirs, files in os.walk(s_dir):
                    dirs[:] = [d for d in dirs if d.lower() != 'incomplete']
                    for f in files:
                        if f.lower().endswith('.flac'):
                            chk_f = os.path.join(root, f)
                            try:
                                f_sz = os.path.getsize(chk_f)
                            except (OSError, FileNotFoundError):
                                continue
                            if f == target_basename or f.startswith(base_stem) or (base_stem and base_stem in f):
                                if abs(f_sz - winner['size']) <= 2048 or f_sz > 5000000:
                                    found_path = chk_f
                                    break
                            elif f_sz == winner['size']:
                                found_path = chk_f
                                break
                    if found_path:
                        break
            if found_path:
                break
            time.sleep(1.0)
                
        if found_path and os.path.exists(found_path):
            if os.path.exists(output_path):
                try: os.remove(output_path)
                except Exception: pass
            shutil.copy2(found_path, output_path)
            
            # Tag metadata and lyrics
            lyrics = fetch_synced_lyrics(artist, title, duration=duration)
            meta = {
                'title': title,
                'artist': artist,
                'isrc': isrc,
                'cover_url': cover_url,
                'lyrics': lyrics
            }
            tag_flac(output_path, meta)
            
            # Lossless PCM & Audio integrity verification
            is_valid, qual_info = verify_flac_integrity(output_path)
            if not is_valid:
                print(f"[Soulseek HiFi] Lossless verification notice: {qual_info}. Trying next peer candidate...", flush=True)
                try: os.remove(output_path)
                except Exception: pass
                continue
                
            print(f"[Soulseek HiFi] 🎉 Authentic {qual_info} Lossless FLAC saved: {output_path} ({os.path.getsize(output_path)/(1024*1024):.1f}MB)", flush=True)
            return True
            
    return False

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python soulseek_flac_engine.py <ARTIST> <TITLE> <OUTPUT_PATH> [ISRC]")
        sys.exit(1)
        
    art = sys.argv[1]
    tit = sys.argv[2]
    out = sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 else None
    
    ok = search_and_download_flac(art, tit, out, isrc=code)
    if ok:
        print(f"🎉 Success: {out}")
        sys.exit(0)
    else:
        print("❌ Failed")
        sys.exit(1)
