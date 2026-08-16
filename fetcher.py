import sys
import json
import re

def unpack_packer(packed_js):
    """Decodes Dean Edwards packer (eval(function(p,a,c,k,e,d)...))"""
    match = re.search(r"\}\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)", packed_js, re.DOTALL)
    if not match:
        return ""
    payload, radix_str, count_str, symtab_str = match.groups()
    radix = int(radix_str)
    count = int(count_str)
    symtab = symtab_str.split('|')
    
    def baseN(num, b):
        digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        if num == 0:
            return digits[0]
        res = ""
        while num > 0:
            res = digits[num % b] + res
            num = num // b
        return res

    lookup = {}
    for i in range(count):
        key = baseN(i, radix)
        val = symtab[i] if i < len(symtab) and symtab[i] else key
        lookup[key] = val

    def replace_fn(m):
        w = m.group(0)
        return lookup.get(w, w)

    return re.sub(r'\b\w+\b', replace_fn, payload)

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

    # 3. Javgg (javgg.net, javgg.to, javgg.me)
    if 'javgg' in url:
        from curl_cffi import requests
        from bs4 import BeautifulSoup
        
        session = requests.Session(impersonate="chrome124")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Referer': 'https://javgg.net/'
        }
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'JAVGG Video'
        # Clean title
        title = re.sub(r'\s*-\s*Javgg.*$', '', raw_title, flags=re.IGNORECASE).strip()

        # Extract code from URL or title
        code_match = re.search(r'/jav/([^/?#]+)', url)
        code = code_match.group(1).upper() if code_match else 'JAVGG'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')

        # Tags and categories
        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(genre|tag|category)/')) if a.text.strip()]
        model = ''
        cast = soup.find('a', href=re.compile(r'/cast/'))
        if cast:
            model = cast.text.strip()

        # Extract iframes
        iframes = []
        for iframe in soup.find_all('iframe'):
            src = iframe.get('src') or iframe.get('data-src') or ''
            if src:
                iframes.append(src)

        hls_url = ''
        # Try to resolve master.m3u8 from embedded players
        for ifr in iframes:
            try:
                ifr_res = session.get(ifr, headers={'Referer': url}, timeout=10)
                # Check for packed JS
                packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\)\)\)", ifr_res.text, re.DOTALL)
                for p in packed_matches:
                    unpacked = unpack_packer(p)
                    m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                    if m3u8_matches:
                        hls_url = m3u8_matches[0]
                        break
                    m3u8_raw = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', unpacked)
                    if m3u8_raw:
                        hls_url = m3u8_raw[0]
                        break

                if hls_url:
                    break

                # Direct m3u8 in ifr text
                direct_m3u8 = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', ifr_res.text)
                if direct_m3u8:
                    hls_url = direct_m3u8[0]
                    break
            except Exception:
                continue

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url or (iframes[0] if iframes else url),
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'JavGG',
            'sourceUrl': url
        }

    # 4. Fallback to yt-dlp JSON dump
    import subprocess
    cmd = ["yt-dlp", "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", "--impersonate", "chrome", url]
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
