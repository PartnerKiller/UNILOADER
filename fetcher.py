import os
import sys
import io
import json
import re
import html as html_lib
import base64
import urllib.parse
import urllib.request
from bs4 import BeautifulSoup

try:
    if hasattr(sys.stdout, 'buffer') and (not sys.stdout.encoding or 'utf' not in sys.stdout.encoding.lower()):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'buffer') and (not sys.stderr.encoding or 'utf' not in sys.stderr.encoding.lower()):
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        try:
            with open(env_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#') and '=' in line:
                        k, v = line.split('=', 1)
                        k = k.strip()
                        v = v.strip().strip("'\"")
                        if k not in os.environ:
                            os.environ[k] = v
        except Exception:
            pass

load_env()

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

def is_stream_healthy(stream_url, referer=None, session=None, timeout=4):
    """Proactively verifies that an HLS/media stream is reachable (HTTP 200, valid manifest)."""
    if not stream_url or not isinstance(stream_url, str) or not stream_url.startswith('http'):
        return False
    try:
        from curl_cffi import requests
        s = session or requests.Session(impersonate="chrome124")
        h = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': '*/*'
        }
        if referer:
            h['Referer'] = referer
        r = s.get(stream_url, headers=h, timeout=timeout, stream=True, allow_redirects=True)
        if r.status_code != 200:
            return False
        
        # Read the first chunk (up to 1024 bytes) to verify it's a valid playlist
        chunk = next(r.iter_content(chunk_size=1024), b'')
        if b'#EXTM3U' not in chunk and b'#EXT' not in chunk:
            return len(chunk) > 0
        
        # If it's a master playlist, check child playlist reachability (prevents dead CDN domain errors like in turbovid)
        chunk_str = chunk.decode('utf-8', errors='ignore')
        lines = [line.strip() for line in chunk_str.splitlines() if line.strip()]
        child_urls = [line for line in lines if not line.startswith('#') and ('.m3u8' in line or line.endswith('.ts'))]
        if child_urls:
            child_url = child_urls[0]
            if not child_url.startswith('http'):
                from urllib.parse import urljoin
                child_url = urljoin(stream_url, child_url)
            try:
                c_resp = s.get(child_url, headers=h, timeout=timeout, stream=True, allow_redirects=True)
                if c_resp.status_code != 200:
                    return False
            except Exception:
                return False
        return True
    except Exception:
        return False

def extract_clean_jav_code(text):
    if not text or not isinstance(text, str):
        return None
    # 1. FC2 PPV format (e.g. FC2-PPV-1234567 or FC2-123456)
    fc2 = re.search(r'\bFC2[-_ ]?(?:PPV[-_ ]?)?(\d{5,7})\b', text, re.IGNORECASE)
    if fc2:
        return f"FC2-PPV-{fc2.group(1)}"
    # 2. Standard hyphenated studio codes (e.g. IPX-923, SNOS-016, MIDV-001)
    std = re.search(r'\b([A-Za-z]{2,6})[-_](\d{2,5})\b', text)
    if std:
        letters = std.group(1).upper()
        num_str = std.group(2)
        if letters not in {'HTTP', 'HTTPS', 'HTML', 'MP4', 'MKV', 'WEBM', 'FLAC', 'JPEG', 'JPG', 'PNG', 'VIDEO', 'ADMIN', 'LOGIN', 'JAVGG'}:
            return f"{letters}-{num_str}"
    # 3. Compact studio codes (e.g. IPX923, SSIS001)
    compact = re.search(r'\b([A-Za-z]{2,5})(\d{3,5})\b', text)
    if compact:
        letters = compact.group(1).upper()
        num_str = compact.group(2)
        if letters not in {'HTTP', 'HTTPS', 'HTML', 'MP4', 'MKV', 'WEBM', 'FLAC', 'JPEG', 'JPG', 'PNG', 'VIDEO', 'ADMIN', 'LOGIN', 'JAVGG'}:
            return f"{letters}-{num_str}"
    return None

def resolve_fallback_jav_stream(jav_code, session=None):
    """Cascade queries MissAV and Jable for working 1080p/720p streams when the primary provider has broken embeds."""
    if not jav_code:
        return None
    from curl_cffi import requests
    s = session or requests.Session(impersonate="chrome124")
    clean_code = jav_code.lower().strip()

    # 1. MissAV Fallback
    missav_candidates = [
        f"https://missav.ws/{clean_code}",
        f"https://missav.ws/en/{clean_code}",
        f"https://missav.ai/{clean_code}"
    ]
    for m_url in missav_candidates:
        try:
            r = s.get(m_url, headers={'Referer': 'https://missav.ws/'}, timeout=10)
            if r.status_code == 200 and ('playlist.m3u8' in r.text or 'eval(function(p,a,c,k,e,d)' in r.text):
                hls_candidate = ''
                packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", r.text, re.DOTALL)
                for p in packed_matches:
                    unpacked = unpack_packer(p)
                    m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                    if m3u8_matches:
                        hls_candidate = m3u8_matches[0].rstrip('\\')
                        break
                    surrit_matches = re.findall(r'https?://(?:surrit|sixyik)\.com/[0-9a-f-]+/playlist\.m3u8', unpacked)
                    if surrit_matches:
                        hls_candidate = surrit_matches[0].rstrip('\\')
                        break
                if not hls_candidate:
                    uuid_match = re.search(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/playlist\.m3u8', r.text)
                    if uuid_match:
                        hls_candidate = f"https://surrit.com/{uuid_match.group(1)}/playlist.m3u8"

                if hls_candidate and is_stream_healthy(hls_candidate, referer='https://missav.ws/', session=s):
                    soup = BeautifulSoup(r.text, 'html.parser')
                    og_img = soup.find('meta', property='og:image')
                    poster = og_img.get('content') if og_img else ''
                    return {
                        'hlsUrl': hls_candidate,
                        'downloadTargetUrl': hls_candidate,
                        'poster': poster,
                        'extractor': 'JavGG (MissAV Fallback)',
                        'referer': 'https://missav.ws/'
                    }
        except Exception:
            pass

    # 2. Jable Fallback
    jable_candidates = [
        f"https://jable.tv/videos/{clean_code}/",
        f"https://en.jable.tv/videos/{clean_code}/"
    ]
    for j_url in jable_candidates:
        try:
            r = s.get(j_url, headers={'Referer': 'https://jable.tv/'}, timeout=10)
            if r.status_code == 200:
                hls_match = re.search(r"var\s+hlsUrl\s*=\s*'([^']+)'", r.text)
                if hls_match:
                    hls_candidate = hls_match.group(1)
                    if hls_candidate and is_stream_healthy(hls_candidate, referer='https://jable.tv/', session=s):
                        img_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', r.text)
                        poster = img_match.group(1) if img_match else ''
                        return {
                            'hlsUrl': hls_candidate,
                            'downloadTargetUrl': hls_candidate,
                            'poster': poster,
                            'extractor': 'JavGG (Jable Fallback)',
                            'referer': 'https://en.jable.tv/'
                        }
        except Exception:
            pass

    return None

def extract_all(url):
    url = url.strip()
    from curl_cffi import requests

    session = requests.Session(impersonate="chrome124")
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    }

    # -------------------------------------------------------------
    # 0.00 TikTok Watermark-Free HD (tiktok.com)
    # -------------------------------------------------------------
    if 'tiktok.com' in url:
        try:
            from tiktok_engine import extract_tiktok
            tt_data = extract_tiktok(url)
            if tt_data and tt_data.get('video_url'):
                return {
                    'title': tt_data.get('title', 'TikTok Video'),
                    'code': 'TIKTOK',
                    'poster': tt_data.get('thumbnail', ''),
                    'hlsUrl': tt_data.get('video_url', ''),
                    'downloadTargetUrl': url,
                    'tags': ['TikTok', 'HD', 'NoWatermark'],
                    'model': tt_data.get('uploader', 'TikTok Creator'),
                    'duration': tt_data.get('duration') or 'Video',
                    'extractor': 'TikTok',
                    'sourceUrl': url
                }
        except Exception as e:
            print(f"[WARN] TikTok custom extractor error: {e}", file=sys.stderr)

    # -------------------------------------------------------------
    # 0.0 Instagram Reels / Posts (instagram.com)
    # -------------------------------------------------------------
    if 'instagram.com' in url:
        try:
            from instagram_engine import extract_instagram
            ig_data = extract_instagram(url)
            if ig_data and ig_data.get('video_url'):
                return {
                    'title': ig_data.get('title', 'Instagram Reel'),
                    'code': 'INSTAGRAM',
                    'poster': ig_data.get('thumbnail', ''),
                    'hlsUrl': ig_data.get('video_url', ''),
                    'downloadTargetUrl': url,
                    'tags': ['Instagram', 'Reel', 'Video'],
                    'model': ig_data.get('uploader', 'Instagram Creator'),
                    'duration': ig_data.get('duration') or 'Reel',
                    'extractor': 'Instagram',
                    'sourceUrl': url
                }
        except Exception as e:
            print(f"[WARN] Instagram custom extractor error: {e}", file=sys.stderr)

    # -------------------------------------------------------------
    # 0.000 SoundCloud (soundcloud.com)
    # -------------------------------------------------------------
    if 'soundcloud.com' in url:
        try:
            oe_url = f"https://soundcloud.com/oembed?format=json&url={urllib.parse.quote(url)}"
            r_oe = session.get(oe_url, timeout=8)
            if r_oe.status_code == 200:
                oe_data = r_oe.json()
                sc_title = oe_data.get('title') or 'SoundCloud Track'
                sc_author = oe_data.get('author_name') or 'SoundCloud Artist'
                sc_thumb = oe_data.get('thumbnail_url') or ''
                return {
                    'title': sc_title,
                    'code': 'SOUNDCLOUD',
                    'poster': sc_thumb,
                    'hlsUrl': url,
                    'downloadTargetUrl': url,
                    'tags': ['SoundCloud', 'Audio', 'Music'],
                    'model': sc_author,
                    'duration': 'Audio Track',
                    'extractor': 'SoundCloud',
                    'sourceUrl': url,
                    'mode': 'audio'
                }
        except Exception as e:
            print(f"[WARN] SoundCloud oEmbed notice: {e}", file=sys.stderr)

    # -------------------------------------------------------------
    # 0. Spotify (open.spotify.com)
    # -------------------------------------------------------------
    if 'spotify.com' in url:
        # Fast oEmbed verification (0-auth, detects 404s in 100ms)
        oembed_data = None
        try:
            r_oe = session.get(f"https://open.spotify.com/oembed?url={urllib.parse.quote(url)}", timeout=6)
            if r_oe.status_code == 200:
                oembed_data = r_oe.json()
            elif r_oe.status_code == 404:
                return {'error': 'Spotify track, album, or playlist not found (HTTP 404). Please verify that the link is public and active.'}
        except Exception:
            pass

        # 1. SpotDL full catalog extractor (supports all 100, 300, 1000+ tracks)
        try:
            from spotdl.utils.spotify import SpotifyClient
            SPOTIFY_CLIENT_ID = os.environ.get('SPOTIFY_CLIENT_ID', '').strip()
            SPOTIFY_CLIENT_SECRET = os.environ.get('SPOTIFY_CLIENT_SECRET', '').strip()
            SpotifyClient.init(client_id=SPOTIFY_CLIENT_ID, client_secret=SPOTIFY_CLIENT_SECRET, user_auth=False, use_official_api=bool(SPOTIFY_CLIENT_ID))

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
                    'title': meta.get('name', 'Spotify Playlist'),
                    'code': 'SPOTIFY-PLAYLIST',
                    'poster': meta.get('cover_url', ''),
                    'hlsUrl': tracks[0]['query'] if tracks else f"ytsearch1:{meta.get('name', 'Spotify')} audio",
                    'downloadTargetUrl': tracks[0]['query'] if tracks else f"ytsearch1:{meta.get('name', 'Spotify')} audio",
                    'tags': ['Playlist', 'Spotify', 'Music'],
                    'model': f"{len(tracks)} Tracks",
                    'duration': f"{len(tracks)} Tracks",
                    'isPlaylist': True,
                    'playlistTracks': tracks,
                    'extractor': 'Spotify',
                    'sourceUrl': url,
                    'mode': 'audio'
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
                    'title': meta.get('name', 'Spotify Album'),
                    'code': 'SPOTIFY-ALBUM',
                    'poster': meta.get('cover_url', ''),
                    'hlsUrl': tracks[0]['query'] if tracks else f"ytsearch1:{meta.get('name', 'Spotify')} audio",
                    'downloadTargetUrl': tracks[0]['query'] if tracks else f"ytsearch1:{meta.get('name', 'Spotify')} audio",
                    'tags': ['Album', 'Spotify', 'Music'],
                    'model': f"{len(tracks)} Tracks",
                    'duration': f"{len(tracks)} Tracks",
                    'isPlaylist': True,
                    'playlistTracks': tracks,
                    'extractor': 'Spotify',
                    'sourceUrl': url,
                    'mode': 'audio'
                }
            elif 'track' in url:
                from spotdl.types.song import Song
                s = Song.from_url(url)
                artist_str = ', '.join(s.artists) if s.artists else s.artist
                full_name = f"{artist_str} - {s.name}" if artist_str else s.name
                return {
                    'title': full_name,
                    'code': 'SPOTIFY',
                    'poster': s.cover_url or '',
                    'hlsUrl': f"ytsearch1:{full_name} audio",
                    'downloadTargetUrl': f"ytsearch1:{full_name} audio",
                    'tags': ['Spotify', 'Music'],
                    'model': artist_str,
                    'duration': '',
                    'extractor': 'Spotify',
                    'sourceUrl': url,
                    'mode': 'audio'
                }
        except Exception as e:
            pass

        # 2. Embed page fallback
        try:
            pl_m = re.search(r'playlist/([a-zA-Z0-9]+)', url)
            album_m = re.search(r'album/([a-zA-Z0-9]+)', url)
            track_m = re.search(r'track/([a-zA-Z0-9]+)', url)

            if pl_m:
                pl_id = pl_m.group(1)
                embed_url = f"https://open.spotify.com/embed/playlist/{pl_id}"
                r = session.get(embed_url, timeout=10)
                soup = BeautifulSoup(r.text, 'html.parser')
                script = soup.find('script', id='__NEXT_DATA__')
                if script:
                    data = json.loads(script.text)
                    entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
                    pl_name = entity.get('name', 'Spotify Playlist')
                    poster = ''
                    v_images = entity.get('visualIdentity', {}).get('image', []) if entity.get('visualIdentity') else []
                    if v_images and isinstance(v_images, list):
                        sorted_imgs = sorted(v_images, key=lambda x: x.get('maxWidth', 0) or x.get('maxHeight', 0), reverse=True)
                        poster = sorted_imgs[0].get('url', '')
                    if not poster:
                        sources = entity.get('coverArt', {}).get('sources', []) if entity.get('coverArt') else []
                        poster = sources[0].get('url') if sources else ''
                    if not poster and oembed_data:
                        poster = oembed_data.get('thumbnail_url', '')
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
                    return {
                        'title': pl_name,
                        'code': 'SPOTIFY-PLAYLIST',
                        'poster': poster,
                        'hlsUrl': tracks[0]['query'] if tracks else f"ytsearch1:{pl_name} audio",
                        'downloadTargetUrl': tracks[0]['query'] if tracks else f"ytsearch1:{pl_name} audio",
                        'tags': ['Playlist', 'Spotify', 'Music'],
                        'model': f"{len(tracks)} Tracks",
                        'duration': f"{len(tracks)} Tracks",
                        'isPlaylist': True,
                        'playlistTracks': tracks,
                        'extractor': 'Spotify',
                        'sourceUrl': url,
                        'mode': 'audio'
                    }

            elif album_m:
                album_id = album_m.group(1)
                embed_url = f"https://open.spotify.com/embed/album/{album_id}"
                r = session.get(embed_url, timeout=10)
                soup = BeautifulSoup(r.text, 'html.parser')
                script = soup.find('script', id='__NEXT_DATA__')
                if script:
                    data = json.loads(script.text)
                    entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
                    album_name = entity.get('name', 'Spotify Album')
                    poster = ''
                    v_images = entity.get('visualIdentity', {}).get('image', []) if entity.get('visualIdentity') else []
                    if v_images and isinstance(v_images, list):
                        sorted_imgs = sorted(v_images, key=lambda x: x.get('maxWidth', 0) or x.get('maxHeight', 0), reverse=True)
                        poster = sorted_imgs[0].get('url', '')
                    if not poster:
                        sources = entity.get('coverArt', {}).get('sources', []) if entity.get('coverArt') else []
                        poster = sources[0].get('url') if sources else ''
                    if not poster and oembed_data:
                        poster = oembed_data.get('thumbnail_url', '')
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
                    return {
                        'title': album_name,
                        'code': 'SPOTIFY-ALBUM',
                        'poster': poster,
                        'hlsUrl': tracks[0]['query'] if tracks else f"ytsearch1:{album_name} audio",
                        'downloadTargetUrl': tracks[0]['query'] if tracks else f"ytsearch1:{album_name} audio",
                        'tags': ['Album', 'Spotify', 'Music'],
                        'model': f"{len(tracks)} Tracks",
                        'duration': f"{len(tracks)} Tracks",
                        'isPlaylist': True,
                        'playlistTracks': tracks,
                        'extractor': 'Spotify',
                        'sourceUrl': url,
                        'mode': 'audio'
                    }

            elif track_m:
                track_id = track_m.group(1)
                embed_url = f"https://open.spotify.com/embed/track/{track_id}"
                r = session.get(embed_url, timeout=10)
                soup = BeautifulSoup(r.text, 'html.parser')
                script = soup.find('script', id='__NEXT_DATA__')
                if script:
                    data = json.loads(script.text)
                    entity = data.get('props', {}).get('pageProps', {}).get('state', {}).get('data', {}).get('entity', {})
                    if entity and entity.get('name'):
                        title = entity.get('name')
                        artists = ', '.join([a.get('name') for a in entity.get('artists', []) if a.get('name')])
                        poster = ''
                        v_images = entity.get('visualIdentity', {}).get('image', []) if entity.get('visualIdentity') else []
                        if v_images and isinstance(v_images, list):
                            sorted_imgs = sorted(v_images, key=lambda x: x.get('maxWidth', 0) or x.get('maxHeight', 0), reverse=True)
                            poster = sorted_imgs[0].get('url', '')
                        if not poster:
                            sources = entity.get('coverArt', {}).get('sources', []) if entity.get('coverArt') else []
                            poster = sources[0].get('url') if sources else ''
                        if not poster and oembed_data:
                            poster = oembed_data.get('thumbnail_url', '')
                        full_name = f"{artists} - {title}" if artists else title
                        return {
                            'title': full_name,
                            'code': 'SPOTIFY',
                            'poster': poster,
                            'hlsUrl': f"ytsearch1:{full_name} audio",
                            'downloadTargetUrl': f"ytsearch1:{full_name} audio",
                            'tags': ['Spotify', 'Music'],
                            'model': artists,
                            'duration': '',
                            'extractor': 'Spotify',
                            'sourceUrl': url,
                            'mode': 'audio'
                        }
        except Exception as e:
            pass

        # 3. Songlink / Odesli metadata resolver
        try:
            track_m = re.search(r'track/([a-zA-Z0-9]+)', url)
            if track_m:
                track_id = track_m.group(1)
                r_sl = session.get(f"https://song.link/s/{track_id}", timeout=10)
                if r_sl.status_code == 200:
                    soup_sl = BeautifulSoup(r_sl.text, 'html.parser')
                    s_sl = soup_sl.find('script', id='__NEXT_DATA__')
                    if s_sl:
                        d_sl = json.loads(s_sl.text)
                        ed = d_sl.get('props', {}).get('pageProps', {}).get('pageData', {}).get('entityData', {})
                        sl_title = ed.get('title')
                        sl_artist = ed.get('artistName')
                        sl_thumb = ed.get('thumbnailUrl')
                        if sl_title:
                            full_name = f"{sl_artist} - {sl_title}" if sl_artist else sl_title
                            return {
                                'title': full_name,
                                'code': 'SPOTIFY',
                                'poster': sl_thumb or '',
                                'hlsUrl': f"ytsearch1:{full_name} audio",
                                'downloadTargetUrl': f"ytsearch1:{full_name} audio",
                                'tags': ['Spotify', 'Music'],
                                'model': sl_artist or '',
                                'duration': '',
                                'extractor': 'Spotify',
                                'sourceUrl': url,
                                'mode': 'audio'
                            }
        except Exception as e:
            pass

        # 4. oEmbed Final Fallback
        if oembed_data and oembed_data.get('title'):
            oe_title = oembed_data.get('title')
            oe_thumb = oembed_data.get('thumbnail_url', '')
            return {
                'title': oe_title,
                'code': 'SPOTIFY',
                'poster': oe_thumb,
                'hlsUrl': f"ytsearch1:{oe_title} audio",
                'downloadTargetUrl': f"ytsearch1:{oe_title} audio",
                'tags': ['Spotify', 'Music'],
                'model': 'Spotify Artist',
                'duration': '',
                'extractor': 'Spotify',
                'sourceUrl': url,
                'mode': 'audio'
            }

    # -------------------------------------------------------------
    # Rule34Video (rule34video.com)
    # -------------------------------------------------------------
    if 'rule34video.com' in url:
        headers['Referer'] = 'https://rule34video.com/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'Rule34 Video'
        title = re.sub(r'\s*\|\s*Rule34Video.*$', '', raw_title, flags=re.IGNORECASE).strip()

        video_streams = re.findall(r'(video_url[a-z0-9_]*|video_alt_url[a-z0-9_]*)\s*:\s*[\x27\x22](https?://[^\x27\x22]+)[\x27\x22]', html)
        stream_dict = {k: v for k, v in video_streams}
        
        target_stream = ''
        for key in ['video_alt_url4', 'video_alt_url3', 'video_alt_url2', 'video_alt_url', 'video_url']:
            if key in stream_dict:
                target_stream = stream_dict[key]
                break

        if not target_stream and video_streams:
            target_stream = video_streams[-1][1]

        poster_m = re.search(r'preview_url\s*:\s*[\x27\x22](https?://[^\x27\x22]+)[\x27\x22]', html)
        poster = poster_m.group(1) if poster_m else ''

        dur_list = re.findall(r'<[^>]+>\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*<', html)
        duration = dur_list[0] if dur_list else ''

        author_m = re.search(r'\[([A-Za-z0-9_\s-]+)\]', title)
        model = author_m.group(1).strip() if author_m else ''
        if not model:
            author_el = soup.find('a', href=re.compile(r'/models/|/uploaders/'))
            model = author_el.text.strip() if author_el else ''

        tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/tags/')) if a.text.strip() and a.text.strip().lower() != 'tags'][:10]

        code_m = re.search(r'/video/(\d+)', url)
        code = f"R34V-{code_m.group(1)}" if code_m else "RULE34"

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': target_stream or url,
            'downloadTargetUrl': url,
            'tags': tags,
            'model': model,
            'duration': duration,
            'extractor': 'Rule34Video',
            'sourceUrl': url
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

        # Validate extracted stream or cascade to fallback mirrors
        if hls_url and not is_stream_healthy(hls_url, referer=target_stream_url or url, session=session):
            hls_url = ''

        extractor_name = 'JavGuru'
        target_referer = target_stream_url or url
        if not hls_url:
            clean_code = extract_clean_jav_code(code) or extract_clean_jav_code(title) or extract_clean_jav_code(url)
            if clean_code:
                fallback = resolve_fallback_jav_stream(clean_code, session=session)
                if fallback:
                    hls_url = fallback['hlsUrl']
                    if not poster and fallback.get('poster'):
                        poster = fallback['poster']
                    extractor_name = fallback.get('extractor', 'JavGuru (Fallback)')
                    target_referer = fallback.get('referer', target_referer)

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url or target_stream_url,
            'downloadTargetUrl': hls_url or target_stream_url or url,
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': extractor_name,
            'sourceUrl': url,
            'referer': target_referer
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

        # Prioritize dedicated, unthrottled streaming CDNs over Google User Content proxies (which throw HTTP 429)
        def iframe_priority(ifr_url):
            u = (ifr_url or '').lower()
            if 'javstream' in u:
                return 1
            if 'earnvid' in u:
                return 2
            if any(k in u for k in ['streamtape', 'dood', 'mixdrop', 'filemoon']):
                return 3
            if 'turbovid' in u or 'turbosplayer' in u or 'google' in u:
                return 10
            return 5

        iframes = sorted(iframes, key=iframe_priority)

        hls_url = ''
        target_referer = 'https://javgg.net/'
        for ifr in iframes:
            try:
                ifr_res = session.get(ifr, headers={'Referer': url}, timeout=10)
                packed_matches = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", ifr_res.text, re.DOTALL)
                for p in packed_matches:
                    unpacked = unpack_packer(p)
                    m3u8_matches = re.findall(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                    for m in m3u8_matches:
                        clean_m = m.rstrip('\\')
                        if is_stream_healthy(clean_m, referer=ifr, session=session):
                            hls_url = clean_m
                            target_referer = ifr
                            break
                    if hls_url:
                        break
                    m3u8_raw = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', unpacked)
                    for m in m3u8_raw:
                        clean_m = m.rstrip('\\')
                        if is_stream_healthy(clean_m, referer=ifr, session=session):
                            hls_url = clean_m
                            target_referer = ifr
                            break
                    if hls_url:
                        break

                if hls_url:
                    break

                direct_m3u8 = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', ifr_res.text)
                for m in direct_m3u8:
                    clean_m = m.rstrip('\\')
                    if is_stream_healthy(clean_m, referer=ifr, session=session):
                        hls_url = clean_m
                        target_referer = ifr
                        break
                if hls_url:
                    break
            except Exception:
                continue

        # If primary JavGG embeds returned no working streams (e.g. 502 Bad Gateway, 404, or dead DNS),
        # gracefully cascade to verified high-speed JAV network mirrors (MissAV, Jable)
        extractor_name = 'JavGG'
        if not hls_url:
            clean_code = extract_clean_jav_code(code) or extract_clean_jav_code(title) or extract_clean_jav_code(url)
            if clean_code:
                fallback = resolve_fallback_jav_stream(clean_code, session=session)
                if fallback:
                    hls_url = fallback['hlsUrl']
                    if not poster and fallback.get('poster'):
                        poster = fallback['poster']
                    extractor_name = fallback.get('extractor', 'JavGG (Fallback)')
                    target_referer = fallback.get('referer', target_referer)

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url or (iframes[0] if iframes else url),
            'tags': tags[:10],
            'model': model,
            'duration': '',
            'extractor': extractor_name,
            'sourceUrl': url,
            'referer': target_referer
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
            title = html_lib.unescape(title_m.group(1).strip())
        else:
            title = soup.title.string.strip() if soup.title else 'XVideos Video'
            title = html_lib.unescape(re.sub(r'\s*-\s*XVIDEOS\.COM.*$', '', title, flags=re.IGNORECASE).strip())

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
    # 10. K-MIB (k-mib.com) - Premier Korean Adult Platform
    # -------------------------------------------------------------
    if 'k-mib.com' in url or 'kmib' in url:
        headers['Referer'] = 'https://k-mib.com/index.php'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = ''
        top_div = soup.find('div', class_='conts-view-top')
        if top_div:
            t_el = top_div.find('div', class_='title')
            if t_el:
                raw_title = t_el.text.strip()
        if not raw_title:
            raw_title = soup.title.string.strip() if soup.title else 'K-MIB Video'
        title = re.sub(r'\s*[:|-]\s*K-MIB.*$', '', raw_title, flags=re.IGNORECASE).strip()

        idx_match = re.search(r'idx=(\d+)', url)
        code = f"KMIB-{idx_match.group(1)}" if idx_match else 'KMIB'

        poster = ''
        ctrl_img = soup.find('div', class_='control')
        if ctrl_img and ctrl_img.find('img'):
            src = ctrl_img.find('img').get('src', '')
            if src:
                poster = urllib.parse.urljoin(url, src)
        if not poster:
            og_img = soup.find('meta', property='og:image')
            if og_img and og_img.get('content') and not og_img.get('content').endswith('24120615374902.jpg'):
                poster = og_img.get('content')

        stream_url = ''
        charlla_sources = re.findall(r'https://player-api\.charlla\.video/mp4/[a-zA-Z0-9_-]+', html)
        for c_url in charlla_sources:
            try:
                c_res = session.get(c_url, headers={'Referer': url}, timeout=10, allow_redirects=True)
                if c_res.status_code == 200:
                    stream_url = c_res.url
                    break
            except Exception:
                pass

        if not stream_url:
            mp4s = re.findall(r'https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*', html)
            if mp4s:
                stream_url = mp4s[0]

        tags = [t.text.strip() for t in soup.find_all('div', class_='label') if t.text.strip()]
        if not tags:
            tags = ['Korean Adult', 'K-MIB', 'Exclusive']

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': stream_url,
            'downloadTargetUrl': stream_url or url,
            'tags': tags[:10],
            'model': 'K-Girls',
            'duration': '',
            'extractor': 'K-MIB',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 11. Eporner (eporner.com) - 1080p / 4K 60fps Ultra HD
    # -------------------------------------------------------------
    if 'eporner.com' in url:
        try:
            req_ep = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.eporner.com/'})
            with urllib.request.urlopen(req_ep, timeout=12) as ep_resp:
                ep_html = ep_resp.read().decode('utf-8')
                ep_soup = BeautifulSoup(ep_html, 'html.parser')

                raw_title = ep_soup.title.string.strip() if ep_soup.title else 'Eporner Video'
                title = re.sub(r'\s*-\s*EPORNER.*$', '', raw_title, flags=re.IGNORECASE).strip()

                id_m = re.search(r'video-([a-zA-Z0-9]+)', url)
                code = id_m.group(1).upper() if id_m else 'EPORNER'

                poster = ''
                og_img = ep_soup.find('meta', property='og:image')
                if og_img and og_img.get('content'):
                    poster = og_img.get('content')

                tags = [a.text.strip() for a in ep_soup.find_all('a', href=re.compile(r'/cat/')) if a.text.strip()]

                stream_url = ''
                for res_q in ['1080', '720', '480', '360', '240']:
                    d_links = re.findall(rf'href=["\'](/dload/[^"\']*{res_q}[^"\']*\.mp4)["\']', ep_html)
                    if d_links:
                        stream_url = urllib.parse.urljoin('https://www.eporner.com', d_links[0])
                        break

                if not stream_url:
                    gvid = re.findall(r'https?://gvideo\.eporner\.com/[^\s"\'<>]+\.mp4', ep_html)
                    if gvid:
                        stream_url = gvid[0]

                return {
                    'title': title,
                    'code': code,
                    'poster': poster,
                    'hlsUrl': stream_url,
                    'downloadTargetUrl': stream_url or url,
                    'tags': tags[:10],
                    'model': '',
                    'duration': '',
                    'extractor': 'Eporner',
                    'sourceUrl': url
                }
        except Exception:
            pass

    # -------------------------------------------------------------
    # 12. Netflav (netflav.com) - Full HD Asian & JAV Streams
    # -------------------------------------------------------------
    if 'netflav' in url:
        headers['Referer'] = 'https://netflav.com/'
        r = session.get(url, headers=headers, timeout=20)
        html = r.text
        soup = BeautifulSoup(html, 'html.parser')

        raw_title = soup.title.string.strip() if soup.title else 'Netflav Video'
        title = re.sub(r'\s*[-|]\s*Netflav.*$', '', raw_title, flags=re.IGNORECASE).strip()

        id_m = re.search(r'id=([a-zA-Z0-9]+)', url)
        code = id_m.group(1).upper() if id_m else 'NETFLAV'

        poster = ''
        og_img = soup.find('meta', property='og:image')
        if og_img and og_img.get('content'):
            poster = og_img.get('content')

        hls_url = ''
        m3u8s = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', html)
        if m3u8s:
            hls_url = m3u8s[0]

        return {
            'title': title,
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': hls_url or url,
            'tags': ['Asian Adult', 'Netflav', 'JAV'],
            'model': '',
            'duration': '',
            'extractor': 'Netflav',
            'sourceUrl': url
        }

    # -------------------------------------------------------------
    # 13. HQPorner (hqporner.com & mydaddy.cc) - 1080p / 4K Ultra HD
    # -------------------------------------------------------------
    if 'hqporner.com' in url or 'mydaddy.cc' in url:
        try:
            headers['Referer'] = 'https://hqporner.com/'
            if 'mydaddy.cc' in url:
                e_res = session.get(url, headers={'Referer': 'https://hqporner.com/'}, timeout=15)
                e_html = e_res.text
                mp4s = re.findall(r'//[a-zA-Z0-9_-]+\.bigcdn\.cc/pubs/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+\.mp4', e_html)
                stream_url = ''
                for q in ['1080.mp4', '720.mp4', '360.mp4']:
                    for m in mp4s:
                        if q in m:
                            stream_url = 'https:' + m if m.startswith('//') else m
                            break
                    if stream_url:
                        break
                if not stream_url and mp4s:
                    stream_url = 'https:' + mp4s[0] if mp4s[0].startswith('//') else mp4s[0]

                return {
                    'title': 'HQPorner Video',
                    'code': 'HQPORNER',
                    'poster': '',
                    'hlsUrl': stream_url,
                    'downloadTargetUrl': stream_url or url,
                    'tags': ['HQPorner', '1080p'],
                    'model': '',
                    'duration': '',
                    'extractor': 'HQPorner',
                    'sourceUrl': url
                }
            else:
                r = session.get(url, headers=headers, timeout=20)
                html = r.text
                soup = BeautifulSoup(html, 'html.parser')

                raw_title = soup.title.string.strip() if soup.title else 'HQPorner Video'
                title = re.sub(r'\s*-\s*HQporner.*$', '', raw_title, flags=re.IGNORECASE).strip()

                id_m = re.search(r'/hdporn/(\d+)', url)
                code = f"HQP-{id_m.group(1)}" if id_m else 'HQPORNER'

                poster = ''
                og_img = soup.find('meta', property='og:image')
                if og_img and og_img.get('content'):
                    poster = og_img.get('content')
                    if poster.startswith('//'):
                        poster = 'https:' + poster

                dur_el = soup.find('span', class_=re.compile(r'fa-clock-o'))
                duration = dur_el.text.strip() if dur_el else ''

                tags = [a.text.strip() for a in soup.find_all('a', href=re.compile(r'/(tag|category|actress)/')) if a.text.strip()]

                stream_url = ''
                native_matches = re.findall(r"url:\s*['\"](/blocks/(?:nativeplayer|altplayer)\.php\?i=[^'\"]+)['\"]", html)
                if native_matches:
                    native_url = urllib.parse.urljoin('https://hqporner.com', native_matches[0])
                    n_res = session.get(native_url, headers={'Referer': url}, timeout=12)
                    iframe_src = re.findall(r'<iframe[^>]+src=["\']([^"\']+)["\']', n_res.text)
                    if iframe_src:
                        embed_url = iframe_src[0]
                        if embed_url.startswith('//'):
                            embed_url = 'https:' + embed_url
                        e_res = session.get(embed_url, headers={'Referer': 'https://hqporner.com/'}, timeout=15)
                        e_html = e_res.text
                        mp4s = re.findall(r'//[a-zA-Z0-9_-]+\.bigcdn\.cc/pubs/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+\.mp4', e_html)
                        for q in ['1080.mp4', '720.mp4', '360.mp4']:
                            for m in mp4s:
                                if q in m:
                                    stream_url = 'https:' + m if m.startswith('//') else m
                                    break
                            if stream_url:
                                break
                        if not stream_url and mp4s:
                            stream_url = 'https:' + mp4s[0] if mp4s[0].startswith('//') else mp4s[0]

                return {
                    'title': title,
                    'code': code,
                    'poster': poster,
                    'hlsUrl': stream_url,
                    'downloadTargetUrl': stream_url or url,
                    'tags': tags[:10] or ['HQPorner', '1080p Full HD'],
                    'model': '',
                    'duration': duration,
                    'extractor': 'HQPorner',
                    'sourceUrl': url
                }
        except Exception:
            pass

    # -------------------------------------------------------------
    # 13.5. JioSaavn (jiosaavn.com) - 320kbps Studio Master Audio
    # -------------------------------------------------------------
    if 'jiosaavn.com' in url or 'saavn' in url:
        try:
            m = re.search(r'jiosaavn\.com/song/[^/]+/([a-zA-Z0-9_-]+)', url)
            token = m.group(1) if m else None
            song_id = None
            if token:
                api_u = f"https://www.jiosaavn.com/api.php?__call=webapi.get&token={token}&type=song&_format=json"
                res_t = session.get(api_u, headers=headers, timeout=10)
                data_t = res_t.json()
                if data_t.get('songs'):
                    song_id = data_t['songs'][0].get('id')

            if song_id:
                details_u = f"https://www.jiosaavn.com/api.php?__call=song.getDetails&cc=in&_marker=0%3F_marker%3D0&_format=json&pids={song_id}"
                res_d = session.get(details_u, headers=headers, timeout=10)
                data_d = res_d.json()
                song = data_d.get(song_id, {})
                title = song.get('song') or song.get('title') or 'JioSaavn Track'
                artist = song.get('singers') or song.get('primary_artists') or ''
                album = song.get('album') or ''
                poster = (song.get('image') or '').replace('150x150', '500x500')
                enc_url = song.get('encrypted_media_url')
                stream_url = ''
                if enc_url:
                    from jiosaavn_engine import decrypt_media_url
                    stream_url = decrypt_media_url(enc_url) or ''

                return {
                    'title': f"{artist} - {title}" if artist else title,
                    'code': 'JIOSAAVN',
                    'poster': poster,
                    'hlsUrl': stream_url,
                    'downloadTargetUrl': stream_url or url,
                    'tags': ['JioSaavn', '320kbps', album] if album else ['JioSaavn', '320kbps'],
                    'model': artist,
                    'duration': song.get('duration', ''),
                    'extractor': 'JioSaavn',
                    'sourceUrl': url
                }
        except Exception:
            pass

    # -------------------------------------------------------------
    # 13.6. OMG.sexy & Stripchat (omg.sexy, stripchat.com)
    # -------------------------------------------------------------
    if any(d in url for d in ['omg.sexy', 'stripchat.com']):
        try:
            m = re.search(r'(?:omg\.sexy|stripchat\.com)/(?:(?:en|model|girls|user)/)?([a-zA-Z0-9_\-]+)', url)
            ignored_slugs = {'about', 'login', 'favorites', 'manifest.json', 'dmca', 'parental-control', 'terms', 'privacy', 'girls', 'trans', 'men', 'couples', 'tags', 'tag', 'videos', 'photos', 'feed', 'discover', 'tokens'}
            if m and m.group(1).lower() not in ignored_slugs:
                username = m.group(1)
                req_headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                }

                resp = session.get(f"https://omg.sexy/{username}", headers=req_headers, timeout=12)
                if resp.status_code != 200:
                    resp = session.get(f"https://stripchat.com/{username}", headers=req_headers, timeout=12)

                if resp.status_code == 200:
                    html_c = resp.text
                    idx = html_c.find('window.__PRELOADED_STATE__')
                    if idx != -1:
                        eq_idx = html_c.find('=', idx)
                        script_end = html_c.find('</script>', eq_idx)
                        raw_data = html_c[eq_idx+1:script_end].strip()
                        if raw_data.endswith(';'):
                            raw_data = raw_data[:-1].strip()

                        data = json.loads(raw_data)
                        view_cam = data.get('viewCam', {})
                        model_data = view_cam.get('model')

                        if model_data:
                            model_id = model_data.get('id')
                            user_display = model_data.get('username') or username
                            is_live = model_data.get('isLive', False)
                            status_label = model_data.get('status', 'live')

                            active_show = view_cam.get('show')
                            is_in_active_private = active_show and not active_show.get('endedAt') and active_show.get('mode') in ['private', 'p2p', 'groupShow']

                            if is_in_active_private:
                                raise Exception(f"Model {user_display} is currently in a private show.")
                            if not is_live:
                                raise Exception(f"Model {user_display} is currently offline.")

                            # Resolve HLS host
                            stream_host = None
                            config_v3 = data.get('configV3', {}) or data.get('config', {})
                            if isinstance(config_v3, dict):
                                static_feat = (config_v3.get('static') or {}).get('features') or (config_v3.get('static') or {}).get('featuresV2') or {}
                                fb_domains = (static_feat.get('hlsFallback') or {}).get('fallbackDomains')
                                if fb_domains and isinstance(fb_domains, list) and len(fb_domains) > 0:
                                    stream_host = fb_domains[0]

                            if not stream_host:
                                raw_hosts = re.findall(r'"hlsStreamHost":\s*"([^"]+)"', raw_data)
                                if raw_hosts:
                                    stream_host = raw_hosts[0]

                            if not stream_host:
                                stream_host = 'doppiocdn.org'

                            master_hls = f"https://edge-hls.{stream_host}/hls/{model_id}/master/{model_id}_auto.m3u8"
                            poster = model_data.get('snapshotUrl') or model_data.get('avatarUrl') or f"https://img.strpst.com/thumbs/{model_id}/{model_id}.jpg"
                            tags = model_data.get('tags') or []
                            if isinstance(tags, list):
                                tags = [str(t) for t in tags[:10]]
                            else:
                                tags = []

                            title = f"omg.sexy - {user_display} Live Stream"

                            return {
                                'title': title,
                                'code': f"OMG-{user_display.upper()}",
                                'poster': poster,
                                'hlsUrl': master_hls,
                                'downloadTargetUrl': master_hls,
                                'tags': tags,
                                'model': user_display,
                                'duration': 'LIVE',
                                'extractor': 'omg.sexy (Stripchat)',
                                'sourceUrl': url,
                                'maxHeight': 1080,
                                'maxFps': 30,
                                'qualityLabel': 'Source HD'
                            }
        except Exception as e:
            if 'offline' in str(e).lower() or 'private show' in str(e).lower():
                raise e
            pass

    # -------------------------------------------------------------
    # 14. Universal JAV & Video Sites (JavCL, Javmix, JavFull, JavDoe, Javseen, JavQuick, JavCt, 7MMTV, TokyoMotion, etc.)
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
    import shutil
    node_bin = shutil.which("node") or ("/usr/bin/node" if os.path.exists("/usr/bin/node") else None)
    cmd = ["yt-dlp", "--dump-single-json", "--skip-download", "--no-warnings", "--no-playlist"]
    if node_bin:
        cmd.extend(["--js-runtimes", f"node:{node_bin}"])
    cmd.extend(["--impersonate", "chrome", url])
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

        formats = info.get('formats') or []
        max_height = info.get('height') or 0
        max_fps = info.get('fps') or 0
        for f in formats:
            h = f.get('height') or 0
            fps = f.get('fps') or 0
            if h > max_height:
                max_height = h
            if fps > max_fps:
                max_fps = fps

        quality_label = '1080p HD'
        if max_height >= 4320:
            quality_label = '8K UHD'
        elif max_height >= 2160:
            quality_label = '4K 60fps' if max_fps >= 50 else '4K UHD'
        elif max_height >= 1440:
            quality_label = '2K 60fps' if max_fps >= 50 else '1440p QHD'
        elif max_height >= 1080:
            quality_label = '1080p60' if max_fps >= 50 else '1080p HD'
        elif max_height >= 720:
            quality_label = '720p HD'
        elif max_height > 0:
            quality_label = f'{max_height}p'

        return {
            'title': html_lib.unescape(title.strip()),
            'code': code,
            'poster': poster,
            'hlsUrl': hls_url,
            'downloadTargetUrl': url,
            'tags': tags[:10],
            'model': model,
            'duration': duration,
            'extractor': info.get('extractor') or 'Universal',
            'sourceUrl': url,
            'maxHeight': max_height,
            'maxFps': max_fps,
            'qualityLabel': quality_label
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
