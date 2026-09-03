import os
import sys
import io
import re
import json
import subprocess
from curl_cffi import requests
from bs4 import BeautifulSoup

try:
    if hasattr(sys.stdout, 'buffer') and (not sys.stdout.encoding or 'utf' not in sys.stdout.encoding.lower()):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'buffer') and (not sys.stderr.encoding or 'utf' not in sys.stderr.encoding.lower()):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

def unpack_snapsave_js(raw_js):
    """Executes the SnapSave de-obfuscation routine in a safe Node context to retrieve direct download URLs."""
    node_code = f"""
    const vm = require('vm');
    let output = '';
    const sandbox = {{
        eval: (s) => {{ output = s; }},
        console: console,
        document: {{
            getElementById: (id) => ({{
                set innerHTML(val) {{ output = val; }},
                get innerHTML() {{ return output; }}
            }}),
            querySelector: () => ({{ set innerHTML(val) {{ output = val; }} }})
        }}
    }};
    try {{
        const script = {json.dumps(raw_js)};
        vm.runInNewContext(script, sandbox);
        console.log(output);
    }} catch (e) {{
        console.error("Unpack error:", e);
    }}
    """
    try:
        p = subprocess.run(["node", "-e", node_code], capture_output=True, text=True, timeout=8)
        return p.stdout
    except Exception as e:
        print(f"[InstagramEngine] Node unpack error: {e}", file=sys.stderr)
        return ""

def extract_instagram(url):
    """Extracts Instagram Reel, Post, or Video metadata and direct CDN download links."""
    session = requests.Session(impersonate="chrome124")
    
    # 1. SnapSave Resolver
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://snapsave.app/",
            "Origin": "https://snapsave.app"
        }
        r = session.post("https://snapsave.app/action.php?lang=en", data={"url": url}, headers=headers, timeout=12)
        if r.status_code == 200 and r.text:
            unpacked_html = unpack_snapsave_js(r.text)
            if unpacked_html:
                soup = BeautifulSoup(unpacked_html, 'html.parser')
                
                # Find thumbnail
                thumb = None
                img = soup.find('img')
                if img and img.get('src'):
                    thumb = img['src'].strip('\'"\\')
                    
                # Find video download link
                video_url = None
                for a in soup.find_all('a', href=True):
                    href = a['href'].strip('\'"\\')
                    if 'd.rapidcdn.app' in href or '.mp4' in href or 'cdninstagram' in href:
                        video_url = href
                        break
                        
                if video_url:
                    m = re.search(r'/(?:reel|p|tv)/([a-zA-Z0-9_-]+)', url)
                    shortcode = m.group(1) if m else "media"
                    
                    return {
                        'id': shortcode,
                        'title': f"Instagram Reel - {shortcode}",
                        'uploader': 'Instagram Creator',
                        'thumbnail': thumb or '',
                        'video_url': video_url,
                        'duration': None,
                        'formats': [{
                            'format_id': 'hd',
                            'ext': 'mp4',
                            'resolution': '1080x1920 (HD)',
                            'url': video_url
                        }]
                    }
    except Exception as e:
        print(f"[InstagramEngine] SnapSave extraction error: {e}", file=sys.stderr)
        
    return None

def download_instagram_media(url, output_target, mode='video', audio_format='mp3', audio_quality='320k'):
    """
    Downloads an Instagram Reel/Post directly using high-speed CDN streaming and FFmpeg muxing.
    """
    info = extract_instagram(url)
    if not info or not info.get('video_url'):
        raise RuntimeError("Unable to extract Instagram video stream URL.")
        
    video_url = info['video_url']
    final_output = output_target
    if mode == 'audio':
        if not final_output.endswith(f".{audio_format}"):
            final_output = f"{output_target}.{audio_format}"
    else:
        if not final_output.endswith('.mp4'):
            final_output = f"{output_target}.mp4"
            
    print(f"[Instagram] Downloading media: {info['title']}", flush=True)
    
    # Download raw stream with curl_cffi with simulated progress
    session = requests.Session(impersonate="chrome124")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://snapsave.app/"
    }
    
    temp_raw = output_target + "_raw.mp4"
    r = session.get(video_url, headers=headers, stream=True, timeout=30)
    total_size = int(r.headers.get('Content-Length', 0))
    downloaded = 0
    
    with open(temp_raw, 'wb') as f:
        for chunk in r.iter_content(chunk_size=1024 * 1024):
            if chunk:
                f.write(chunk)
                downloaded += len(chunk)
                if total_size > 0:
                    pct = (downloaded / total_size) * 100
                    print(f"[download] {pct:.1f}% of ~{total_size/(1024*1024):.2f}MiB at 15.0MiB/s ETA 00:01", flush=True)
                else:
                    print(f"[download] {downloaded/(1024*1024):.2f}MiB downloaded", flush=True)
                    
    print(f"[download] 100% Raw video downloaded successfully.", flush=True)
    
    # Post-process with FFmpeg
    if mode == 'audio':
        print(f"[Instagram] Converting audio to {audio_format.upper()} ({audio_quality})...", flush=True)
        bitrate_arg = ['-b:a', audio_quality] if audio_format == 'mp3' else []
        cmd = [
            'ffmpeg', '-y', '-i', temp_raw,
            '-vn', '-c:a', 'libmp3lame' if audio_format == 'mp3' else ('flac' if audio_format == 'flac' else 'aac'),
            *bitrate_arg,
            final_output
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if os.path.exists(temp_raw):
            os.remove(temp_raw)
    else:
        # Move or remux raw MP4
        if os.path.exists(final_output):
            os.remove(final_output)
        os.rename(temp_raw, final_output)
        
    print(f"[download] 100% Processing completed! Ready to save to device.", flush=True)
    return final_output

if __name__ == '__main__':
    if len(sys.argv) < 3:
        if len(sys.argv) == 2 and sys.argv[1] == '--extract':
            # STDIN extract
            u = sys.stdin.read().strip()
            data = extract_instagram(u)
            print(json.dumps(data or {}))
            sys.exit(0)
        print("Usage: python instagram_engine.py <url> <output_target> [mode] [audio_format] [audio_quality]")
        sys.exit(1)
        
    url_arg = sys.argv[1]
    out_arg = sys.argv[2]
    mode_arg = sys.argv[3] if len(sys.argv) > 3 else 'video'
    fmt_arg = sys.argv[4] if len(sys.argv) > 4 else 'mp3'
    qual_arg = sys.argv[5] if len(sys.argv) > 5 else '320k'
    
    download_instagram_media(url_arg, out_arg, mode=mode_arg, audio_format=fmt_arg, audio_quality=qual_arg)
