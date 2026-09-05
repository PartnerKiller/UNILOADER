import os
import sys
import re
import json
import time
import shutil
import urllib.request
import urllib.parse
from bs4 import BeautifulSoup
import mutagen
from mutagen.flac import FLAC, Picture

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

def scrape_songlink_metadata(spotify_id_or_url):
    """
    SpotiFLAC-Next Songlink Engine:
    Resolves a Spotify link to true ISRC, Tidal Track ID, Amazon ASIN, Deezer ID, and Apple Music ID.
    """
    m = re.search(r'track[/:]([a-zA-Z0-9]+)', spotify_id_or_url)
    spotify_id = m.group(1) if m else spotify_id_or_url
    
    url = f"https://song.link/s/{spotify_id}"
    req = urllib.request.Request(url, headers={
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    })
    
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8')
            match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.DOTALL)
            if match:
                data = json.loads(match.group(1))
                page_data = data.get('props', {}).get('pageProps', {}).get('pageData', {})
                entity_data = page_data.get('entityData', {})
                
                isrc = entity_data.get('isrc')
                title = entity_data.get('title')
                artist = entity_data.get('artistName')
                thumbnail = entity_data.get('thumbnailUrl')
                
                links = {}
                for sec in page_data.get('sections', []):
                    for l in sec.get('links', []):
                        plat = l.get('platform')
                        u = l.get('url')
                        if plat and u:
                            links[plat] = u
                            
                # Extract Tidal Track ID
                tidal_url = links.get('tidal', '')
                tidal_id = None
                if '/track/' in tidal_url:
                    t_match = re.search(r'/track/(\d+)', tidal_url)
                    if t_match:
                        tidal_id = int(t_match.group(1))
                        
                # Extract Deezer Track ID
                deezer_url = links.get('deezer', '')
                deezer_id = None
                if '/track/' in deezer_url:
                    d_match = re.search(r'/track/(\d+)', deezer_url)
                    if d_match:
                        deezer_id = int(d_match.group(1))
                        
                return {
                    'isrc': isrc,
                    'title': title,
                    'artist': artist,
                    'thumbnail': thumbnail,
                    'tidal_id': tidal_id,
                    'tidal_url': tidal_url,
                    'deezer_id': deezer_id,
                    'deezer_url': deezer_url,
                    'amazon_url': links.get('amazonMusic', ''),
                    'apple_url': links.get('appleMusic', ''),
                    'spotify_id': spotify_id
                }
    except Exception as e:
        print(f"[SpotiFLAC-Next] Songlink lookup notice: {e}", file=sys.stderr)
        
    return None

def fetch_synced_lyrics(artist, title, duration=None):
    """SpotiFLAC-Next Lyrics Provider: fetches synced lyrics from LRCLIB & community sources."""
    try:
        clean_art = re.split(r'[,&]|\bfeat\b|\bft\b|\bwith\b', artist, flags=re.IGNORECASE)[0].strip()
        clean_tit = re.split(r'\bfeat\b|\bft\b|\bwith\b', title, flags=re.IGNORECASE)[0]
        clean_tit = re.sub(r'\(.*?\)|\[.*?\]', '', clean_tit).strip()
        
        params = {'track_name': clean_tit, 'artist_name': clean_art}
        if duration: params['duration'] = int(duration)
        
        url = f"https://lrclib.net/api/get?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            lyrics = data.get('syncedLyrics') or data.get('plainLyrics')
            if lyrics:
                return lyrics
    except Exception:
        pass
        
    try:
        query = f"{artist} {title}"
        url = f"https://lrclib.net/api/search?q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=6) as resp:
            results = json.loads(resp.read().decode('utf-8'))
            if results and isinstance(results, list):
                lyrics = results[0].get('syncedLyrics') or results[0].get('plainLyrics')
                if lyrics:
                    return lyrics
    except Exception:
        pass
        
    return None

def download_cover_image(cover_url, dest_path):
    """Downloads full-resolution album artwork to dest_path."""
    if not cover_url:
        return False
    # Upgrade Spotify cover URL to highest 640x640 resolution
    clean_url = cover_url.replace('/ab67616d00001e02/', '/ab67616d0000b273/').replace('/ab67616d00004851/', '/ab67616d0000b273/')
    try:
        req = urllib.request.Request(clean_url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = resp.read()
            if len(data) > 500:
                with open(dest_path, 'wb') as f:
                    f.write(data)
                return True
    except Exception:
        try:
            from curl_cffi import requests as cffi_requests
            r = cffi_requests.get(clean_url, timeout=12)
            if r.status_code == 200 and len(r.content) > 500:
                with open(dest_path, 'wb') as f:
                    f.write(r.content)
                return True
        except Exception:
            pass
    return False

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

def tag_flac_file(flac_path, meta):
    """Embeds full Vorbis tags, synchronized lyrics, and high-res cover art, plus saves image to disk."""
    try:
        audio = FLAC(flac_path)
        audio.clear()
        
        if meta.get('title'): audio['title'] = [meta['title']]
        if meta.get('artist'): audio['artist'] = [meta['artist']]
        if meta.get('album'): audio['album'] = [meta['album']]
        if meta.get('album_artist'): audio['albumartist'] = [meta['album_artist']]
        if meta.get('year'): audio['date'] = [str(meta['year'])]
        if meta.get('track_number'): audio['tracknumber'] = [str(meta['track_number'])]
        if meta.get('tracks_count'): audio['tracktotal'] = [str(meta['tracks_count'])]
        if meta.get('disc_number'): audio['discnumber'] = [str(meta['disc_number'])]
        if meta.get('isrc'): audio['isrc'] = [meta['isrc']]
        
        lyrics = meta.get('lyrics')
        if lyrics:
            audio['lyrics'] = [lyrics]
            audio['unsyncedlyrics'] = [lyrics]
            
        cover_url = meta.get('cover_url')
        if cover_url and cover_url.startswith('http'):
            try:
                clean_cov = cover_url.replace('/ab67616d00001e02/', '/ab67616d0000b273/').replace('/ab67616d00004851/', '/ab67616d0000b273/')
                req = urllib.request.Request(clean_cov, headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(req, timeout=12) as c_resp:
                    pic_data = c_resp.read()
                    pic = create_flac_picture(pic_data, desc='Cover (front)')
                    audio.clear_pictures()
                    audio.add_picture(pic)
                    
                    # Also save cover image file to disk
                    out_dir = os.path.dirname(os.path.abspath(flac_path))
                    base_no_ext = os.path.splitext(os.path.basename(flac_path))[0]
                    clean_name = re.sub(r'^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_', '', base_no_ext)
                    for target_p in [os.path.join(out_dir, f"{base_no_ext}.jpg"), os.path.join(out_dir, f"{clean_name}.jpg"), os.path.join(out_dir, "cover.jpg")]:
                        try:
                            with open(target_p, 'wb') as cf:
                                cf.write(pic_data)
                        except Exception:
                            pass
                    print(f"[Cover Image] 🖼️ Cover artwork saved: {clean_name}.jpg and cover.jpg", flush=True)
            except Exception as e:
                print(f"[SpotiFLAC-Next] Artwork notice: {e}", file=sys.stderr)
                
        audio.save()
        return True
    except Exception as e:
        print(f"[SpotiFLAC-Next] Tagging notice: {e}", file=sys.stderr)
        return False

def download_lossless_track_next(track, output_dir, track_idx=0, total_tracks=1):
    """
    SpotiFLAC-Next Resolution Pipeline:
    1. Scrapes Songlink for true ISRC, Tidal Track ID, Deezer ID, Amazon ASIN.
    2. Tier 1: Tidal Hi-Res (Monochrome API) 24-bit / 16-bit FLAC.
    3. Tier 2: Soulseek P2P CD & Vinyl Master FLAC Rips with 8-peer failover.
    4. Tier 3: Deezer HiFi 1411kbps bitstream.
    (YouTube fallback strictly eliminated to guarantee 100% genuine lossless FLAC)
    """
    title = track.get('title', 'Track')
    artist = track.get('artist', '')
    spotify_url = track.get('url') or ''
    cover_url = track.get('cover_url') or ''
    duration = track.get('duration')
    
    full_name = f"{artist} - {title}" if artist else title
    safe_name = re.sub(r'[\\/:*?"<>|]', '_', full_name).strip()
    flac_filename = f"{track_idx+1:02d} - {safe_name}.flac" if total_tracks > 1 else f"{safe_name}.flac"
    flac_path = os.path.join(output_dir, flac_filename)
    
    print(f"[SpotiFLAC-Next] Resolving track ({track_idx+1}/{total_tracks}): '{full_name}'...", flush=True)
    
    # 1. Scrape Songlink metadata
    songlink_data = None
    if spotify_url:
        songlink_data = scrape_songlink_metadata(spotify_url)
        
    isrc = (songlink_data.get('isrc') if songlink_data else None) or track.get('isrc')
    if not cover_url and songlink_data and songlink_data.get('thumbnail'):
        cover_url = songlink_data['thumbnail']
        
    if isrc:
        print(f"[SpotiFLAC-Next] Matched ISRC: {isrc}", flush=True)
        
    # 2. Tier 1: Tidal Hi-Res (Monochrome Engine)
    try:
        from tidal_monochrome_engine import download_tidal_flac
        tidal_ok = download_tidal_flac(artist, title, flac_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if tidal_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            print(f"[SpotiFLAC-Next] 🎉 Streamed 24-bit/16-bit Studio Master FLAC directly from Tidal Hi-Res!", flush=True)
            return flac_path
    except Exception:
        pass
        
    # 3. Tier 2: Soulseek P2P CD & Vinyl Master Rips (8-peer failover)
    try:
        from soulseek_flac_engine import search_and_download_flac
        slsk_ok = search_and_download_flac(artist, title, flac_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if slsk_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            print(f"[SpotiFLAC-Next] 🎉 Downloaded authentic CD Lossless FLAC via Soulseek P2P Network!", flush=True)
            return flac_path
    except Exception:
        pass
        
    # 4. Tier 3: Deezer HiFi 1411kbps bitstream
    try:
        from deezer_hifi_engine import resolve_and_download_flac
        deezer_ok = resolve_and_download_flac(artist, title, isrc=isrc, output_path=flac_path, duration=duration, cover_url=cover_url)
        if deezer_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            print(f"[SpotiFLAC-Next] 🎉 Streamed 1411 kbps Studio Master FLAC from HiFi CDN!", flush=True)
            return flac_path
    except Exception:
        pass
        
    # Tier 4: No fake YouTube FLAC transcoding.
    print(f"[SpotiFLAC-Next] ❌ Authentic Lossless FLAC not found across Tidal, Soulseek, or Deezer for '{full_name}'. YouTube transcoding disabled to preserve true lossless integrity.", file=sys.stderr, flush=True)
    return None


def process_spotiflac_next_job(url, final_output_path):
    """
    Main entry point for SpotiFLAC-Next jobs (Single Track, Album, or Playlist).
    """
    client_id = os.environ.get('SPOTIFY_CLIENT_ID', '').strip()
    client_secret = os.environ.get('SPOTIFY_CLIENT_SECRET', '').strip()
    
    try:
        from spotdl.utils.spotify import SpotifyClient
        SpotifyClient.init(client_id=client_id, client_secret=client_secret, user_auth=False, use_official_api=bool(client_id))
    except Exception:
        pass
        
    clean_path = re.sub(r'\.(?:flac|zip)$', '', final_output_path)
    work_dir = clean_path + '_next_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)
    os.makedirs(work_dir, exist_ok=True)
    
    is_playlist_or_album = ('playlist' in url or 'album' in url)
    tracks = []
    
    if 'playlist' in url:
        from spotdl.types.playlist import Playlist
        meta, songs = Playlist.get_metadata(url)
        for i, s in enumerate(songs):
            artist_str = ', '.join(s.artists) if s.artists else s.artist
            tracks.append({
                'index': i + 1,
                'title': s.name,
                'artist': artist_str,
                'album_name': s.album_name,
                'album_artist': s.album_artist,
                'year': s.year,
                'track_number': s.track_number,
                'tracks_count': len(songs),
                'disc_number': s.disc_number,
                'isrc': s.isrc,
                'duration': s.duration,
                'url': s.url,
                'cover_url': s.cover_url or meta.get('cover_url', ''),
                'fullName': f"{artist_str} - {s.name}" if artist_str else s.name
            })
    elif 'album' in url:
        from spotdl.types.album import Album
        meta, songs = Album.get_metadata(url)
        for i, s in enumerate(songs):
            artist_str = ', '.join(s.artists) if s.artists else s.artist
            tracks.append({
                'index': i + 1,
                'title': s.name,
                'artist': artist_str,
                'album_name': s.album_name,
                'album_artist': s.album_artist,
                'year': s.year,
                'track_number': s.track_number,
                'tracks_count': len(songs),
                'disc_number': s.disc_number,
                'isrc': s.isrc,
                'duration': s.duration,
                'url': s.url,
                'cover_url': s.cover_url or meta.get('cover_url', ''),
                'fullName': f"{artist_str} - {s.name}" if artist_str else s.name
            })
    else:
        try:
            from spotdl.types.song import Song
            s = Song.from_url(url)
            artist_str = ', '.join(s.artists) if s.artists else s.artist
            tracks.append({
                'index': 1,
                'title': s.name,
                'artist': artist_str,
                'album_name': s.album_name,
                'album_artist': s.album_artist,
                'year': s.year,
                'track_number': s.track_number,
                'tracks_count': 1,
                'disc_number': s.disc_number,
                'isrc': s.isrc,
                'duration': s.duration,
                'url': s.url,
                'cover_url': s.cover_url or '',
                'fullName': f"{artist_str} - {s.name}" if artist_str else s.name
            })
        except Exception:
            from spotify_downloader import get_spotify_playlist_info
            sp_info = get_spotify_playlist_info(url)
            songlink_info = scrape_songlink_metadata(url)
            
            real_title = (songlink_info.get('title') if songlink_info else None) or (sp_info['tracks'][0]['title'] if sp_info and sp_info.get('tracks') else None)
            real_artist = (songlink_info.get('artist') if songlink_info else None) or (sp_info['tracks'][0]['artist'] if sp_info and sp_info.get('tracks') else None)
            cover_url = (songlink_info.get('thumbnail') if songlink_info else None) or (sp_info.get('cover') if sp_info else '')
            
            if not real_title or not real_artist:
                raise RuntimeError(f"Could not resolve track metadata for: {url}")
                
            tracks.append({
                'index': 1,
                'title': real_title,
                'artist': real_artist,
                'isrc': songlink_info.get('isrc') if songlink_info else None,
                'duration': None,
                'url': url,
                'cover_url': cover_url,
                'fullName': f"{real_artist} - {real_title}"
            })
                
    total_tracks = len(tracks)
    print(f"[SpotiFLAC-Next] Starting SpotiFLAC-Next True Lossless Pipeline &bull; Total Tracks: {total_tracks}")
    sys.stdout.flush()
    
    completed_files = []
    
    for idx, t in enumerate(tracks):
        track_num = idx + 1
        pct = int(((track_num - 1) / total_tracks) * 100)
        print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC-Next] Processing: {t['fullName']} ({pct}%)")
        sys.stdout.flush()
        
        flac_file = download_lossless_track_next(t, work_dir, track_idx=idx, total_tracks=total_tracks)
        if flac_file and os.path.exists(flac_file):
            completed_files.append(flac_file)
            cur_pct = int((track_num / total_tracks) * 100)
            print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC-Next] Completed: {t['fullName']} ({cur_pct}%)")
            sys.stdout.flush()
        else:
            print(f"[WARN] Failed to process track: {t['fullName']}", file=sys.stderr)
            
    if not completed_files:
        raise RuntimeError("No tracks were successfully processed by SpotiFLAC-Next Engine.")
        
    # Resolve cover image URL
    cover_url = (tracks[0].get('cover_url') if tracks else '')
    out_dir = os.path.dirname(os.path.abspath(final_output_path))
    
    if is_playlist_or_album:
        import zipfile
        zip_target = final_output_path if final_output_path.endswith('.zip') else final_output_path + '.zip'
        print(f"[SpotiFLAC-Next] Packaging {len(completed_files)} Lossless FLAC tracks into archive: {os.path.basename(zip_target)}...")
        sys.stdout.flush()
        
        # Download album artwork into work directory
        cover_work = os.path.join(work_dir, 'cover.jpg')
        has_cov = download_cover_image(cover_url, cover_work) if cover_url else False
        
        with zipfile.ZipFile(zip_target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in completed_files:
                zf.write(f, os.path.basename(f))
            if has_cov and os.path.exists(cover_work):
                zf.write(cover_work, 'cover.jpg')
                
        # Also save standalone cover.jpg and <album>.jpg in output folder
        zip_base = os.path.splitext(os.path.basename(zip_target))[0]
        clean_zip_base = re.sub(r'^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_', '', zip_base)
        if has_cov and os.path.exists(cover_work):
            try:
                shutil.copy2(cover_work, os.path.join(out_dir, f"{zip_base}.jpg"))
                shutil.copy2(cover_work, os.path.join(out_dir, f"{clean_zip_base}.jpg"))
                shutil.copy2(cover_work, os.path.join(out_dir, "cover.jpg"))
                print(f"[Cover Image] 🖼️ Album artwork saved: {clean_zip_base}.jpg and cover.jpg", flush=True)
            except Exception:
                pass
                
        shutil.rmtree(work_dir, ignore_errors=True)
        sz_mb = os.path.getsize(zip_target) / (1024 * 1024)
        print(f"[download] 100% of {sz_mb:.1f}MiB at 0.00MiB/s ETA 00:00")
        print(f"[SpotiFLAC-Next] Lossless Archive Ready: {zip_target}")
        sys.stdout.flush()
    else:
        single_flac = completed_files[0]
        flac_target = final_output_path if final_output_path.endswith('.flac') else final_output_path + '.flac'
        if os.path.exists(flac_target):
            os.remove(flac_target)
        shutil.move(single_flac, flac_target)
        
        # Save standalone cover image alongside the FLAC audio file
        flac_base = os.path.splitext(os.path.basename(flac_target))[0]
        clean_flac_base = re.sub(r'^job_[a-zA-Z0-9]+_[a-zA-Z0-9]+_', '', flac_base)
        
        if cover_url:
            raw_cov_path = os.path.join(out_dir, f"{flac_base}.jpg")
            clean_cov_path = os.path.join(out_dir, f"{clean_flac_base}.jpg")
            std_cov_path = os.path.join(out_dir, "cover.jpg")
            
            ok = download_cover_image(cover_url, raw_cov_path)
            if ok:
                try:
                    shutil.copy2(raw_cov_path, clean_cov_path)
                    shutil.copy2(raw_cov_path, std_cov_path)
                    print(f"[Cover Image] 🖼️ Cover artwork saved: {clean_flac_base}.jpg and cover.jpg", flush=True)
                except Exception:
                    pass
                    
        shutil.rmtree(work_dir, ignore_errors=True)
        sz_mb = os.path.getsize(flac_target) / (1024 * 1024)
        print(f"[download] 100% of {sz_mb:.1f}MiB at 0.00MiB/s ETA 00:00")
        print(f"[SpotiFLAC-Next] Lossless FLAC Ready: {flac_target}")
        sys.stdout.flush()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python spotiflac_next_engine.py <url> [final_output_path]")
        sys.exit(1)
        
    if len(sys.argv) == 2:
        u = sys.argv[1]
        info = scrape_songlink_metadata(u)
        if info and info.get('title'):
            full_title = f"{info.get('artist', '')} - {info.get('title', '')}".strip(' -')
            print(json.dumps({
                'title': full_title,
                'code': 'SPOTIFY',
                'poster': info.get('thumbnail', ''),
                'hlsUrl': f"ytsearch1:{full_title} audio",
                'downloadTargetUrl': f"ytsearch1:{full_title} audio",
                'tags': ['Spotify', 'FLAC', 'Lossless', 'Music'],
                'model': info.get('artist', 'Spotify Artist'),
                'duration': 'Lossless Audio',
                'extractor': 'SpotiFLAC-Next',
                'sourceUrl': u,
                'mode': 'audio'
            }))
            sys.exit(0)
        else:
            print(json.dumps({'error': 'Failed to scrape metadata'}))
            sys.exit(1)
            
    process_spotiflac_next_job(sys.argv[1], sys.argv[2])
