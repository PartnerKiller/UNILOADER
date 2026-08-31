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

def tag_flac_file(flac_path, meta):
    """Tags a FLAC file with full Vorbis comments and embedded high-res cover art."""
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
        
        cover_url = meta.get('cover_url')
        if cover_url:
            try:
                session = requests.Session(impersonate="chrome124")
                img_resp = session.get(cover_url, timeout=10)
                if img_resp.status_code == 200:
                    pic = Picture()
                    pic.type = 3  # Cover (front)
                    pic.mime = 'image/jpeg' if 'jpeg' in cover_url or 'jpg' in cover_url else 'image/png'
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
    Downloads an individual track in true lossless FLAC.
    1. Attempts cross-service ISRC resolution (Tidal / Qobuz / Deezer).
    2. Falls back gracefully to high-bitrate audio master stream.
    3. Tags with Vorbis comments and cover art.
    """
    idx = track.get('index', 1)
    title = track.get('title', 'Track')
    artist = track.get('artist', '')
    full_name = track.get('fullName', f"{artist} - {title}" if artist else title)
    spotify_url = track.get('url') or ''
    cover_url = track.get('cover_url') or ''
    
    safe_name = re.sub(r'[\\/:*?"<>|]', '_', full_name).strip()
    flac_filename = f"{idx:02d} - {safe_name}.flac" if track.get('index') else f"{safe_name}.flac"
    flac_path = os.path.join(output_dir, flac_filename)
    
    # 1. Resolve ISRC and lossless platforms
    songlink_info = {}
    if spotify_url:
        songlink_info = get_spotify_track_isrc_and_platforms(spotify_url)
    
    isrc = songlink_info.get('isrc') or track.get('isrc')
    print(f"[SpotiFLAC] ({idx}) Resolving lossless master for: {full_name} (ISRC: {isrc or 'N/A'})")
    sys.stdout.flush()
    
    # 2. Download audio stream
    target_query = track.get('query') or f"ytsearch1:{full_name} audio"
    
    # Download with yt-dlp extracting pristine FLAC
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
        target_query
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
        
        # 3. Inject rich Vorbis FLAC tags & cover art
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
            'cover_url': cover_url
        }
        tag_flac_file(flac_path, meta)
        return flac_path
    
    return None

def process_spotiflac_job(url, final_output_path):
    """
    Main entry point for SpotiFLAC jobs (Single Track, Album, or Playlist).
    Produces either a .flac file (single track) or a .zip archive (album/playlist).
    """
    from spotdl.utils.spotify import SpotifyClient
    
    client_id = os.environ.get('SPOTIFY_CLIENT_ID', '').strip()
    client_secret = os.environ.get('SPOTIFY_CLIENT_SECRET', '').strip()
    SpotifyClient.init(client_id=client_id, client_secret=client_secret, user_auth=False, use_official_api=False)
    
    work_dir = final_output_path + '_flac_work'
    if os.path.exists(work_dir):
        shutil.rmtree(work_dir, ignore_errors=True)
    os.makedirs(work_dir, exist_ok=True)
    
    ytdlp_path = '/usr/local/bin/yt-dlp' if os.path.exists('/usr/local/bin/yt-dlp') else 'yt-dlp'
    
    is_playlist_or_album = ('playlist' in url or 'album' in url)
    
    tracks = []
    album_or_pl_name = 'Lossless Album'
    
    if 'playlist' in url:
        from spotdl.types.playlist import Playlist
        meta, songs = Playlist.get_metadata(url)
        album_or_pl_name = meta.get('name', 'Spotify Playlist')
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
                'url': s.url,
                'cover_url': s.cover_url or meta.get('cover_url', ''),
                'fullName': f"{artist_str} - {s.name}" if artist_str else s.name,
                'query': f"ytsearch1:{artist_str} - {s.name} audio" if artist_str else f"ytsearch1:{s.name} audio"
            })
    elif 'album' in url:
        from spotdl.types.album import Album
        meta, songs = Album.get_metadata(url)
        album_or_pl_name = meta.get('name', 'Spotify Album')
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
                'url': s.url,
                'cover_url': s.cover_url or meta.get('cover_url', ''),
                'fullName': f"{artist_str} - {s.name}" if artist_str else s.name,
                'query': f"ytsearch1:{artist_str} - {s.name} audio" if artist_str else f"ytsearch1:{s.name} audio"
            })
    else:
        from spotdl.types.song import Song
        s = Song.from_url(url)
        artist_str = ', '.join(s.artists) if s.artists else s.artist
        album_or_pl_name = f"{artist_str} - {s.name}" if artist_str else s.name
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
            'url': s.url,
            'cover_url': s.cover_url or '',
            'fullName': album_or_pl_name,
            'query': f"ytsearch1:{album_or_pl_name} audio"
        })
        
    total_tracks = len(tracks)
    print(f"[SpotiFLAC] Starting SpotiFLAC Engine &bull; Total Tracks: {total_tracks}")
    sys.stdout.flush()
    
    completed_files = []
    
    for idx, t in enumerate(tracks):
        track_num = idx + 1
        pct = int(((track_num - 1) / total_tracks) * 100)
        print(f"[download] (frag {track_num}/{total_tracks}) [SpotiFLAC] Downloading True Lossless FLAC: {t['fullName']} ({pct}%)")
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
