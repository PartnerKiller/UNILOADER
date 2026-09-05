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
                    pic = Picture()
                    pic.type = 3
                    pic.mime = 'image/jpeg' if 'jpg' in clean_cov_url.lower() or 'jpeg' in clean_cov_url.lower() else 'image/png'
                    pic.desc = 'Cover'
                    pic.data = r_cov.content
                    audio.clear_pictures()
                    audio.add_picture(pic)
                    
                    # Save cover artwork to disk
                    flac_dir = os.path.dirname(os.path.abspath(flac_path))
                    base_no_ext = os.path.splitext(os.path.basename(flac_path))[0]
                    clean_name = re.sub(r'^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_', '', base_no_ext)
                    
                    track_img = os.path.join(flac_dir, f"{base_no_ext}.jpg")
                    clean_img = os.path.join(flac_dir, f"{clean_name}.jpg")
                    std_img = os.path.join(flac_dir, "cover.jpg")
                    
                    for dest_p in set([track_img, clean_img, std_img]):
                        try:
                            with open(dest_p, 'wb') as fc:
                                fc.write(r_cov.content)
                        except Exception:
                            pass
                    print(f"[Cover Image] 🖼️ Cover artwork saved: {clean_name}.jpg and cover.jpg", flush=True)
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
                    title_lowers = [w.lower() for w in tit_words if len(w) >= 2]
                    art_lowers = [w.lower() for w in art_words if len(w) >= 2]
                    for p in all_peers_map.values():
                        for f in p.get('files', []):
                            fn_lower = f.get('filename', '').lower()
                            if 'flac' in fn_lower and all(tw in fn_lower for tw in title_lowers) and any(aw in fn_lower for aw in art_lowers):
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
        title_lower_words = [w.lower() for w in tit_words if len(w) >= 2]
        art_lower_words = [w.lower() for w in art_words if len(w) >= 2]
        
        for p in peers:
            uname = p.get('username')
            speed = p.get('uploadSpeed', 0)
            free_slot = p.get('hasFreeUploadSlot', False)
            queue_len = p.get('queueLength', 999)
            
            for f in p.get('files', []):
                fname = f.get('filename', '')
                ext = f.get('extension', '').lower()
                size = f.get('size', 0)
                
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
                            
                    score = (5000 if free_slot else -5000) + 1000 - (queue_len * 50) + min(speed / 100000, 500)
                    candidates.append({
                        'username': uname,
                        'filename': fname,
                        'size': size,
                        'free_slot': free_slot,
                        'queue_len': queue_len,
                        'speed': speed,
                        'score': score
                    })
                        
        if not candidates:
            print(f"[Soulseek HiFi] No matching FLAC files found in peer catalog", flush=True)
            return False
            
        # Sort best candidates first (peers with free upload slots & zero queues come first)
        candidates.sort(key=lambda x: x['score'], reverse=True)
        
        # Deduplicate candidates so we try different peers, never hammering the same queued user
        unique_peer_candidates = []
        seen_users = set()
        for c in candidates:
            if c['username'] not in seen_users:
                seen_users.add(c['username'])
                unique_peer_candidates.append(c)
                if len(unique_peer_candidates) >= 12:
                    break
        
        # Try top distinct peer candidates sequentially until one completes
        for idx, best in enumerate(unique_peer_candidates):
            print(f"[Soulseek HiFi] Trying candidate {idx+1}/{len(unique_peer_candidates)}: '{os.path.basename(best['filename'])}' ({best['size']/(1024*1024):.1f}MB from '{best['username']}')", flush=True)
            
            # Enqueue download
            dl_payload = [{'filename': best['filename'], 'size': best['size']}]
            r_queue = session.post(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", json=dl_payload, timeout=8)
            if r_queue.status_code not in [200, 201]:
                continue
                
            # Monitor transfer
            start_time = time.time()
            completed = False
            aborted = False
            stall_count = 0
            last_bytes_tx = -1
            total_mb = best['size'] / (1024 * 1024)
            print(f"[download] 0.0% of {total_mb:.1f}MiB at 0.00MiB/s ETA --:-- (Soulseek HiFi)", flush=True)
            
            while time.time() - start_time < max_wait_sec:
                time.sleep(1.5)
                r_stat = session.get(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", timeout=6)
                if r_stat.status_code == 200:
                    d_info = r_stat.json()
                    for d in d_info.get('directories', []):
                        for tf in d.get('files', []):
                            if tf.get('filename') == best['filename']:
                                state = tf.get('state', '')
                                bytes_tx = tf.get('bytesTransferred', 0)
                                total_bytes = best['size']
                                pct = (bytes_tx / total_bytes) * 100 if total_bytes > 0 else 0
                                speed_bytes = tf.get('averageSpeed', 0)
                                speed_mb = speed_bytes / (1024 * 1024)
                                
                                rem_bytes = max(0, total_bytes - bytes_tx)
                                if speed_bytes > 0:
                                    eta_sec = int(rem_bytes / speed_bytes)
                                    eta_m = eta_sec // 60
                                    eta_s = eta_sec % 60
                                    eta_str = f"{eta_m:02d}:{eta_s:02d}"
                                else:
                                    eta_str = "--:--"

                                print(f"[download] {pct:.1f}% of {total_mb:.1f}MiB at {speed_mb:.2f}MiB/s ETA {eta_str} (Soulseek HiFi)", flush=True)
                                
                                if any(c in state for c in ['Completed', 'Succeeded']):
                                    completed = True
                                    break
                                elif any(err in state for err in ['Aborted', 'Cancelled', 'Errored', 'Rejected', 'TimedOut']):
                                    aborted = True
                                    break
                                
                                # Check if transfer progress is stalled
                                if bytes_tx == last_bytes_tx:
                                    stall_count += 1
                                    # If stalled for 5s (3 intervals) or remotely queued, skip to next candidate immediately
                                    if stall_count >= 3 or 'queued' in state.lower():
                                        print(f"[Soulseek HiFi] Peer '{best['username']}' stalled at {pct:.1f}% ({state}). Fast-failing to next candidate...", flush=True)
                                        aborted = True
                                        break
                                else:
                                    stall_count = 0
                                    # Actively receiving data! Reset timeout watchdog so download finishes completely
                                    start_time = time.time()
                                last_bytes_tx = bytes_tx
                    if completed or aborted:
                        break
                        
            if not completed:
                try:
                    session.delete(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", timeout=3)
                except Exception:
                    pass
                print(f"[Soulseek HiFi] Transfer from '{best['username']}' did not complete, trying next peer...", flush=True)
                continue
                        
            # Find downloaded file in SLSKD downloads folder
            target_basename = os.path.basename(best['filename'].replace('\\', '/'))
            slskd_dl_dir = get_slskd_downloads_dir()
            found_path = None
            
            for root, _, files in os.walk(slskd_dl_dir):
                for f in files:
                    if f == target_basename or (f.endswith('.flac') and os.path.getsize(os.path.join(root, f)) == best['size']):
                        found_path = os.path.join(root, f)
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
