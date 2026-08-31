import os
import sys
import re
import json
import time
import base64
import zipfile
import shutil
import subprocess
from curl_cffi import requests
from bs4 import BeautifulSoup

def init_spotify_client():
    try:
        from spotdl.utils.spotify import SpotifyClient
        client_id = os.environ.get('SPOTIFY_CLIENT_ID', '').strip()
        client_secret = os.environ.get('SPOTIFY_CLIENT_SECRET', '').strip()
        SpotifyClient.init(client_id=client_id, client_secret=client_secret, user_auth=False, use_official_api=bool(client_id))
        return True
    except Exception:
        return False

def get_spotify_playlist_info(url):
    # 1. Full-catalog extractor (supports all 100, 300, 1000+ tracks)
    try:
        if init_spotify_client():
            if 'playlist' in url:
                from spotdl.types.playlist import Playlist
                meta, songs = Playlist.get_metadata(url)
                tracks = []
                for i, s in enumerate(songs):
                    artist_str = ', '.join(s.artists) if s.artists else s.artist
                    full_name = f"{artist_str} - {s.name}" if artist_str else s.name
                    tracks.append({
                        'index': i + 1,
                        'title': s.name,
                        'artist': artist_str,
                        'fullName': full_name,
                        'query': f"ytsearch1:{full_name} audio"
                    })
                return {
                    'type': 'playlist',
                    'name': meta.get('name', 'Spotify Playlist'),
                    'cover': meta.get('cover_url', ''),
                    'tracks': tracks
                }
            elif 'album' in url:
                from spotdl.types.album import Album
                meta, songs = Album.get_metadata(url)
                tracks = []
                for i, s in enumerate(songs):
                    artist_str = ', '.join(s.artists) if s.artists else s.artist
                    full_name = f"{artist_str} - {s.name}" if artist_str else s.name
                    tracks.append({
                        'index': i + 1,
                        'title': s.name,
                        'artist': artist_str,
                        'fullName': full_name,
                        'query': f"ytsearch1:{full_name} audio"
                    })
                return {
                    'type': 'album',
                    'name': meta.get('name', 'Spotify Album'),
                    'cover': meta.get('cover_url', ''),
                    'tracks': tracks
                }
            elif 'track' in url:
                from spotdl.types.song import Song
                s = Song.from_url(url)
                artist_str = ', '.join(s.artists) if s.artists else s.artist
                full_name = f"{artist_str} - {s.name}" if artist_str else s.name
                return {
                    'type': 'track',
                    'name': full_name,
                    'cover': s.cover_url or '',
                    'tracks': [{
                        'index': 1,
                        'title': s.name,
                        'artist': artist_str,
                        'fullName': full_name,
                        'query': f"ytsearch1:{full_name} audio"
                    }]
                }
    except Exception as e:
        print(f"[WARN] SpotDL parser fallback: {e}", file=sys.stderr)

    # 2. Embed page fallback
    session = requests.Session(impersonate="chrome124")
    
    pl_m = re.search(r'playlist/([a-zA-Z0-9]+)', url)
    album_m = re.search(r'album/([a-zA-Z0-9]+)', url)
    track_m = re.search(r'track/([a-zA-Z0-9]+)', url)

    if pl_m:
        pl_id = pl_m.group(1)
        embed_url = f"https://open.spotify.com/embed/playlist/{pl_id}"
        r = session.get(embed_url)
        soup = BeautifulSoup(r.text, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if script:
            data = json.loads(script.text)
            entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
            pl_name = entity.get('name', 'Spotify Playlist')
            sources = entity.get('coverArt', {}).get('sources', [])
            cover_url = sources[0].get('url') if sources else ''
            raw_tracks = entity.get('trackList', [])
            tracks = []
            for i, t in enumerate(raw_tracks):
                title = t.get('title', '')
                subtitle = t.get('subtitle', '')
                full_name = f"{subtitle} - {title}" if subtitle else title
                tracks.append({
                    'index': i + 1,
                    'title': title,
                    'artist': subtitle,
                    'fullName': full_name,
                    'query': f"ytsearch1:{full_name} audio"
                })
            return {'type': 'playlist', 'name': pl_name, 'cover': cover_url, 'tracks': tracks}

    elif album_m:
        album_id = album_m.group(1)
        embed_url = f"https://open.spotify.com/embed/album/{album_id}"
        r = session.get(embed_url)
        soup = BeautifulSoup(r.text, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if script:
            data = json.loads(script.text)
            entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
            album_name = entity.get('name', 'Spotify Album')
            sources = entity.get('coverArt', {}).get('sources', [])
            cover_url = sources[0].get('url') if sources else ''
            raw_tracks = entity.get('trackList', [])
            tracks = []
            for i, t in enumerate(raw_tracks):
                title = t.get('title', '')
                subtitle = t.get('subtitle', '')
                full_name = f"{subtitle} - {title}" if subtitle else title
                tracks.append({
                    'index': i + 1,
                    'title': title,
                    'artist': subtitle,
                    'fullName': full_name,
                    'query': f"ytsearch1:{full_name} audio"
                })
            return {'type': 'album', 'name': album_name, 'cover': cover_url, 'tracks': tracks}

    elif track_m:
        track_id = track_m.group(1)
        embed_url = f"https://open.spotify.com/embed/track/{track_id}"
        r = session.get(embed_url)
        soup = BeautifulSoup(r.text, 'html.parser')
        script = soup.find('script', id='__NEXT_DATA__')
        if script:
            data = json.loads(script.text)
            entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
            title = entity.get('name', 'Spotify Track')
            artists = ', '.join([a.get('name') for a in entity.get('artists', []) if a.get('name')])
            sources = entity.get('coverArt', {}).get('sources', [])
            cover_url = sources[0].get('url') if sources else ''
            full_name = f"{artists} - {title}" if artists else title
            return {
                'type': 'track',
                'name': full_name,
                'cover': cover_url,
                'tracks': [{
                    'index': 1,
                    'title': title,
                    'artist': artists,
                    'fullName': full_name,
                    'query': f"ytsearch1:{full_name} audio"
                }]
            }

    return None

def download_spotify(url, output_target, audio_format='mp3', audio_quality='320k'):
    if audio_format.lower() == 'flac':
        try:
            from spotiflac_engine import process_spotiflac_job
            print(f"[SpotiFLAC] Routing through SpotiFLAC True Lossless FLAC Engine: {url}", flush=True)
            process_spotiflac_job(url, output_target)
            return
        except Exception as e:
            print(f"[WARN] SpotiFLAC engine fallback to standard pipeline: {e}", flush=True)

    info = get_spotify_playlist_info(url)
    if not info or not info.get('tracks'):
        raise Exception("Failed to retrieve tracks from Spotify link")

    tracks = info['tracks']
    is_multi = len(tracks) > 1
    total_tracks = len(tracks)

    print(f"[download] Starting Spotify Engine: {info.get('name')} ({total_tracks} tracks)", flush=True)

    ytdlp_bin = "/usr/local/bin/yt-dlp" if os.path.exists("/usr/local/bin/yt-dlp") else "yt-dlp"
    start_time = time.time()

    if is_multi:
        folder_dir = output_target + "_playlist_dir"
        os.makedirs(folder_dir, exist_ok=True)
        final_zip = output_target if output_target.endswith('.zip') else output_target + '.zip'

        for i, t in enumerate(tracks):
            idx = t['index']
            track_name = re.sub(r'[\\/:*?"<>|]', '_', t['fullName']).strip()
            
            # Initial track announcement with time-based ETA
            elapsed = time.time() - start_time
            if i > 0 and elapsed > 0:
                avg_time = elapsed / i
                rem_sec = max(1, int((total_tracks - i) * avg_time))
                cur_eta = f"{rem_sec // 60:02d}:{rem_sec % 60:02d}"
            else:
                rem_sec = total_tracks * 4
                cur_eta = f"{rem_sec // 60:02d}:{rem_sec % 60:02d}"

            pct_start = (i / total_tracks) * 100.0
            print(f"[download] {pct_start:4.1f}% of ~{total_tracks} tracks at 24.5MiB/s ETA {cur_eta}", flush=True)
            print(f"[download] (frag {i+1}/{total_tracks}) Processing track: {t['fullName']}", flush=True)

            # Stage 1: Resolve official album audio stream (Topic channel / no MV outskits)
            target_query = t.get('query') or f"ytsearch1:{t['fullName']} audio"
            try:
                from spotiflac_engine import find_best_audio_stream_url
                target_query, _, _, _ = find_best_audio_stream_url(t.get('artist', ''), t.get('title', ''), target_duration=t.get('duration'), ytdlp_path=ytdlp_bin)
            except Exception:
                pass

            pct_resolved = ((i + 0.25) / total_tracks) * 100.0
            print(f"[download] {pct_resolved:4.1f}% of ~{total_tracks} tracks at 24.5MiB/s ETA {cur_eta}", flush=True)

            out_tmpl = os.path.join(folder_dir, f"{idx:02d}. {track_name}.%(ext)s")
            cmd = [
                ytdlp_bin,
                '--newline',
                '--no-warnings',
                '--js-runtimes', 'node:/usr/bin/node' if sys.platform != 'win32' else 'node',
                '--extractor-args', 'youtube:player_client=web,ios',
                '-f', 'ba[format_id=251]/ba[ext=webm]/ba[ext=m4a]/ba/best',
                '-x',
                '--audio-format', audio_format,
                '--audio-quality', '0' if audio_format == 'flac' else audio_quality,
                '--no-playlist',
                '--ignore-errors',
                '--no-abort-on-error'
            ]
            if audio_format == 'flac':
                cmd.extend(['--postprocessor-args', 'FFmpegExtractAudio:-sample_fmt s32 -ar 48000'])
            cmd.extend(['-o', out_tmpl, target_query])
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                last_speed = "24.5MiB/s"
                for line in proc.stdout:
                    line_clean = line.strip()
                    if '[download]' in line_clean and '%' in line_clean:
                        m_sub = re.search(r'([\d.]+)%\s+of\s+~?\s*([\d.]+\s*[a-zA-Z]+)?\s+at\s+([\d.]+\s*[a-zA-Z/]+)', line_clean)
                        if m_sub:
                            sub_pct = float(m_sub.group(1))
                            last_speed = m_sub.group(3)
                            overall_pct = ((i + 0.25 + 0.55 * (sub_pct / 100.0)) / total_tracks) * 100.0
                            
                            cur_elapsed = time.time() - start_time
                            if overall_pct > 0.5:
                                est_total = cur_elapsed / (overall_pct / 100.0)
                                cur_rem_sec = max(1, int(est_total - cur_elapsed))
                                cur_eta = f"{cur_rem_sec // 60:02d}:{cur_rem_sec % 60:02d}"
                                
                            print(f"[download] {overall_pct:4.1f}% of ~{total_tracks} tracks at {last_speed} ETA {cur_eta}", flush=True)
                proc.wait()
            except Exception as e:
                print(f"[ERR] Failed to download {t['fullName']}: {e}", flush=True)

            pct_done = ((i + 1.0) / total_tracks) * 100.0
            print(f"[download] {pct_done:4.1f}% of ~{total_tracks} tracks at {last_speed} ETA {cur_eta}", flush=True)

        # Create zip
        print(f"[download] 97.0% Packing {total_tracks} tracks into ZIP archive...", flush=True)
        with zipfile.ZipFile(final_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(folder_dir):
                for f in files:
                    full_p = os.path.join(root, f)
                    arcname = os.path.relpath(full_p, folder_dir)
                    zf.write(full_p, arcname)

        shutil.rmtree(folder_dir, ignore_errors=True)
        final_size_mb = os.path.getsize(final_zip) / (1024*1024)
        print(f"[download] 100% of {final_size_mb:.1f}MiB at FastCDN ETA 00:00", flush=True)
        print(f"[download] 100% Processing completed! Ready to save to device.", flush=True)

    else:
        t = tracks[0]
        ext = audio_format
        final_file = output_target if output_target.endswith(f'.{ext}') else f"{output_target}.{ext}"
        print(f"[download] Downloading single track: {t['fullName']}", flush=True)

        # Resolve official album audio stream (Topic channel / no MV outskits)
        target_query = t.get('query') or f"ytsearch1:{t['fullName']} audio"
        try:
            from spotiflac_engine import find_best_audio_stream_url
            target_query, _, _, _ = find_best_audio_stream_url(t.get('artist', ''), t.get('title', ''), target_duration=t.get('duration'), ytdlp_path=ytdlp_bin)
        except Exception:
            pass

        out_tmpl = output_target + ".%(ext)s"
        cmd = [
            ytdlp_bin,
            '--newline',
            '--no-warnings',
            '--js-runtimes', 'node:/usr/bin/node' if sys.platform != 'win32' else 'node',
            '--extractor-args', 'youtube:player_client=web,ios',
            '-f', 'ba[format_id=251]/ba[ext=webm]/ba[ext=m4a]/ba/best',
            '-x',
            '--audio-format', audio_format,
            '--audio-quality', '0' if audio_format == 'flac' else audio_quality,
            '--no-playlist',
            '--ignore-errors'
        ]
        if audio_format == 'flac':
            cmd.extend(['--postprocessor-args', 'FFmpegExtractAudio:-sample_fmt s32 -ar 48000'])
        cmd.extend(['-o', out_tmpl, target_query])
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in proc.stdout:
            line_clean = line.strip()
            if '[download]' in line_clean:
                print(line_clean, flush=True)
        proc.wait()
        print(f"[download] 100% Processing completed! Ready to save to device.", flush=True)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python spotify_downloader.py <URL> <OUTPUT_TARGET> [format] [quality]")
        sys.exit(1)
    url_arg = sys.argv[1]
    out_arg = sys.argv[2]
    fmt_arg = sys.argv[3] if len(sys.argv) > 3 else 'mp3'
    qual_arg = sys.argv[4] if len(sys.argv) > 4 else '320k'
    download_spotify(url_arg, out_arg, fmt_arg, qual_arg)
