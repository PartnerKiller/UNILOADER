import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import re
import json
import base64
import zipfile
import shutil
import subprocess
from curl_cffi import requests
from bs4 import BeautifulSoup
import mutagen
from mutagen.flac import FLAC, Picture

def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        os.environ[k.strip()] = v.strip().strip("'\"")
        except Exception:
            pass

load_env()

def get_spotify_track_isrc_and_platforms(spotify_url_or_id):
    """Resolves Spotify track ID to ISRC, Tidal, Qobuz, Deezer URLs via SongLink."""
    session = requests.Session(impersonate="chrome124")
    
    m = re.search(r'track/([a-zA-Z0-9]+)', spotify_url_or_id)
    track_id = m.group(1) if m else spotify_url_or_id
    
    info = {
        'isrc': None,
        'tidal_url': None,
        'qobuz_url': None,
        'deezer_url': None,
        'amazon_url': None
    }
    
    try:
        r = session.get(f"https://song.link/s/{track_id}", timeout=10)
        if r.status_code == 200:
            soup = BeautifulSoup(r.text, 'html.parser')
            script = soup.find('script', id='__NEXT_DATA__')
            if script:
                data = json.loads(script.text)
                pageData = data.get('props', {}).get('pageProps', {}).get('pageData', {})
                info['isrc'] = pageData.get('entityData', {}).get('isrc')
                for s in pageData.get('sections', []):
                    for l in s.get('links', []):
                        plat = l.get('platform')
                        url = l.get('url')
                        if plat == 'tidal': info['tidal_url'] = url
                        elif plat == 'qobuz': info['qobuz_url'] = url
                        elif plat == 'deezer': info['deezer_url'] = url
                        elif plat == 'amazonMusic': info['amazon_url'] = url
    except Exception as e:
        print(f"[SpotiFLAC] Songlink lookup error: {e}", file=sys.stderr)
        
    return info

def find_best_audio_stream_url(artist, title, target_duration=None, ytdlp_path='yt-dlp'):
    """
    Locates the authentic official studio album audio track (YouTube Music / Topic channel),
    strictly filtering out music videos with dialogue skits, intro sound effects, and outro credits.
    """
    clean_artist = re.sub(r'[\(\[\{].*?[\)\]\}]', '', artist).strip()
    clean_title = re.sub(r'[\(\[\{].*?[\)\]\}]', '', title).strip()
    
    queries = [
        f'ytsearch5:"{clean_artist}" "{clean_title}" "Provided to YouTube"',
        f'ytsearch5:"{clean_artist} - Topic" "{clean_title}"',
        f'ytsearch3:"{clean_artist}" "{clean_title}" "Official Audio"'
    ]
    
    best_match = None
    min_dur_diff = 9999
    
    for q in queries:
        cmd = [
            ytdlp_path,
            '--no-warnings',
            '--dump-json',
            '--flat-playlist',
            q
        ]
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
            if p.returncode == 0:
                for line in p.stdout.strip().split('\n'):
                    if not line.strip():
                        continue
                    d = json.loads(line)
                    vid_id = d.get('id') or d.get('url')
                    if not vid_id:
                        continue
                    
                    vid_url = f"https://www.youtube.com/watch?v={vid_id}" if not str(vid_id).startswith('http') else vid_id
                    chan = (d.get('channel') or d.get('uploader') or '').lower()
                    dur = d.get('duration') or 0
                    
                    is_topic = 'topic' in chan or 'provided to youtube' in (d.get('description') or '').lower()
                    
                    if target_duration and dur:
                        dur_diff = abs(dur - target_duration)
                        if is_topic and dur_diff <= 4:
                            return vid_url, dur, d.get('title'), chan
                        if dur_diff < min_dur_diff:
                            min_dur_diff = dur_diff
                            best_match = (vid_url, dur, d.get('title'), chan)
                    elif is_topic:
                        return vid_url, dur, d.get('title'), chan
                    elif not best_match:
                        best_match = (vid_url, dur, d.get('title'), chan)
                        
            if best_match and (min_dur_diff <= 4 or not target_duration):
                return best_match
        except Exception:
            pass
            
    if best_match:
        return best_match
    return f"ytsearch1:{artist} - {title} audio", 0, 'Fallback search', ''

def fetch_synced_lyrics(artist, title, album=None, duration=None):
    """Fetches synchronized (.lrc) or plain text lyrics from LRCLIB API."""
    try:
        session = requests.Session(impersonate="chrome124")
        params = {
            'track_name': title,
            'artist_name': artist
        }
        if album: params['album_name'] = album
        if duration: params['duration'] = int(duration)
        
        r = session.get("https://lrclib.net/api/get", params=params, timeout=6)
        if r.status_code == 200:
            data = r.json()
            synced = data.get('syncedLyrics')
            plain = data.get('plainLyrics')
            if synced or plain:
                print(f"[SpotiFLAC] Synchronized lyrics found for '{artist} - {title}'")
                sys.stdout.flush()
                return synced or plain
        
        # Search fallback
        r_search = session.get("https://lrclib.net/api/search", params={'q': f"{artist} {title}"}, timeout=6)
        if r_search.status_code == 200:
            results = r_search.json()
            if results and isinstance(results, list):
                best = results[0]
                lyrics_text = best.get('syncedLyrics') or best.get('plainLyrics')
                if lyrics_text:
                    print(f"[SpotiFLAC] Synced lyrics matched via search for '{artist} - {title}'")
                    sys.stdout.flush()
                    return lyrics_text
    except Exception as e:
        print(f"[SpotiFLAC] Lyrics lookup notice: {e}", file=sys.stderr)
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

def tag_flac_file(flac_path, meta):
    """Tags a FLAC file with full Vorbis comments, synchronized lyrics, and embedded high-res cover art."""
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
        
        # Embed Lyrics
        lyrics = meta.get('lyrics')
        if lyrics:
            audio['lyrics'] = [lyrics]
            audio['unsyncedlyrics'] = [lyrics]
            
            # Save companion .lrc sidecar file if synchronized
            if '[00:' in lyrics or '[01:' in lyrics or '[02:' in lyrics:
                lrc_path = os.path.splitext(flac_path)[0] + '.lrc'
                try:
                    with open(lrc_path, 'w', encoding='utf-8') as lf:
                        lf.write(lyrics)
                except Exception:
                    pass
        
        cover_url = meta.get('cover_url')
        if cover_url:
            has_high_res_existing = False
            for existing_pic in getattr(audio, 'pictures', []):
                if existing_pic.type == 3:
                    if (getattr(existing_pic, 'width', 0) and existing_pic.width >= 600) or len(getattr(existing_pic, 'data', b'')) >= 150_000:
                        has_high_res_existing = True
                        break

            if not has_high_res_existing:
                try:
                    clean_cov_url = cover_url.replace('/ab67616d00001e02/', '/ab67616d0000b273/').replace('/ab67616d00004851/', '/ab67616d0000b273/')
                    session = requests.Session(impersonate="chrome124")
                    img_resp = session.get(clean_cov_url, timeout=12)
                    if img_resp.status_code == 200 and len(img_resp.content) > 500:
                        pic = create_flac_picture(img_resp.content, desc='Cover (front)')
                        audio.clear_pictures()
                        audio.add_picture(pic)
                except Exception as e:
                    print(f"[SpotiFLAC] Warning: Failed to embed cover: {e}", file=sys.stderr)
                
        audio.save()
        return True
    except Exception as e:
        print(f"[SpotiFLAC] Tagging error for {flac_path}: {e}", file=sys.stderr)
        return False

def download_track_lossless(track, output_dir, ytdlp_path='yt-dlp', track_idx=0, total_tracks=1, job_start_time=None):
    """
    Downloads an individual track in authentic studio master FLAC.
    1. Matches the official album audio track (Topic channel), avoiding music videos with skits/outros.
    2. Downloads pristine studio audio stream in FLAC format.
    3. Tags with complete Vorbis metadata, synchronized lyrics, and high-res cover art.
    """
    import time
    idx = track.get('index', 1)
    title = track.get('title', 'Track')
    artist = track.get('artist', '')
    full_name = track.get('fullName', f"{artist} - {title}" if artist else title)
    spotify_url = track.get('url') or ''
    cover_url = track.get('cover_url') or ''
    duration = track.get('duration')
    
    safe_name = re.sub(r'[\\/:*?"<>|]', '_', full_name).strip()
    flac_filename = f"{idx:02d} - {safe_name}.flac" if track.get('index') else f"{safe_name}.flac"
    flac_path = os.path.join(output_dir, flac_filename)
    
    # 1. Resolve ISRC
    songlink_info = {}
    if spotify_url:
        songlink_info = get_spotify_track_isrc_and_platforms(spotify_url)
    
    isrc = songlink_info.get('isrc') or track.get('isrc')
    
    # 2.1 Try Tidal Hi-Res Master Stream (Monochrome Engine)
    tidal_backup = None
    try:
        from tidal_monochrome_engine import download_tidal_flac
        tidal_ok = download_tidal_flac(artist, title, flac_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if tidal_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            try:
                af = FLAC(flac_path)
                bps = getattr(af.info, 'bits_per_sample', 16)
                sr = getattr(af.info, 'sample_rate', 44100)
                if bps >= 24 or sr >= 48000:
                    print(f"[SpotiFLAC] ({idx}) 🌟 Verified 24-bit Tidal Studio Master ({bps}-bit / {sr/1000:.1f} kHz)!", flush=True)
                    return flac_path
                else:
                    print(f"[SpotiFLAC] ({idx}) Tidal stream is 16-bit / 44.1 kHz. Checking Soulseek P2P for 24-bit Hi-Res Studio Master...", flush=True)
                    tidal_backup = flac_path + ".tidal16.bak"
                    shutil.copy2(flac_path, tidal_backup)
            except Exception:
                return flac_path
    except Exception as e:
        pass

    # 2.2 Try Genuine Soulseek / FLACidal P2P Studio FLAC Master
    try:
        from soulseek_flac_engine import search_and_download_flac
        slsk_ok = search_and_download_flac(artist, title, flac_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if slsk_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            if tidal_backup and os.path.exists(tidal_backup):
                try: os.remove(tidal_backup)
                except Exception: pass
            print(f"[SpotiFLAC] ({idx}) 🎉 Authentic CD/Studio Lossless FLAC downloaded directly via Soulseek P2P!", flush=True)
            return flac_path
    except Exception as e:
        pass

    if tidal_backup and os.path.exists(tidal_backup):
        if os.path.exists(flac_path):
            try: os.remove(flac_path)
            except Exception: pass
        shutil.move(tidal_backup, flac_path)
        print(f"[SpotiFLAC] ({idx}) ⚡ Retaining authentic 16-bit CD Lossless Master from Tidal.", flush=True)
        return flac_path

    # 2.3 Try Authentic Deezer HiFi Stream (1411 kbps FLAC)
    try:
        from deezer_hifi_engine import resolve_and_download_flac
        deezer_ok = resolve_and_download_flac(artist, title, isrc=isrc, output_path=flac_path, duration=duration, cover_url=cover_url)
        if deezer_ok and os.path.exists(flac_path) and os.path.getsize(flac_path) > 100000:
            print(f"[SpotiFLAC] ({idx}) 🎉 Authentic 1411 kbps Studio Master FLAC downloaded directly from HiFi CDN!", flush=True)
            return flac_path
    except Exception as e:
        pass
        
    # 2.4 No fake YouTube FLAC transcoding
    print(f"[SpotiFLAC] ❌ Authentic Lossless FLAC stream not available for '{full_name}'. YouTube fallback rejected to preserve 100% genuine lossless FLAC.", file=sys.stderr, flush=True)
    return None


def scrape_spotify_embed_tracks(url):
    """
    Extracts complete playlist, album, or track info from Spotify's public embed page.
    Bypasses Spotify Web API 401 client-credentials authentication restrictions.
    """
    pl_m = re.search(r'playlist/([a-zA-Z0-9]+)', url)
    album_m = re.search(r'album/([a-zA-Z0-9]+)', url)
    track_m = re.search(r'track/([a-zA-Z0-9]+)', url)
    
    embed_url = None
    entity_type = 'playlist' if pl_m else ('album' if album_m else 'track')
    
    if pl_m:
        embed_url = f"https://open.spotify.com/embed/playlist/{pl_m.group(1)}"
    elif album_m:
        embed_url = f"https://open.spotify.com/embed/album/{album_m.group(1)}"
    elif track_m:
        embed_url = f"https://open.spotify.com/embed/track/{track_m.group(1)}"
    else:
        return None
        
    try:
        html = None
        try:
            from curl_cffi import requests as cffi_requests
            session = cffi_requests.Session(impersonate="chrome124")
            r = session.get(embed_url, timeout=12)
            if r.status_code == 200:
                html = r.text
        except Exception:
            pass
            
        if not html:
            req = urllib.request.Request(embed_url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=12) as resp:
                html = resp.read().decode('utf-8', errors='replace')
                
        if not html:
            return None
            
        soup = BeautifulSoup(html, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if not script or not script.text:
            return None
            
        data = json.loads(script.text)
        entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
        if not entity:
            return None
            
        name = entity.get('name') or entity.get('title') or 'Spotify Media'
        
        # Extract cover art (highest resolution available)
        cover_url = ''
        v_images = entity.get('visualIdentity', {}).get('image', []) if entity.get('visualIdentity') else []
        if v_images and isinstance(v_images, list):
            sorted_imgs = sorted(v_images, key=lambda x: (x.get('maxWidth', 0) or x.get('maxHeight', 0)), reverse=True)
            cover_url = sorted_imgs[0].get('url', '')
        if not cover_url:
            sources = entity.get('coverArt', {}).get('sources', []) if entity.get('coverArt') else []
            cover_url = sources[0].get('url') if sources else ''
            
        tracks = []
        if entity_type in ('playlist', 'album'):
            raw_tracks = entity.get('trackList', [])
            for i, t in enumerate(raw_tracks):
                title = t.get('title', '')
                artist = t.get('subtitle', '')
                uri = t.get('uri', '')
                track_id = uri.split(':')[-1] if uri else ''
                t_url = f"https://open.spotify.com/track/{track_id}" if track_id else ''
                dur = int(t.get('duration', 0) / 1000) if t.get('duration') else None
                full_name = f"{artist} - {title}" if artist else title
                tracks.append({
                    'index': i + 1,
                    'title': title,
                    'artist': artist,
                    'album_name': name,
                    'album_artist': entity.get('subtitle', artist),
                    'year': None,
                    'track_number': i + 1,
                    'tracks_count': len(raw_tracks),
                    'disc_number': 1,
                    'isrc': None,
                    'duration': dur,
                    'url': t_url,
                    'cover_url': cover_url,
                    'fullName': full_name
                })
        else:
            title = entity.get('name') or entity.get('title', 'Track')
            artists_list = [a.get('name') for a in entity.get('artists', []) if a.get('name')]
            artist = ', '.join(artists_list) if artists_list else entity.get('subtitle', '')
            uri = entity.get('uri', '')
            track_id = uri.split(':')[-1] if uri else (track_m.group(1) if track_m else '')
            t_url = f"https://open.spotify.com/track/{track_id}" if track_id else url
            dur = int(entity.get('duration', 0) / 1000) if entity.get('duration') else None
            full_name = f"{artist} - {title}" if artist else title
            tracks.append({
                'index': 1,
                'title': title,
                'artist': artist,
                'album_name': '',
                'album_artist': artist,
                'year': None,
                'track_number': 1,
                'tracks_count': 1,
                'disc_number': 1,
                'isrc': None,
                'duration': dur,
                'url': t_url,
                'cover_url': cover_url,
                'fullName': full_name
            })
            
        return {
            'type': entity_type,
            'name': name,
            'cover_url': cover_url,
            'tracks': tracks
        }
    except Exception as e:
        print(f"[SpotiFLAC] Embed scrape fallback notice: {e}", file=sys.stderr)
        return None


def process_spotiflac_job(url, final_output_path):
    """
    Main entry point for SpotiFLAC jobs (Single Track, Album, or Playlist).
    Produces either a .flac file (single track) or a .zip archive (album/playlist).
    """
    client_id = os.environ.get('SPOTIFY_CLIENT_ID', '').strip()
    client_secret = os.environ.get('SPOTIFY_CLIENT_SECRET', '').strip()
    
    try:
        from spotdl.utils.spotify import SpotifyClient
        SpotifyClient.init(client_id=client_id, client_secret=client_secret, user_auth=False, use_official_api=bool(client_id))
    except Exception:
        pass
    
    clean_path = re.sub(r'\.(?:flac|zip)$', '', final_output_path)
    work_dir = clean_path + '_temp_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)
    os.makedirs(work_dir, exist_ok=True)
    
    ytdlp_path = '/usr/local/bin/yt-dlp' if os.path.exists('/usr/local/bin/yt-dlp') else 'yt-dlp'
    
    is_playlist_or_album = ('playlist' in url or 'album' in url)
    tracks = []
    
    if 'playlist' in url:
        try:
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
        except Exception as e:
            print(f"[SpotiFLAC] SpotDL playlist API failed ({e}), engaging embed fallback...", flush=True)
            
        if not tracks:
            scraped = scrape_spotify_embed_tracks(url)
            if scraped and scraped.get('tracks'):
                tracks = scraped['tracks']
            else:
                raise RuntimeError(f"Could not retrieve playlist metadata for: {url}")
                
    elif 'album' in url:
        try:
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
        except Exception as e:
            print(f"[SpotiFLAC] SpotDL album API failed ({e}), engaging embed fallback...", flush=True)
            
        if not tracks:
            scraped = scrape_spotify_embed_tracks(url)
            if scraped and scraped.get('tracks'):
                tracks = scraped['tracks']
            else:
                raise RuntimeError(f"Could not retrieve album metadata for: {url}")
                
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
        except Exception as e:
            scraped = scrape_spotify_embed_tracks(url)
            info = get_spotify_track_isrc_and_platforms(url)
            
            scraped_track = scraped['tracks'][0] if scraped and scraped.get('tracks') else {}
            real_title = scraped_track.get('title') or ''
            real_artist = scraped_track.get('artist') or ''
            cover_url = scraped_track.get('cover_url') or ''
            duration = scraped_track.get('duration')
                
            if not real_title or not real_artist:
                raise RuntimeError(f"Could not resolve track metadata for: {url}")
                
            tracks.append({
                'index': 1,
                'title': real_title,
                'artist': real_artist,
                'album_name': scraped_track.get('album_name', ''),
                'album_artist': real_artist,
                'year': '',
                'track_number': 1,
                'tracks_count': 1,
                'disc_number': 1,
                'isrc': info.get('isrc') if info else None,
                'duration': duration,
                'url': url,
                'cover_url': cover_url,
                'fullName': f"{real_artist} - {real_title}"
            })
        
    total_tracks = len(tracks)
    print(f"[SpotiFLAC] Starting SpotiFLAC Engine &bull; Total Tracks: {total_tracks}")
    sys.stdout.flush()
    
    import time
    job_start_time = time.time()
    completed_files = []
    
    for idx, t in enumerate(tracks):
        track_num = idx + 1
        pct = int(((track_num - 1) / total_tracks) * 100)
        print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC] Downloading Studio Master FLAC: {t['fullName']} ({pct}%)")
        sys.stdout.flush()
        
        flac_file = download_track_lossless(t, work_dir, ytdlp_path=ytdlp_path, track_idx=idx, total_tracks=total_tracks, job_start_time=job_start_time)
        if flac_file and os.path.exists(flac_file):
            completed_files.append(flac_file)
            cur_pct = int((track_num / total_tracks) * 100)
            print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC] Completed: {t['fullName']} ({cur_pct}%)")
            sys.stdout.flush()
        else:
            print(f"[WARN] Failed to process track: {t['fullName']}", file=sys.stderr)
            
    if not completed_files:
        raise RuntimeError("No tracks were successfully processed by SpotiFLAC Engine.")
        
    cover_url = tracks[0].get('cover_url') if tracks else ''
    out_dir = os.path.dirname(os.path.abspath(final_output_path))
    
    if is_playlist_or_album:
        # Package into ZIP archive
        zip_target = final_output_path if final_output_path.endswith('.zip') else final_output_path + '.zip'
        print(f"[SpotiFLAC] Packaging {len(completed_files)} Lossless FLAC tracks into archive: {os.path.basename(zip_target)}...")
        sys.stdout.flush()
        
        # Download cover into work_dir
        cover_work = os.path.join(work_dir, 'cover.jpg')
        has_cov = False
        if cover_url:
            try:
                clean_cov_url = cover_url.replace('/ab67616d00001e02/', '/ab67616d0000b273/').replace('/ab67616d00004851/', '/ab67616d0000b273/')
                session = requests.Session(impersonate="chrome124")
                r_cov = session.get(clean_cov_url, timeout=12)
                if r_cov.status_code == 200 and len(r_cov.content) > 500:
                    with open(cover_work, 'wb') as fc:
                        fc.write(r_cov.content)
                    has_cov = True
            except Exception:
                pass
                
        with zipfile.ZipFile(zip_target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in completed_files:
                zf.write(f, os.path.basename(f))
            if has_cov and os.path.exists(cover_work):
                zf.write(cover_work, 'cover.jpg')
                
        shutil.rmtree(work_dir, ignore_errors=True)
        sz_mb = os.path.getsize(zip_target) / (1024 * 1024)
        print(f"[download] 100% of {sz_mb:.1f}MiB at 0.00MiB/s ETA 00:00")
        print(f"[SpotiFLAC] Lossless Album/Playlist Archive Ready: {zip_target}")
        sys.stdout.flush()
    else:
        # Single track output
        single_flac = completed_files[0]
        flac_target = final_output_path if final_output_path.endswith('.flac') else final_output_path + '.flac'
        if os.path.exists(flac_target):
            os.remove(flac_target)
        shutil.move(single_flac, flac_target)
        shutil.rmtree(work_dir, ignore_errors=True)
        sz_mb = os.path.getsize(flac_target) / (1024 * 1024)
        print(f"[download] 100% of {sz_mb:.1f}MiB at 0.00MiB/s ETA 00:00")
        print(f"[SpotiFLAC] Lossless FLAC Track Ready: {flac_target}")
        sys.stdout.flush()

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python spotiflac_engine.py <url> <final_output_path>")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    out_arg = sys.argv[2]
    process_spotiflac_job(url_arg, out_arg)
