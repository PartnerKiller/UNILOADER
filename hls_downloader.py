import sys
import os
import time
import signal
import concurrent.futures
from curl_cffi import requests
import subprocess
import re
import json
import shutil

active_temp_dir = None

def cleanup_signal_handler(signum, frame):
    global active_temp_dir
    if active_temp_dir and os.path.exists(active_temp_dir):
        try:
            shutil.rmtree(active_temp_dir, ignore_errors=True)
        except Exception:
            pass
    sys.exit(1)

signal.signal(signal.SIGINT, cleanup_signal_handler)
signal.signal(signal.SIGTERM, cleanup_signal_handler)

def unpack_packer(packed_js):
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

def resolve_and_download(input_url, output_file, max_workers=16):
    global active_temp_dir

    session = requests.Session(impersonate='chrome124')
    m3u8_url = None
    stream_session = session

    if 'jav.guru' in input_url:
        from bs4 import BeautifulSoup
        import base64
        r = session.get(input_url, headers={'Referer': 'https://jav.guru/'}, timeout=20)
        b64_urls = re.findall(r'"iframe_url":\s*"([A-Za-z0-9+/=]+)"', r.text)
        for b64 in b64_urls:
            try:
                dec = base64.b64decode(b64).decode('utf-8')
                pr = session.get(dec, headers={'Referer': input_url}, timeout=10)
                psoup = BeautifulSoup(pr.text, 'html.parser')
                sb = psoup.find('div', class_='stream-box')
                if not sb: continue
                keys = [k for k in sb.attrs if k.startswith('data-')]
                token = "".join([sb[k] for k in keys])[::-1]
                rtype_m = re.search(r"rtype:\s*['\"]([^'\"]+)['\"]", pr.text)
                rtype = rtype_m.group(1) if rtype_m else 'x'
                real_src = f"https://jav.guru/searcho/?{rtype}r={token}"
                rr = session.get(real_src, headers={'Referer': dec}, timeout=10)
                
                if 'maxstream.org' in rr.url:
                    stream_session = requests.Session(impersonate='chrome124')
                    em_r = stream_session.get(rr.url)
                    packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", em_r.text, re.DOTALL)
                    for p in packed:
                        unp = unpack_packer(p)
                        m = re.search(r'file:\s*"(https://[^"]+\.m3u8[^"]*)"', unp)
                        if m:
                            m3u8_url = m.group(1)
                            break
                    if m3u8_url:
                        break
            except Exception:
                continue

    elif 'maxstream.org' in input_url:
        stream_session = requests.Session(impersonate='chrome124')
        r = stream_session.get(input_url)
        packed = re.findall(r"eval\(function\(p,a,c,k,e,d\).*?\.split\('\|'\).*?\)\)", r.text, re.DOTALL)
        for p in packed:
            unp = unpack_packer(p)
            m = re.search(r'file:\s*"(https://[^"]+\.m3u8[^"]*)"', unp)
            if m:
                m3u8_url = m.group(1)
                break
    else:
        m3u8_url = input_url

    if not m3u8_url:
        raise Exception("Could not resolve streaming URL from source")

    print(f"[download] Resolved Stream M3U8: {m3u8_url}", flush=True)

    r = stream_session.get(m3u8_url, timeout=20)
    if r.status_code != 200:
        raise Exception(f"HTTP {r.status_code} fetching master playlist")

    playlist_url = m3u8_url
    lines = [l.strip() for l in r.text.splitlines() if l.strip()]
    sub_playlists = [l for l in lines if not l.startswith('#') and ('.m3u8' in l or 'm3u8' in l)]
    
    if sub_playlists:
        sub_url = sub_playlists[-1]
        if not sub_url.startswith('http'):
            sub_url = m3u8_url.rsplit('/', 1)[0] + '/' + sub_url
        sub_r = stream_session.get(sub_url, timeout=20)
        if sub_r.status_code == 200:
            playlist_url = sub_url
            lines = [l.strip() for l in sub_r.text.splitlines() if l.strip()]

    # Collect segments
    segments = []
    base_url = playlist_url.rsplit('/', 1)[0]
    for line in lines:
        if not line.startswith('#'):
            seg_url = line if line.startswith('http') else base_url + '/' + line
            segments.append(seg_url)

    total_segs = len(segments)
    if total_segs == 0:
        raise Exception("No video segments found in playlist")

    print(f"[download] Destination: {output_file}", flush=True)
    print(f"[download] Total fragments: {total_segs}", flush=True)

    temp_dir = output_file + "_parts"
    active_temp_dir = temp_dir
    os.makedirs(temp_dir, exist_ok=True)

    downloaded_bytes = 0
    completed_count = 0
    start_time = time.time()

    def download_part(idx, seg_url):
        part_path = os.path.join(temp_dir, f"seg_{idx:05d}.ts")
        if os.path.exists(part_path) and os.path.getsize(part_path) > 1024:
            return idx, os.path.getsize(part_path)

        for attempt in range(5):
            try:
                res = stream_session.get(seg_url, timeout=25)
                if res.status_code == 200 and len(res.content) > 0:
                    with open(part_path, 'wb') as f:
                        f.write(res.content)
                    return idx, len(res.content)
            except Exception:
                time.sleep(0.3 * (attempt + 1))

        raise Exception(f"Failed to download segment {idx}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_map = {executor.submit(download_part, i, seg): i for i, seg in enumerate(segments)}
        for future in concurrent.futures.as_completed(future_map):
            idx, size = future.result()
            downloaded_bytes += size
            completed_count += 1

            pct = (completed_count / total_segs) * 100
            elapsed = max(0.1, time.time() - start_time)
            speed = downloaded_bytes / elapsed
            speed_mb = speed / (1024 * 1024)
            mb_done = downloaded_bytes / (1024 * 1024)
            est_total_mb = (mb_done / completed_count) * total_segs if completed_count > 0 else mb_done
            eta_sec = int((total_segs - completed_count) / (completed_count / elapsed)) if completed_count > 0 else 0
            eta_str = f"{eta_sec//60:02d}:{eta_sec%60:02d}"

            print(f"[download] {pct:5.1f}% of ~{est_total_mb:.1f}MiB at {speed_mb:.2f}MiB/s ETA {eta_str} (frag {completed_count}/{total_segs})", flush=True)

    # Merge fragments into single MP4
    concat_list_file = os.path.join(temp_dir, "concat.txt")
    with open(concat_list_file, 'w', encoding='utf-8') as f:
        for i in range(total_segs):
            part_name = f"seg_{i:05d}.ts"
            f.write(f"file '{part_name}'\n")

    print("[ffmpeg] Merging fragments into MP4 container...", flush=True)
    ffmpeg_bin = 'ffmpeg'
    local_app_data = os.environ.get('LOCALAPPDATA', '')
    candidates = [
        os.path.join(local_app_data, 'Microsoft', 'WinGet', 'Packages', 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe', 'ffmpeg-9.0-full_build', 'bin', 'ffmpeg.exe'),
        'ffmpeg'
    ]
    for c in candidates:
        if os.path.exists(c):
            ffmpeg_bin = c
            break

    cmd = [
        ffmpeg_bin, "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_list_file,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        output_file
    ]
    sub = subprocess.run(cmd, capture_output=True, text=True)
    if sub.returncode != 0:
        raise Exception(f"FFmpeg merge failed: {sub.stderr[:400]}")

    # Cleanup parts
    shutil.rmtree(temp_dir, ignore_errors=True)
    active_temp_dir = None
    print(f"[download] 100% of video downloaded and merged into {output_file}!", flush=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python hls_downloader.py <url> <output_file>")
        sys.exit(1)

    url = sys.argv[1]
    output_file = sys.argv[2]
    try:
        resolve_and_download(url, output_file)
        sys.exit(0)
    except Exception as e:
        print(f"[ERR] Error: {e}", file=sys.stderr)
        sys.exit(1)
