import os
import sys
import re
import time
import json
import shutil
import urllib.parse
from curl_cffi import requests

# Try importing mutagen for tagging
try:
    from mutagen.flac import FLAC, Picture
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False

SLSKD_API_BASE = os.environ.get('SLSKD_API_BASE', 'http://127.0.0.1:5030/api/v0')
SLSKD_DOWNLOADS_DIR = os.environ.get('SLSKD_DOWNLOADS_DIR', '/home/sakura/slskd_downloads')

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
        print(f"[Soulseek Tagging] Warning: {e}", file=sys.stderr)

def is_slskd_available():
    """Checks if slskd daemon is running and reachable."""
    try:
        r = session.get(f"{SLSKD_API_BASE}/application", timeout=3)
        return r.status_code == 200
    except Exception:
        return False

def search_and_download_flac(artist, title, output_path, isrc=None, cover_url=None, duration=None, max_wait_sec=40):
    """
    Searches Soulseek P2P network for authentic CD/Vinyl Lossless FLAC rips,
    downloads the file directly from top peers, tags it, and places it at output_path.
    """
    if not is_slskd_available():
        return False
        
    # Strip secondary features: "RADWIMPS, Toko Miura" -> "RADWIMPS"
    art_primary = re.split(r'[,&]|\bfeat\b|\bft\b|\bwith\b', artist, flags=re.IGNORECASE)[0].strip()
    clean_art = re.sub(r'[\(\)\[\],&/\-_]', ' ', art_primary).strip()
    
    # Strip brackets and features: "Grand Escape (feat. Toko Miura)" -> "Grand Escape"
    tit_primary = re.split(r'\bfeat\b|\bft\b|\bwith\b', title, flags=re.IGNORECASE)[0]
    tit_primary = re.sub(r'\(.*?\)|\[.*?\]', ' ', tit_primary)
    clean_tit = re.sub(r'[\(\)\[\],&/\-_]', ' ', tit_primary).strip()
    
    art_words = [w for w in clean_art.split() if len(w) > 1]
    tit_words = [w for w in clean_tit.split() if len(w) > 1]
    
    # Search terms in priority order
    search_terms = []
    if clean_art and clean_tit:
        search_terms.append(f"{clean_art} {clean_tit}")
    if len(clean_tit) > 3:
        search_terms.append(clean_tit)
    if len(clean_art) > 3:
        search_terms.append(clean_art)
        
    peers = []
    search_id = None
    
    for term in search_terms:
        print(f"[Soulseek HiFi] Searching decentralized network for studio FLAC: '{term}'...", flush=True)
        try:
            r_post = session.post(f"{SLSKD_API_BASE}/searches", json={"searchText": term}, timeout=8)
            if r_post.status_code in [200, 201]:
                search_id = r_post.json().get('id')
                time.sleep(4)
                # Wait for responses
                for _ in range(3):
                    time.sleep(1)
                    r_chk = session.get(f"{SLSKD_API_BASE}/searches/{search_id}", timeout=4)
                    if r_chk.status_code == 200 and r_chk.json().get('fileCount', 0) > 60:
                        break
                r_res = session.get(f"{SLSKD_API_BASE}/searches/{search_id}/responses", timeout=8)
                if r_res.status_code == 200 and len(r_res.json()) > 0:
                    peers = r_res.json()
                    break
        except Exception as e:
            print(f"[Soulseek HiFi] Query error: {e}", file=sys.stderr)
            
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
                    # Check that ALL meaningful title words exist in the path/filename
                    if title_lower_words and all(tw in fn_lower for tw in title_lower_words):
                        # Bonus if artist name also matches
                        has_art = any(aw in fn_lower for aw in art_lower_words) if art_lower_words else True
                        score = (1500 if free_slot else 0) + (500 if has_art else 0) - (queue_len * 10) + min(speed / 100000, 500)
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
            
        # Sort best candidates first
        candidates.sort(key=lambda x: x['score'], reverse=True)
        
        # Try top candidates sequentially until one completes
        for idx, best in enumerate(candidates[:8]):
            print(f"[Soulseek HiFi] Trying candidate {idx+1}/{min(len(candidates), 8)}: '{os.path.basename(best['filename'])}' ({best['size']/(1024*1024):.1f}MB from '{best['username']}')", flush=True)
            
            # Enqueue download
            dl_payload = [{'filename': best['filename'], 'size': best['size']}]
            r_queue = session.post(f"{SLSKD_API_BASE}/transfers/downloads/{best['username']}", json=dl_payload, timeout=8)
            if r_queue.status_code not in [200, 201]:
                continue
                
            # Monitor transfer
            start_time = time.time()
            completed = False
            aborted = False
            
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
                                pct = (bytes_tx / best['size']) * 100 if best['size'] > 0 else 0
                                speed_mb = (tf.get('averageSpeed', 0) / (1024 * 1024))
                                print(f"[download] {pct:.1f}% of ~1 tracks at {speed_mb:.2f}MiB/s (Soulseek HiFi)", flush=True)
                                
                                if state in ['Completed', 'Succeeded']:
                                    completed = True
                                    break
                                elif any(err in state for err in ['Aborted', 'Cancelled', 'Errored', 'Rejected']):
                                    aborted = True
                                    break
                    if completed or aborted:
                        break
                        
            if not completed:
                print(f"[Soulseek HiFi] Transfer from '{best['username']}' did not complete, trying next peer...", flush=True)
                continue
                        
            # Find downloaded file in SLSKD downloads folder
            target_basename = os.path.basename(best['filename'].replace('\\', '/'))
            found_path = None
            
            for root, _, files in os.walk(SLSKD_DOWNLOADS_DIR):
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
                print(f"[Soulseek HiFi] 🎉 Authentic Studio FLAC saved: {output_path} ({os.path.getsize(output_path)/(1024*1024):.1f}MB)", flush=True)
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
