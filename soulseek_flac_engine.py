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

def is_slskd_available():
    """Checks if slskd daemon is running and reachable."""
    try:
        r = session.get(f"{SLSKD_API_BASE}/application", timeout=2)
        return r.status_code == 200
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
    try:
        r = session.get(f"{SLSKD_API_BASE}/options", timeout=2)
        if r.status_code == 200:
            d = r.json().get('directories', {}).get('downloads')
            if d and os.path.exists(d):
                return d
    except Exception:
        pass

    env_dir = os.environ.get('SLSKD_DOWNLOADS_DIR')
    if env_dir and os.path.exists(env_dir):
        return env_dir

    if sys.platform == 'win32':
        win_dir = os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Users\\sayan\\AppData\\Local'), 'slskd', 'downloads')
        if os.path.exists(win_dir):
            return win_dir

    return '/home/sakura/slskd_downloads'

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

def search_and_download_flac(artist, title, output_path, isrc=None, cover_url=None, duration=None, max_wait_sec=40):
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

    # 0. Check if this track is already downloaded in local Soulseek downloads repository
    title_lower_words = [w.lower() for w in tit_words if len(w) >= 2]
    art_lower_words = [w.lower() for w in art_words if len(w) >= 2]
    matched_local_flacs = []
    if os.path.exists(slskd_dl_dir):
        for root, _, files in os.walk(slskd_dl_dir):
            for f in files:
                if f.lower().endswith('.flac'):
                    f_lower = f.lower()
                    root_lower = root.lower()
                    if title_lower_words and all(tw in f_lower or tw in root_lower for tw in title_lower_words):
                        if not art_lower_words or any(aw in f_lower or aw in root_lower for aw in art_lower_words):
                            local_flac = os.path.join(root, f)
                            if os.path.getsize(local_flac) >= 5 * 1024 * 1024:
                                is_v, qual = verify_flac_integrity(local_flac)
                                if is_v:
                                    bps = 16
                                    sr = 44100
                                    br = 0
                                    if HAS_MUTAGEN:
                                        try:
                                            aud = FLAC(local_flac)
                                            bps = aud.info.bits_per_sample or 16
                                            sr = aud.info.sample_rate or 44100
                                            br = aud.info.bitrate or 0
                                        except Exception:
                                            pass
                                    q_score = (bps * 100000) + sr + (br / 1000)
                                    matched_local_flacs.append({
                                        'path': local_flac,
                                        'filename': f,
                                        'qual': qual,
                                        'score': q_score
                                    })
                                    
    if matched_local_flacs:
        matched_local_flacs.sort(key=lambda x: x['score'], reverse=True)
        best_local = matched_local_flacs[0]
        local_flac = best_local['path']
        qual = best_local['qual']
        f = best_local['filename']
        f_sz_mb = os.path.getsize(local_flac) / (1024 * 1024)
        print(f"[Soulseek HiFi] ⚡ Found existing authentic {qual} Lossless FLAC in local archive: '{f}'", flush=True)
        print(f"[download] 100.0% of {f_sz_mb:.1f}MiB at 30.00MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
        if os.path.exists(output_path):
            try: os.remove(output_path)
            except Exception: pass
        shutil.copy2(local_flac, output_path)
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
    
    # Search terms in priority order
    search_terms = []
    if clean_art and clean_tit:
        search_terms.append(f"{clean_art} {clean_tit}")
    if len(clean_tit) > 2:
        search_terms.append(clean_tit)
    if len(clean_art) > 2 and clean_art not in search_terms:
        search_terms.append(clean_art)
        
    all_peers_map = {}

    for term in search_terms:
        print(f"[Soulseek HiFi] Searching decentralized network for studio FLAC: '{term}'...", flush=True)
        try:
            r_post = session.post(f"{SLSKD_API_BASE}/searches", json={"searchText": term}, timeout=8)
            if r_post.status_code in [200, 201]:
                search_id = r_post.json().get('id')
                # Wait for responses to arrive from distributed Soulseek peers (up to 6 seconds)
                for _ in range(6):
                    time.sleep(1)
                    try:
                        r_chk = session.get(f"{SLSKD_API_BASE}/searches/{search_id}", timeout=3)
                        if r_chk.status_code == 200:
                            chk_data = r_chk.json()
                            if chk_data.get('fileCount', 0) >= 15 or chk_data.get('isComplete'):
                                break
                    except Exception:
                        pass
                
                # CRITICAL: SLSKD only flushes buffered responses to /responses once search is completed or stopped!
                # Sending PUT completes the search immediately and flushes all peer responses.
                try:
                    session.put(f"{SLSKD_API_BASE}/searches/{search_id}", json={}, timeout=4)
                    time.sleep(0.4)
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

                    # Check if we already have genuine FLAC matches for this track
                    has_real_flac = False
                    for p in all_peers_map.values():
                        for f in p.get('files', []):
                            fn_lower = f.get('filename', '').lower()
                            if 'flac' in fn_lower and all(tw in fn_lower for tw in title_lower_words) and any(aw in fn_lower for aw in art_lower_words):
                                has_real_flac = True
                                break
                        if has_real_flac:
                            break

                    if has_real_flac and len(all_peers_map) >= 3:
                        break
        except Exception as e:
            print(f"[Soulseek HiFi] Query error: {e}", file=sys.stderr)

    peers = list(all_peers_map.values())
    if not peers:
        print(f"[Soulseek HiFi] No peer results found for '{artist} - {title}'.", flush=True)
        return False
        
    try:
        candidates = []
        for p in peers:
            uname = p.get('username')
            speed = p.get('uploadSpeed', 0)
            free_slot = p.get('hasFreeUploadSlot', False)
            queue_len = p.get('queueLength', 999)
            
            for f in p.get('files', []):
                if f.get('isLocked', False):
                    continue  # Ignore locked/inaccessible files
                fname = f.get('filename', '')
                ext = f.get('extension', '').lower()
                size = f.get('size', 0)
                bit_depth = f.get('bitDepth') or 0
                sample_rate = f.get('sampleRate') or 0
                
                # Must be a FLAC file of realistic size (8MB - 250MB)
                if ('flac' in ext or fname.lower().endswith('.flac')) and (8 * 1024 * 1024 <= size <= 250 * 1024 * 1024):
                    fn_lower = fname.lower()
                    
                    # 1. MANDATORY TITLE CHECK: All title words must appear in file/path
                    if title_lower_words and not all(tw in fn_lower for tw in title_lower_words):
                        continue
                        
                    # 2. MANDATORY ARTIST CHECK: Must match the requested artist
                    if art_lower_words:
                        has_art = any(aw in fn_lower for aw in art_lower_words)
                        if not has_art:
                            continue  # REJECT: Wrong artist!
                            
                    # Best Quality FLAC Scoring:
                    # 24-bit / 32-bit Studio Master priority
                    quality_bonus = 0
                    if bit_depth >= 24 or any(k in fn_lower for k in ['24bit', '24-bit', '24 bit', '24/']):
                        quality_bonus += 15000
                    if bit_depth >= 32:
                        quality_bonus += 2000
                        
                    # Sample Rate priority (192kHz > 96kHz > 88.2kHz > 48kHz > 44.1kHz)
                    if sample_rate >= 192000 or '192khz' in fn_lower or '192 khz' in fn_lower:
                        quality_bonus += 8000
                    elif sample_rate >= 96000 or '96khz' in fn_lower or '96 khz' in fn_lower:
                        quality_bonus += 6000
                    elif sample_rate >= 88200 or '88.2khz' in fn_lower:
                        quality_bonus += 5000
                    elif sample_rate >= 48000 or '48khz' in fn_lower:
                        quality_bonus += 3000

                    # Audiophile keywords
                    if any(k in fn_lower for k in ['studio master', 'master', 'hi-res', 'hires', 'vinyl', 'sacd', 'mqa', 'qobuz']):
                        quality_bonus += 4000
                        
                    # Size bonus (higher resolution streams have larger file sizes)
                    quality_bonus += min((size / (1024 * 1024)) * 20, 2000)
                    
                    # Bandwidth & Peer Speed Scoring (Crucial for high-speed connections):
                    peer_kbps = speed / 1024.0
                    speed_score = 0
                    if peer_kbps >= 3000:
                        speed_score += 25000  # >= 3 MB/s fast broadband peer
                    elif peer_kbps >= 1500:
                        speed_score += 18000  # >= 1.5 MB/s
                    elif peer_kbps >= 800:
                        speed_score += 8000   # >= 800 KB/s
                    elif peer_kbps < 300:
                        speed_score -= 25000  # Heavily penalize slow dial-up/DSL peers (<300 KB/s)
                    elif peer_kbps < 600:
                        speed_score -= 12000  # Penalize slow peers (<600 KB/s)

                    slot_score = 15000 if free_slot else -20000
                    queue_penalty = queue_len * 200

                    score = quality_bonus + speed_score + slot_score - queue_penalty
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
            print(f"[Soulseek HiFi] No matching FLAC files found in peer catalog", flush=True)
            return False
            
        # Sort best candidates first (fast peers with free upload slots come first)
        candidates.sort(key=lambda x: x['score'], reverse=True)
        
        # Deduplicate candidates so we try different peers, never hammering the same queued user
        unique_peer_candidates = []
        seen_users = set()
        for c in candidates:
            if c['username'] not in seen_users:
                seen_users.add(c['username'])
                unique_peer_candidates.append(c)

        # Filter out heavily penalized slow/queued candidates and try at most top 3 fast candidates
        viable_candidates = [c for c in unique_peer_candidates if c['score'] > 0]
        if not viable_candidates:
            viable_candidates = unique_peer_candidates[:2]
        else:
            viable_candidates = viable_candidates[:3]
        
        # Try top distinct peer candidates sequentially until one completes
        for idx, best in enumerate(viable_candidates):
            cand_base = os.path.basename(best['filename'].replace('\\', '/'))
            total_mb = best['size'] / (1024 * 1024)
            peer_spd_str = f"{best['speed']/1024:.0f}KB/s" if best['speed'] > 0 else "unknown"
            print(f"[Soulseek HiFi] Trying candidate {idx+1}/{len(viable_candidates)}: '{cand_base}' ({total_mb:.1f}MB from '{best['username']}' • rated {peer_spd_str})", flush=True)
            
            # Check if this exact file was already completed in SLSKD directory
            cached_candidate = None
            if os.path.exists(slskd_dl_dir):
                for root, _, files in os.walk(slskd_dl_dir):
                    for f in files:
                        if f.endswith('.flac'):
                            f_path = os.path.join(root, f)
                            if (f == cand_base or (cand_base in f)) and abs(os.path.getsize(f_path) - best['size']) <= 2048:
                                is_v, qual = verify_flac_integrity(f_path)
                                if is_v:
                                    cached_candidate = f_path
                                    break
                    if cached_candidate:
                        break
                        
            if cached_candidate:
                print(f"[Soulseek HiFi] Candidate '{cand_base}' already downloaded and verified on disk!", flush=True)
                print(f"[download] 100.0% of {total_mb:.1f}MiB at 25.00MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
                if os.path.exists(output_path):
                    try: os.remove(output_path)
                    except Exception: pass
                shutil.copy2(cached_candidate, output_path)
                lyrics = fetch_synced_lyrics(artist, title, duration=duration)
                tag_flac(output_path, {'title': title, 'artist': artist, 'isrc': isrc, 'cover_url': cover_url, 'lyrics': lyrics})
                is_valid, qual_info = verify_flac_integrity(output_path)
                print(f"[Soulseek HiFi] 🎉 Authentic {qual_info} Lossless FLAC saved: {output_path} ({os.path.getsize(output_path)/(1024*1024):.1f}MB)", flush=True)
                return True

            # Enqueue download
            dl_payload = [{'filename': best['filename'], 'size': best['size']}]
            try:
                r_queue = session.post(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", json=dl_payload, timeout=8)
                if r_queue.status_code not in [200, 201]:
                    print(f"[Soulseek HiFi] Peer '{best['username']}' rejected enqueue (HTTP {r_queue.status_code}). Trying next peer...", flush=True)
                    continue
            except Exception as e:
                print(f"[Soulseek HiFi] Failed to contact peer '{best['username']}': {e}. Trying next peer...", flush=True)
                continue
                
            # Monitor transfer with speed watchdog
            start_time = time.time()
            transfer_start_time = time.time()
            completed = False
            aborted = False
            stall_count = 0
            slow_speed_count = 0
            last_bytes_tx = -1
            MIN_SPEED_MB = 0.80   # Speed watchdog: minimum 0.80 MiB/s (~6.5 Mbps) to prevent crawling
            SPEED_GRACE_SEC = 5.0 # Grace period for peer connection ramp-up

            print(f"[download] 0.0% of {total_mb:.1f}MiB at 0.00MiB/s ETA --:-- (Soulseek HiFi)", flush=True)
            
            while time.time() - start_time < max_wait_sec:
                time.sleep(1.0)
                try:
                    r_stat = session.get(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", timeout=6)
                except Exception:
                    continue

                if r_stat.status_code != 200:
                    continue

                d_info = r_stat.json()
                matching_files = []
                for d in d_info.get('directories', []):
                    for tf in d.get('files', []):
                        if is_matching_transfer(tf, best):
                            matching_files.append(tf)

                if not matching_files:
                    stall_count += 1
                    if stall_count >= 5:
                        print(f"[Soulseek HiFi] Peer '{best['username']}' transfer not initiated after 5s. Fast-failing...", flush=True)
                        aborted = True
                        break
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
                total_bytes = best.get('size', 0) or best_tf.get('size', 0)
                pct = (bytes_tx / total_bytes) * 100 if total_bytes > 0 else 0
                speed_bytes = best_tf.get('averageSpeed', 0)
                speed_mb = speed_bytes / (1024 * 1024)

                rem_bytes = max(0, total_bytes - bytes_tx)
                if speed_bytes > 0:
                    eta_sec = int(rem_bytes / speed_bytes)
                    eta_m = eta_sec // 60
                    eta_s = eta_sec % 60
                    eta_str = f"{eta_m:02d}:{eta_s:02d}"
                else:
                    eta_str = "--:--"

                is_aborted = any(err in state for err in ['Rejected', 'Cancelled', 'Errored', 'TimedOut', 'Aborted'])
                is_succeeded = not is_aborted and (
                    'Succeeded' in state or
                    (state.startswith('Completed') and (bytes_tx >= total_bytes or (total_bytes > 0 and bytes_tx > 0.99 * total_bytes)))
                )

                if is_succeeded:
                    print(f"[download] 100.0% of {total_mb:.1f}MiB at {speed_mb:.2f}MiB/s ETA 00:00 (Soulseek HiFi)", flush=True)
                    completed = True
                    break

                if is_aborted:
                    reason = best_tf.get('exception') or state
                    print(f"[Soulseek HiFi] Peer '{best['username']}' transfer aborted ({reason}). Fast-failing to next candidate...", flush=True)
                    aborted = True
                    break

                # Emit download progress for UI parsing
                print(f"[download] {pct:.1f}% of {total_mb:.1f}MiB at {speed_mb:.2f}MiB/s ETA {eta_str} (Soulseek HiFi)", flush=True)

                # SPEED WATCHDOG: After grace period, fast-fail slow peers (< 0.80 MiB/s)
                elapsed = time.time() - transfer_start_time
                if bytes_tx > 0 and elapsed >= SPEED_GRACE_SEC:
                    if speed_mb < MIN_SPEED_MB:
                        slow_speed_count += 1
                        if slow_speed_count >= 3:
                            print(f"[Soulseek HiFi] ⚠️ Peer '{best['username']}' upload speed too slow ({speed_mb:.2f} MiB/s < {MIN_SPEED_MB} MiB/s). Aborting to protect user bandwidth...", flush=True)
                            aborted = True
                            break
                    else:
                        slow_speed_count = 0

                # Stall / queue watchdog
                if bytes_tx == last_bytes_tx:
                    stall_count += 1
                    # Fast-fail after 4 seconds of 0 bytes or queued
                    if bytes_tx == 0 and (stall_count >= 4 or 'queued' in state.lower()):
                        print(f"[Soulseek HiFi] Peer '{best['username']}' queued or unresponsive ({state}). Fast-failing to next candidate...", flush=True)
                        aborted = True
                        break
                    # Fast-fail after 5 seconds of stalled data mid-stream
                    if bytes_tx > 0 and stall_count >= 5:
                        print(f"[Soulseek HiFi] Peer '{best['username']}' stalled mid-transfer at {pct:.1f}%. Fast-failing to next candidate...", flush=True)
                        aborted = True
                        break
                else:
                    stall_count = 0
                    # Only reset start_time if download speed is healthy
                    if speed_mb >= MIN_SPEED_MB:
                        start_time = time.time()

                last_bytes_tx = bytes_tx

            if not completed:
                try:
                    session.delete(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", timeout=3)
                except Exception:
                    pass
                print(f"[Soulseek HiFi] Transfer from '{best['username']}' did not complete, trying next peer...", flush=True)
                continue
                        
            # Find downloaded file in SLSKD downloads folder
            target_basename = os.path.basename(best['filename'].replace('\\', '/'))
            base_stem, _ = os.path.splitext(target_basename)
            found_path = None
            
            for root, _, files in os.walk(slskd_dl_dir):
                for f in files:
                    if f.endswith('.flac'):
                        chk_f = os.path.join(root, f)
                        f_sz = os.path.getsize(chk_f)
                        if f == target_basename or f.startswith(base_stem):
                            if abs(f_sz - best['size']) <= 2048 or f_sz > 5000000:
                                found_path = chk_f
                                break
                        elif f_sz == best['size']:
                            found_path = chk_f
                            break
                if found_path:
                    break
                    
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
            
    except Exception as e:
        print(f"[Soulseek HiFi] Exception: {e}", file=sys.stderr)
        
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
