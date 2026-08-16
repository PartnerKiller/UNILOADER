import sys
import json
import re

def extract_all(url):
    url = url.strip()

    # 1. Jable.tv
    if 'jable.tv' in url:
        try:
            from curl_cffi import requests
            r = requests.get(url, impersonate="chrome124", headers={"Referer": "https://jable.tv/"}, timeout=15)
            html = r.text
        except Exception:
            import subprocess
            cmd = ["curl", "-s", "-L", url, "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "-H", "Referer: https://jable.tv/"]
            html = subprocess.run(cmd, capture_output=True, text=True).stdout

        hls_match = re.search(r"var\s+hlsUrl\s*=\s*'([^']+)'", html)
        hls_url = hls_match.group(1) if hls_match else ''

        title_match = re.search(r'<meta\s+property="og:title"\s+content="([^"]+)"', html)
        title = title_match.group(1) if title_match else 'video'

        img_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
        poster = img_match.group(1) if img_match else ''

        code_match = re.search(r'/videos/([^/?#]+)', url)
        code = code_match.group(1).upper() if code_match else 'VIDEO'

        tags = re.findall(r'<a[^>]+class="[^"]*tag[^"]*"[^>]*>([^<]+)</a>', html)
        model_match = re.search(r'<span[^>]+class="[^"]*placeholder[^"]*"[^>]+title="([^"]+)"', html)
        model = model_match.group(1) if model_match else ''

        return {
            'title': title.strip(),
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'Jable',
            'sourceUrl': url
        }

    # 2. Pornhub
    if 'pornhub' in url:
        try:
            from curl_cffi import requests
            r = requests.get(url, impersonate="chrome124", timeout=15)
            html = r.text
        except Exception:
            import subprocess
            cmd = ["curl", "-s", "-L", url, "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"]
            html = subprocess.run(cmd, capture_output=True, text=True).stdout

        m = re.search(r'flashvars_\d+\s*=\s*({.+?});', html)
        if m:
            data = json.loads(m.group(1))
            title = data.get('video_title') or 'Pornhub_Video'
            poster = data.get('image_url') or ''
            
            raw_duration = data.get('video_duration')
            duration_str = ''
            if raw_duration:
                try:
                    sec = int(raw_duration)
                    duration_str = f"{sec // 60}:{sec % 60:02d}"
                except Exception:
                    duration_str = str(raw_duration)

            defs = data.get('mediaDefinitions', [])
            hls_url = ''
            for d in defs:
                if isinstance(d, dict) and d.get('videoUrl'):
                    if str(d.get('quality')) in ['1080', '720'] and d.get('format') == 'hls':
                        hls_url = d.get('videoUrl')
                        break
                    if not hls_url:
                        hls_url = d.get('videoUrl')

            vk_m = re.search(r'viewkey=([^&]+)', url)
            code = vk_m.group(1).upper() if vk_m else 'PORNHUB'

            tags = re.findall(r'<a[^>]+href="[^"]*/tags/[^"]*"[^>]*>([^<]+)</a>', html)
            if not tags:
                tags = re.findall(r'<a[^>]+href="[^"]*/categories/[^"]*"[^>]*>([^<]+)</a>', html)

            return {
                'title': title.strip(),
                'code': code,
                'poster': poster,
                'hlsUrl': hls_url,
                'downloadTargetUrl': hls_url or url,
                'tags': [t.strip() for t in tags[:10]],
                'model': data.get('actionTags') or '',
                'duration': duration_str,
                'extractor': 'PornHub',
                'sourceUrl': url
            }

    # 3. Fallback to yt-dlp JSON dump
    import subprocess
    cmd = ["yt-dlp", "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0 and res.stdout.strip():
        info = json.loads(res.stdout)
        title = info.get('fulltitle') or info.get('title') or 'video'
        code = str(info.get('display_id') or info.get('id') or 'VIDEO').upper()
        poster = info.get('thumbnail') or ''
        tags = info.get('tags') or info.get('categories') or []
        model = info.get('uploader') or info.get('channel') or ''
        duration = info.get('duration_string') or ''
        hls_url = info.get('url') or url

        return {
            'title': title.strip(),
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': url,
            'tags': tags[:10],
            'model': model,
            'duration': duration,
            'extractor': info.get('extractor') or 'Universal',
            'sourceUrl': url
        }

    raise Exception("Could not extract video metadata from URL")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'No URL provided'}))
        sys.exit(1)

    try:
        data = extract_all(sys.argv[1])
        print(json.dumps(data))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
