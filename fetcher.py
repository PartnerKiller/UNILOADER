import sys
import json
import re
import base64
import urllib.parse
from bs4 import BeautifulSoup

def unpack_packer(packed_js):
    """Decodes Dean Edwards packer (eval(function(p,a,c,k,e,d)...))"""
    match = re.search(r"\}\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*?)'\.split\('\|'\)", packed_js, re.DOTALL)
    if not match:
        match = re.search(r"\}\((['\"].*?['\"]),\s*(\d+),\s*(\d+),\s*['\"](.*?)['\"]\.split\('\|'\)", packed_js, re.DOTALL)
        if match:
            payload = match.group(1).strip("'\"")
            radix_str, count_str, symtab_str = match.group(2), match.group(3), match.group(4)
        else:
            return ""
    else:
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
    from curl_cffi import requests

    session = requests.Session(impersonate="chrome124")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    }

    # -------------------------------------------------------------
    # 1. Jav.Guru (jav.guru)
    # -------------------------------------------------------------
    if 'jav.guru' in url:
        headers['Referer'] = 'https://jav.guru/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'JAV Guru Video'
        title = re.sub(r'\s*[\u22c6*|-]\s*Jav\s*Guru.*$', '', raw_title, flags=re.IGNORECASE).strip()

        code_match = re.search(r'\[([A-Za-z0-9_-]+)\]', title)
        if not code_match:
            code_match = re.search(r'\b([A-Za-z0-9]+-\d+)\b', title)
        code = code_match.group(1).upper() if code_match else 'JAVGURU'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')
        elif soup.find('div', class_='large-screenshot') and soup.find('div', class_='large-screenshot').find('img'):
            poster = soup.find('div', class_='large-screenshot').find('img').get('src', '')
        elif soup.find('img', class_=re.compile(r'attachment|thumbnail|cover', re.I)):
            poster = soup.find('img', class_=re.compile(r'attachment|thumbnail|cover', re.I)).get('src', '')

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(tag|category|actress)/')) if a.text.strip()]
        model = ''
        actress_a = soup.find('a', href=re.compile(r'/actress/'))
        if actress_a:
            model = actress_a.text.strip()

        # Extract base64 encoded iframe URLs
        b64_urls = re.findall(r'"iframe_url":\s*"([A-Za-z0-9+/=]+)"', html)
        hls_url = ''
        target_stream_url = ''

        for b64 in b64_urls:
            try:
                dec = base64.b64decode(b64).decode('utf-8')
                pr = session.get(dec, headers={'Referer': url}, timeout=12)
                psoup = BeautifulSoup(pr.text, 'html.parser')

                stream_box = psoup.find('div', class_='stream-box')
                if not stream_box:
                    continue

                keys = [k for k in stream_box.attrs if k.startswith('data-')]
                token = "".join([stream_box[k] for k in keys])[::-1]
                rtype_m = re.search(r"rtype:\s*['\"]([^'\"]+)['\"]", pr.text)
                rtype = rtype_m.group(1) if rtype_m else 'x'
                real_src = f"https://jav.guru/searcho/?{rtype}r={token}"

                rr = session.get(real_src, headers={'Referer': dec}, timeout=12)
                target_stream_url = rr.url

                # Check if final host is maxstream.org
                if 'maxstream.org' in rr.url:
                    packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", rr.text, re.DOTALL)
                    for p in packed:
                        unp = unpack_packer(p)
                        m = re.search(r'file:\s*"(https://[^"]+\.m3u8[^"]*)"', unp)
                        if m:
                            m3u8 = m.group(1)
                            view_m = re.search(r"\$\.get\('([^']+)'", unp)
                            if view_m:
                                view_url = view_m.group(1).replace("'+adb", "0")
                                session.get(view_url, headers={'Referer': rr.url})
                            hls_url = m3u8
                            break
                    if hls_url:
                        break

                # Direct m3u8 in player response
                direct_m3u8s = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', rr.text)
                if direct_m3u8s:
                    hls_url = direct_m3u8s[0]
                    break

                # Packed JS in player
                packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", rr.text, re.DOTALL)
                for p in packed:
                    unp = unpack_packer(p)
                    m3u8_m = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', unp)
                    if m3u8_m:
                        hls_url = m3u8_m[0]
                        break

                if hls_url:
                    break
            except Exception:
                continue

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url or target_stream_url,
            'downloadTargetUrl': hls_url or target_stream_url or url,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'JavGuru',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 2. MissAV (missav.ws, missav.ai, missav.live, missav.com, missav.net)
    # -------------------------------------------------------------
    if 'missav' in url:
        headers['Referer'] = 'https://missav.ws/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'MissAV Video'
        title = re.sub(r'\s*\|\s*MissAV.*$', '', raw_title, flags=re.IGNORECASE).strip()

        code_match = re.search(r'/(?:dm\d+/)?(?:en|ja|zh|ko|tw|cn)/([a-zA-Z0-9_-]+)', url)
        if not code_match:
            code_match = re.search(r'/([a-zA-Z0-9_-]+)$', url)
        code = code_match.group(1).upper() if code_match else 'MISSAV'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(genres|tags)/')) if a.text.strip()]
        model = ''
        actress_a = soup.find('a', href=re.compile(r'/actresses/'))
        if actress_a:
            model = actress_a.text.strip()

        hls_url = ''
        packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", html, re.DOTALL)
        for p in packed_matches:
            unpacked = unpack_packer(p)
            m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
            if m3u8_matches:
                hls_url = m3u8_matches[0].rstrip('\\')
                break
            surrit_matches = re.findall(r'https?://(?:surrit|sixyik)\.com/[0-9a-f-]+/playlist\.m3u8', unpacked)
            if surrit_matches:
                hls_url = surrit_matches[0].rstrip('\\')
                break

        if not hls_url:
            uuid_match = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/playlist\.m3u8', html)
            if uuid_match:
                hls_url = f"https://surrit.com/{uuid_match.group(1)}/playlist.m3u8"

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url or url,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'MissAV',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 3. SupJav (supjav.com, supjav.net, supremejav.com)
    # -------------------------------------------------------------
    if 'supjav' in url or 'supremejav' in url:
        headers['Referer'] = 'https://supjav.com/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'SupJav Video'
        title = re.sub(r'\s*-\s*Supjav.*$', '', raw_title, flags=re.IGNORECASE).strip()

        code_match = re.match(r'^([A-Z0-9-]+|\b[A-Za-z0-9]+-\d+\b)', title)
        code = code_match.group(1).upper() if code_match else 'SUPJAV'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')
        elif soup.find(id='player-wrap'):
            pstyle = soup.find(id='player-wrap').get('style', '')
            bg_m = re.search(r'url\(([^)]+)\)', pstyle)
            if bg_m:
                poster = bg_m.group(1).strip('\'"')

        tags = [a.text.strip() for a in soup.find_all('a', rel='category tag') if a.text.strip()]
        model = ''
        cast_span = soup.find('a', href=re.compile(r'/star/'))
        if cast_span:
            model = cast_span.text.strip()

        hls_url = ''
        server_btns = soup.find_all('a', class_='btn-server')
        for b in server_btns:
            data_link = b.get('data-link')
            if not data_link:
                continue
            rev_olid = data_link[::-1]
            player_url = f"https://lk1.supremejav.com/supjav.php?c={rev_olid}"
            try:
                pr = session.get(player_url, headers={'Referer': f"https://lk1.supremejav.com/supjav.php?l={data_link}&bg="}, timeout=12)
                direct_m3u8s = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', pr.text)
                if direct_m3u8s:
                    hls_url = direct_m3u8s[0]
                    break

                packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", pr.text, re.DOTALL)
                for p in packed:
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

                if pr.url and pr.url != player_url and not pr.url.startswith('https://lk1.supremejav.com'):
                    hls_url = pr.url
                    break
            except Exception:
                continue

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url or url,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'SupJav',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 4. JavGG (javgg.net, javgg.to, javgg.me)
    # -------------------------------------------------------------
    if 'javgg' in url:
        headers['Referer'] = 'https://javgg.net/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'JAVGG Video'
        title = re.sub(r'\s*-\s*Javgg.*$', '', raw_title, flags=re.IGNORECASE).strip()

        code_match = re.search(r'/jav/([^/?#]+)', url)
        code = code_match.group(1).upper() if code_match else 'JAVGG'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(genre|tag|category)/')) if a.text.strip()]
        model = ''
        cast = soup.find('a', href=re.compile(r'/cast/'))
        if cast:
            model = cast.text.strip()

        iframes = [ifr.get('src') or ifr.get('data-src') for ifr in soup.find_all('iframe') if ifr.get('src') or ifr.get('data-src')]

        hls_url = ''
        for ifr in iframes:
            try:
                ifr_res = session.get(ifr, headers={'Referer': url}, timeout=10)
                packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", ifr_res.text, re.DOTALL)
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

    # -------------------------------------------------------------
    # 5. nJAV & nJAVTv (njav.tv, njav.to, njav.org)
    # -------------------------------------------------------------
    if 'njav' in url:
        headers['Referer'] = 'https://njav.tv/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'nJAV Video'
        title = re.sub(r'\s*\|\s*nJAV.*$', '', raw_title, flags=re.IGNORECASE).strip()

        code_match = re.search(r'/v/([^/?#]+)', url)
        code = code_match.group(1).upper() if code_match else 'NJAV'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(genres|tags)/')) if a.text.strip()]
        model = ''
        actress_a = soup.find('a', href=re.compile(r'/actresses/'))
        if actress_a:
            model = actress_a.text.strip()

        hls_url = ''
        iframes = [ifr.get('src') or ifr.get('data-src') for ifr in soup.find_all('iframe') if ifr.get('src') or ifr.get('data-src')]
        for ifr in iframes:
            try:
                ifr_res = session.get(ifr, headers={'Referer': url}, timeout=10)
                packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", ifr_res.text, re.DOTALL)
                for p in packed_matches:
                    unpacked = unpack_packer(p)
                    m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                    if m3u8_matches:
                        hls_url = m3u8_matches[0]
                        break
                if hls_url:
                    break
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
            'extractor': 'nJAV',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 6. Jable.tv
    # -------------------------------------------------------------
    if 'jable.tv' in url:
        headers['Referer'] = 'https://jable.tv/'
        r = session.get(url, headers=headers, timeout=15)
        html = r.text

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

    # -------------------------------------------------------------
    # 7. Pornhub
    # -------------------------------------------------------------
    if 'pornhub' in url:
        r = session.get(url, headers=headers, timeout=15)
        html = r.text

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

    # -------------------------------------------------------------
    # 8. XVideos & XNXX (xvideos.com, xnxx.com, xvideos.red, xnxx.tv, xvideos2.com, etc.)
    # -------------------------------------------------------------
    if 'xvideos' in url or 'xnxx' in url:
        headers['Referer'] = 'https://www.xvideos.com/' if 'xvideos' in url else 'https://www.xnxx.com/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        title_m = re.search(r"html5player\.setVideoTitle\('([^']+)'\)", html)
        if title_m:
            title = title_m.group(1).strip()
        else:
            title = soup.title.string.strip() if soup.title else 'XVideos Video'
            title = re.sub(r'\s*-\s*XVIDEOS\.COM.*$', '', title, flags=re.IGNORECASE).strip()

        hls_m = re.search(r"html5player\.setVideoHLS\('([^']+)'\)", html)
        hls_url = hls_m.group(1) if hls_m else ''

        high_m = re.search(r"html5player\.setVideoUrlHigh\('([^']+)'\)", html)
        high_url = high_m.group(1) if high_m else ''

        thumb_m = re.search(r"html5player\.setThumbUrl169\('([^']+)'\)", html)
        if not thumb_m:
            thumb_m = re.search(r"html5player\.setThumbUrl\('([^']+)'\)", html)
        poster = thumb_m.group(1) if thumb_m else ''

        id_m = re.search(r'/video\.?([a-zA-Z0-9]+)/', url)
        if not id_m:
            id_m = re.search(r'/video([0-9]+)/', url)
        code = id_m.group(1).upper() if id_m else 'XVIDEOS'

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(tags|categories)/')) if a.text.strip()]
        model_m = soup.find('a', class_=re.compile(r'uploader-tag|model|name', re.I))
        model = model_m.text.strip() if model_m else ''

        stream_target = hls_url or high_url or url

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': stream_target,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': 'XVideos',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 9. xHamster (xhamster.com, xhamster1.com ... xhamster20.com, xhamster.desi, etc.)
    # -------------------------------------------------------------
    if 'xhamster' in url:
        headers['Referer'] = 'https://xhamster.com/'
        import subprocess
        cmd = ["yt-dlp", "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist", "--impersonate", "chrome", url]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0 and res.stdout.strip():
            info = json.loads(res.stdout)
            title = info.get('fulltitle') or info.get('title') or 'xHamster Video'
            code = str(info.get('display_id') or info.get('id') or 'XHAMSTER').upper()
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
                'extractor': 'xHamster',
                'sourceUrl': url
            }

    # -------------------------------------------------------------
    # 10. Universal JAV & Video Sites (JavCL, Javmix, JavFull, JavDoe, Javseen, JavQuick, JavCt, 7MMTV, TokyoMotion, etc.)
    # -------------------------------------------------------------
    try:
        r = session.get(url, headers=headers, timeout=20)
        if r.status_code == 200:
            html = r.text
            soup = BeautifulSoup(html, 'html.parser')

            raw_title = soup.title.string.strip() if soup.title else 'Video'
            title = re.sub(r'\s*[-|]\s*(JavCL|Javmix|JavFull|JavDoe|Javseen|JavQuick|JavCt|7MMTV|TokyoMotion|JapanHDV).*$', '', raw_title, flags=re.IGNORECASE).strip()

            poster = ''
            og_img = soup.find('meta', property='og:image')
            if og_img and og_img.get('content'):
                poster = og_img.get('content')

            iframes = [ifr.get('src') or ifr.get('data-src') for ifr in soup.find_all('iframe') if ifr.get('src') or ifr.get('data-src')]
            hls_url = ''

            for v in soup.find_all('video'):
                if v.get('src'):
                    hls_url = v.get('src')
                    break
                for s in v.find_all('source'):
                    if s.get('src'):
                        hls_url = s.get('src')
                        break

            if not hls_url:
                page_m3u8s = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', html)
                if page_m3u8s:
                    hls_url = page_m3u8s[0]

            if not hls_url:
                for ifr in iframes:
                    try:
                        ifr_url = ifr if ifr.startswith('http') else urllib.parse.urljoin(url, ifr)
                        ifr_res = session.get(ifr_url, headers={'Referer': url}, timeout=10)
                        packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\)\)\)", ifr_res.text, re.DOTALL)
                        for p in packed:
                            unpacked = unpack_packer(p)
                            m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                            if m3u8_matches:
                                hls_url = m3u8_matches[0]
                                break
                        if hls_url:
                            break
                        direct_m3u8 = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', ifr_res.text)
                        if direct_m3u8:
                            hls_url = direct_m3u8[0]
                            break
                    except Exception:
                        continue

            if hls_url:
                code_m = re.search(r'\b([A-Za-z0-9]+-\d+|FC2-PPV-\d+|PPV-\d+)\b', title, re.IGNORECASE)
                code = code_m.group(1).upper() if code_m else 'MEDIA'
                tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(genre|tag|category)/')) if a.text.strip()]

                return {
                    'title': title,
                    'code': code,
                    'poster': poster,
                    'hlsUrl': hls_url,
                    'downloadTargetUrl': hls_url,
                    'tags': tags[:10],
                    'model': '',
                    'duration': '',
                    'extractor': 'Universal-JAV',
                    'sourceUrl': url
                }
    except Exception:
        pass

    # -------------------------------------------------------------
    # 9. Universal Fallback (yt-dlp JSON dump with Chrome Impersonation)
    # -------------------------------------------------------------
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
