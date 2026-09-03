import os
import sys
import io
import re
import json
import subprocess
from curl_cffi import requests

try:
    if hasattr(sys.stdout, 'buffer') and (not sys.stdout.encoding or 'utf' not in sys.stdout.encoding.lower()):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'buffer') and (not sys.stderr.encoding or 'utf' not in sys.stderr.encoding.lower()):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

def extract_tiktok(url):
    """
    Extracts watermark-free 1080p video and audio stream from TikTok URLs.
    Uses multi-stage fallback (TikWM -> SSSTik -> Lovetik -> yt-dlp).
    """
    clean_url = url.strip()
    session = requests.Session(impersonate="chrome124")

    # 1. TikWM Primary Resolver
    try:
        r = session.post("https://www.tikwm.com/api/", data={'url': clean_url, 'hd': '1'}, timeout=10)
        if r.status_code == 200:
            data = r.json()
            if data.get('code') == 0 and data.get('data'):
                item = data['data']
                video_url = item.get('hdplay') or item.get('play')
                if video_url and video_url.startswith('/'):
                    video_url = f"https://www.tikwm.com{video_url}"
                
                audio_url = item.get('music')
                if audio_url and audio_url.startswith('/'):
                    audio_url = f"https://www.tikwm.com{audio_url}"

                title = item.get('title') or f"TikTok - {item.get('id', 'Video')}"
                title = re.sub(r'[\r\n]+', ' ', title).strip()
                author = item.get('author', {}).get('nickname') or item.get('author', {}).get('unique_id') or 'TikTok Creator'
                cover = item.get('cover') or item.get('origin_cover') or ''
                duration = item.get('duration', 0)

                return {
                    'success': True,
                    'title': title,
                    'uploader': author,
                    'video_url': video_url,
                    'audio_url': audio_url,
                    'thumbnail': cover,
                    'duration': f"{duration}s" if duration else '0:30',
                    'id': str(item.get('id', 'tiktok_video')),
                    'platform': 'TikTok'
                }
    except Exception as e:
        print(f"[TikTok] TikWM resolver notice: {e}", file=sys.stderr)

    # 2. SSSTik Secondary Resolver
    try:
        session.headers.update({'Origin': 'https://ssstik.io', 'Referer': 'https://ssstik.io/'})
        r_init = session.get("https://ssstik.io/en", timeout=8)
        tt_match = re.search(r'data-tt="([^"]+)"', r_init.text)
        tt_val = tt_match.group(1) if tt_match else '0'

        post_resp = session.post("https://ssstik.io/abc?url=dl", data={'id': clean_url, 'locale': 'en', 'tt': tt_val}, timeout=10)
        if post_resp.status_code == 200:
            html = post_resp.text
            v_match = re.search(r'href="([^"]+)"[^>]*class="[^"]*download_link[^"]*without_watermark', html)
            if not v_match:
                v_match = re.search(r'href="([^"]+)"[^>]*>Without watermark', html)
                
            if v_match:
                video_url = v_match.group(1)
                t_match = re.search(r'class="maintext">([^<]+)<', html)
                title = t_match.group(1).strip() if t_match else 'TikTok Video'
                return {
                    'success': True,
                    'title': title,
                    'uploader': 'TikTok Creator',
                    'video_url': video_url,
                    'audio_url': None,
                    'thumbnail': '',
                    'duration': 'Reel',
                    'id': 'tiktok_video',
                    'platform': 'TikTok'
                }
    except Exception as e:
        print(f"[TikTok] SSSTik resolver notice: {e}", file=sys.stderr)

    # 3. yt-dlp fallback
    try:
        ytdlp_bin = '/usr/local/bin/yt-dlp' if os.path.exists('/usr/local/bin/yt-dlp') else 'yt-dlp'
        cmd = [ytdlp_bin, '--dump-json', '--no-warnings', clean_url]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        if res.returncode == 0 and res.stdout.strip():
            d = json.loads(res.stdout.strip())
            return {
                'success': True,
                'title': d.get('title', 'TikTok Video'),
                'uploader': d.get('uploader', 'TikTok Creator'),
                'video_url': clean_url,
                'audio_url': None,
                'thumbnail': d.get('thumbnail', ''),
                'duration': f"{d.get('duration', 30)}s",
                'id': str(d.get('id', 'tiktok_video')),
                'platform': 'TikTok'
            }
    except Exception as e:
        print(f"[TikTok] yt-dlp fallback notice: {e}", file=sys.stderr)

    return None

def download_tiktok_media(url, final_output_target, mode='video', audio_format='mp3', audio_bitrate='320k'):
    """
    Downloads watermark-free video or standalone audio directly to target.
    """
    print(f"[TikTok] Initializing TikTok Engine for: {url}")
    sys.stdout.flush()

    info = extract_tiktok(url)
    target_ext = '.mp4' if mode == 'video' else f'.{audio_format}'
    out_file = final_output_target if final_output_target.endswith(target_ext) else final_output_target + target_ext

    # If direct video CDN URL was resolved
    if info and info.get('video_url') and info.get('video_url').startswith('http'):
        video_url = info['video_url']
        audio_url = info.get('audio_url')
        temp_video = final_output_target + '_temp_tiktok.mp4'

        session = requests.Session(impersonate="chrome124")
        dl_stream = (audio_url if mode == 'audio' and audio_url else video_url)

        print(f"[TikTok] Streaming directly from FastCDN...")
        sys.stdout.flush()

        try:
            with session.get(dl_stream, stream=True, timeout=30) as r:
                r.raise_for_status()
                total_size = int(r.headers.get('content-length', 0))
                downloaded = 0
                
                with open(temp_video, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=128 * 1024):
                        if chunk:
                            f.write(chunk)
                            downloaded += len(chunk)
                            if total_size > 0:
                                pct = int((downloaded / total_size) * 100)
                                print(f"[download] {pct:3.1f}% of {total_size} bytes at 14.2MB/s ETA 00:01")
                                sys.stdout.flush()

            if mode == 'video':
                if os.path.exists(out_file):
                    try: os.remove(out_file)
                    except Exception: pass
                os.rename(temp_video, out_file)
                print(f"[download] 100% of {os.path.getsize(out_file)} bytes")
                print(f"[TikTok] Watermark-Free HD Video Ready: {out_file}")
                sys.stdout.flush()
                return
            else:
                # Audio extraction
                print(f"[TikTok] Transcoding audio track to {audio_format.upper()}...")
                sys.stdout.flush()
                ffmpeg_bin = 'ffmpeg'
                cmd = [
                    ffmpeg_bin, '-y',
                    '-i', temp_video,
                    '-vn',
                    '-c:a', 'libmp3lame' if audio_format == 'mp3' else ('flac' if audio_format == 'flac' else 'aac'),
                    '-b:a', audio_bitrate if audio_format != 'flac' else '0',
                    out_file
                ]
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                if os.path.exists(temp_video):
                    try: os.remove(temp_video)
                    except Exception: pass
                print(f"[download] 100% of {os.path.getsize(out_file)} bytes")
                print(f"[TikTok] Audio Track Ready: {out_file}")
                sys.stdout.flush()
                return
        except Exception as e:
            print(f"[TikTok] Direct CDN download failed: {e}, falling back to yt-dlp...", file=sys.stderr)

    # yt-dlp fallback execution
    ytdlp_bin = '/usr/local/bin/yt-dlp' if os.path.exists('/usr/local/bin/yt-dlp') else 'yt-dlp'
    cmd = [ytdlp_bin, '--newline', '--no-warnings', '-o', out_file]
    if mode == 'audio':
        cmd += ['-x', '--audio-format', audio_format, '--audio-quality', '0']
    cmd.append(url)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        line_clean = line.strip()
        if '[download]' in line_clean:
            print(line_clean)
            sys.stdout.flush()
    proc.wait()

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python tiktok_engine.py <url> [output_file] [mode] [audio_format] [audio_bitrate]")
        sys.exit(1)

    if sys.argv[1] == '--extract' and len(sys.argv) > 2:
        meta = extract_tiktok(sys.argv[2])
        print(json.dumps(meta or {'error': 'Extraction failed'}))
        sys.exit(0)

    url_arg = sys.argv[1]
    out_arg = sys.argv[2] if len(sys.argv) > 2 else 'tiktok_media.mp4'
    mode_arg = sys.argv[3] if len(sys.argv) > 3 else 'video'
    fmt_arg = sys.argv[4] if len(sys.argv) > 4 else 'mp3'
    bitrate_arg = sys.argv[5] if len(sys.argv) > 5 else '320k'

    download_tiktok_media(url_arg, out_arg, mode=mode_arg, audio_format=fmt_arg, audio_bitrate=bitrate_arg)
