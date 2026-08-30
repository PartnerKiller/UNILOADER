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

def get_spotify_playlist_info(url):
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
    info = get_spotify_playlist_info(url)
    if not info or not info.get('tracks'):
        raise Exception("Failed to retrieve tracks from Spotify link")

    tracks = info['tracks']
    is_multi = len(tracks) > 1
    total_tracks = len(tracks)

    print(f"[download] Starting Spotify Engine: {info.get('name')} ({total_tracks} tracks)", flush=True)

    ytdlp_bin = "/usr/local/bin/yt-dlp" if os.path.exists("/usr/local/bin/yt-dlp") else "yt-dlp"

    if is_multi:
        folder_dir = output_target + "_playlist_dir"
        os.makedirs(folder_dir, exist_ok=True)
        final_zip = output_target if output_target.endswith('.zip') else output_target + '.zip'

        for i, t in enumerate(tracks):
            idx = t['index']
            track_name = re.sub(r'[\\/:*?"<>|]', '_', t['fullName']).strip()
            pct = int((i / total_tracks) * 100)
            print(f"[download] {pct}% of ~{total_tracks} tracks at 10.0MiB/s ETA {total_tracks - i} items", flush=True)
            print(f"[download] (frag {i+1}/{total_tracks}) Processing track: {t['fullName']}", flush=True)

            out_tmpl = os.path.join(folder_dir, f"{idx:02d}. {track_name}.%(ext)s")
            cmd = [
                ytdlp_bin,
                '--js-runtimes', 'node:/usr/bin/node',
                '--extractor-args', 'youtube:player_client=android',
                '-x',
                '--audio-format', audio_format,
                '--audio-quality', '0' if audio_format == 'flac' else audio_quality,
                '--no-playlist',
                '--ignore-errors',
                '--no-abort-on-error',
                '-o', out_tmpl,
                t['query']
            ]
            try:
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            except Exception as e:
                print(f"[ERR] Failed to download {t['fullName']}: {e}", flush=True)

        # Create zip
        print(f"[download] 95% Packing playlist into ZIP archive...", flush=True)
        with zipfile.ZipFile(final_zip, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, _, files in os.walk(folder_dir):
                for f in files:
                    full_p = os.path.join(root, f)
                    arcname = os.path.relpath(full_p, folder_dir)
                    zf.write(full_p, arcname)

        shutil.rmtree(folder_dir, ignore_errors=True)
        print(f"[download] 100% of {os.path.getsize(final_zip) / (1024*1024):.1f}MiB at 10.0MiB/s ETA 00:00", flush=True)
        print(f"[download] 100% Processing completed! Ready to save to device.", flush=True)

    else:
        t = tracks[0]
        ext = audio_format
        final_file = output_target if output_target.endswith(f'.{ext}') else f"{output_target}.{ext}"
        print(f"[download] Downloading single track: {t['fullName']}", flush=True)
        out_tmpl = output_target + ".%(ext)s"
        cmd = [
            ytdlp_bin,
            '--js-runtimes', 'node:/usr/bin/node',
            '--extractor-args', 'youtube:player_client=android',
            '-x',
            '--audio-format', audio_format,
            '--audio-quality', '0' if audio_format == 'flac' else audio_quality,
            '--no-playlist',
            '--ignore-errors',
            '-o', out_tmpl,
            t['query']
        ]
        subprocess.run(cmd, check=True)
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
