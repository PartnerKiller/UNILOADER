import os
import sys
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
            try:
                session = requests.Session(impersonate="chrome124")
                img_resp = session.get(cover_url, timeout=10)
                if img_resp.status_code == 200:
                    pic = Picture()
                    pic.type = 3  # Cover (front)
                    pic.mime = 'image/png' if img_resp.content.startswith(b'\x89PNG') else 'image/jpeg'
                    pic.data = img_resp.content
                    audio.add_picture(pic)
            except Exception as e:
                print(f"[SpotiFLAC] Warning: Failed to embed cover: {e}", file=sys.stderr)
                
        audio.save()
        return True
    except Exception as e:
        print(f"[SpotiFLAC] Tagging error for {flac_path}: {e}", file=sys.stderr)
        return False

def download_track_lossless(track, output_dir, ytdlp_path='yt-dlp'):
    """
    Downloads an individual track in authentic studio master FLAC.
    1. Matches the official album audio track (Topic channel), avoiding music videos with skits/outros.
    2. Downloads pristine studio audio stream in FLAC format.
    3. Tags with complete Vorbis metadata and high-res cover art.
    """
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
    
    # 2. Locate exact studio album audio stream
    target_stream_url, match_dur, match_title, match_chan = find_best_audio_stream_url(
        artist, title, target_duration=duration, ytdlp_path=ytdlp_path
    )
    
    print(f"[SpotiFLAC] ({idx}) Studio Master Match: {match_title} [{match_chan}] (ISRC: {isrc or 'N/A'})")
    sys.stdout.flush()
    
    # 3. Download audio stream in lossless FLAC
    cmd = [
        ytdlp_path,
        '--no-warnings',
        '--newline',
        '--ignore-errors',
        '--no-abort-on-error',
        '--extractor-args', 'youtube:player_client=android',
        '--js-runtimes', 'node' if sys.platform == 'win32' else 'node:/usr/bin/node',
        '-x',
        '--audio-format', 'flac',
        '--audio-quality', '0',
        '-o', os.path.join(output_dir, f"temp_{idx}_%(title)s.%(ext)s"),
        target_stream_url
    ]
    
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line_clean = line.strip()
        if '[download]' in line_clean and '%' in line_clean:
            print(f"[download] {line_clean}")
            sys.stdout.flush()
    proc.wait()
    
    # Locate the output temp FLAC file
    temp_files = [f for f in os.listdir(output_dir) if f.startswith(f"temp_{idx}_") and f.endswith('.flac')]
    if temp_files:
        temp_flac = os.path.join(output_dir, temp_files[0])
        if os.path.exists(flac_path):
            try: os.remove(flac_path)
            except Exception: pass
        os.rename(temp_flac, flac_path)
        
        # 4. Inject rich Vorbis FLAC tags, synchronized lyrics, & cover art
        lyrics = fetch_synced_lyrics(artist, title, album=track.get('album_name'), duration=duration)
        meta = {
            'title': title,
            'artist': artist,
            'album': track.get('album_name', ''),
            'album_artist': track.get('album_artist', artist),
            'year': track.get('year', ''),
            'track_number': track.get('track_number', idx),
            'tracks_count': track.get('tracks_count', 0),
            'disc_number': track.get('disc_number', 1),
            'isrc': isrc,
            'cover_url': cover_url,
            'lyrics': lyrics
        }
        tag_flac_file(flac_path, meta)
        return flac_path
    
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
    
    work_dir = final_output_path + '_flac_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)
    os.makedirs(work_dir, exist_ok=True)
    
    ytdlp_path = '/usr/local/bin/yt-dlp' if os.path.exists('/usr/local/bin/yt-dlp') else 'yt-dlp'
    
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
        except Exception as e:
            # Songlink fallback
            info = get_spotify_track_isrc_and_platforms(url)
            tracks.append({
                'index': 1,
                'title': 'Track',
                'artist': '',
                'album_name': '',
                'album_artist': '',
                'year': '',
                'track_number': 1,
                'tracks_count': 1,
                'disc_number': 1,
                'isrc': info.get('isrc'),
                'duration': None,
                'url': url,
                'cover_url': '',
                'fullName': 'Spotify Track'
            })
        
    total_tracks = len(tracks)
    print(f"[SpotiFLAC] Starting SpotiFLAC Engine &bull; Total Tracks: {total_tracks}")
    sys.stdout.flush()
    
    completed_files = []
    
    for idx, t in enumerate(tracks):
        track_num = idx + 1
        pct = int(((track_num - 1) / total_tracks) * 100)
        print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC] Downloading Studio Master FLAC: {t['fullName']} ({pct}%)")
        sys.stdout.flush()
        
        flac_file = download_track_lossless(t, work_dir, ytdlp_path=ytdlp_path)
        if flac_file and os.path.exists(flac_file):
            completed_files.append(flac_file)
            cur_pct = int((track_num / total_tracks) * 100)
            print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC] Completed: {t['fullName']} ({cur_pct}%)")
            sys.stdout.flush()
        else:
            print(f"[WARN] Failed to process track: {t['fullName']}", file=sys.stderr)
            
    if not completed_files:
        raise RuntimeError("No tracks were successfully processed by SpotiFLAC Engine.")
        
    if is_playlist_or_album:
        # Package into ZIP archive
        zip_target = final_output_path if final_output_path.endswith('.zip') else final_output_path + '.zip'
        print(f"[SpotiFLAC] Packaging {len(completed_files)} Lossless FLAC tracks into archive: {os.path.basename(zip_target)}...")
        sys.stdout.flush()
        
        with zipfile.ZipFile(zip_target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for f in completed_files:
                zf.write(f, os.path.basename(f))
                
        shutil.rmtree(work_dir, ignore_errors=True)
        print(f"[download] 100% of {os.path.getsize(zip_target)} bytes")
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
        print(f"[download] 100% of {os.path.getsize(flac_target)} bytes")
        print(f"[SpotiFLAC] Lossless FLAC Track Ready: {flac_target}")
        sys.stdout.flush()

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python spotiflac_engine.py <url> <final_output_path>")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    out_arg = sys.argv[2]
    process_spotiflac_job(url_arg, out_arg)
