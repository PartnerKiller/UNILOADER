#!/usr/bin/env python3
"""
Torrent 1:1 CD-Rip Engine
Searches and acquires lossless optical audio CD releases via BitTorrent swarms
(Apibay, 1337x, and public audiophile trackers) using aria2c.
"""

import os
import sys
import json
import time
import re
import urllib.parse
import urllib.request
import subprocess
import argparse
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

HIGH_SPEED_BT_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://9.rarbg.to:2920/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://explodie.org:6969/announce',
    'http://tracker.openbittorrent.com:80/announce'
]

def log(msg):
    print(f"[Torrent CD-Rip] {msg}", flush=True)

def score_torrent_candidate(name, size_bytes, seeders, query):
    """
    Scores candidate torrents for 1:1 CD-Rip suitability.
    Prefers FLAC, EAC, CUE, Audio CD markers. Filters out lossy and video.
    """
    nl = name.lower()
    score = 0

    # Negative filters (Reject video / lossy)
    for bad in ['1080p', '720p', '2160p', '4k', 'web-dl', 'bluray 1080', 'x264', 'x265', 'hevc', 'mkv', 'mp4']:
        if bad in nl:
            return -999999

    if any(lossy in nl for lossy in ['mp3', '320kbps', 'vbr', '192kbps', 'aac', 'ogg', 'm4a']):
        # If it explicitly says MP3 without mentioning FLAC, penalize heavily
        if 'flac' not in nl:
            return -50000

    # Optical provenance keywords
    if 'flac' in nl:
        score += 35000
    if any(k in nl for k in ['eac', 'xld', 'cue', 'cdda']):
        score += 25000
    if any(k in nl for k in ['cd-rip', 'cdrip', 'audio cd', 'optical rip', 'soundtrack cd']):
        score += 20000
    if any(k in nl for k in ['saregama', 'hmv', 'asha audio', 'cdnf', 'bengali']):
        score += 15000

    # Match tokens
    tokens = [t.lower() for t in re.findall(r'[a-zA-Z0-9]+', query) if len(t) > 2]
    matched = sum(1 for t in tokens if t in nl)
    score += matched * 7000

    # Seeder weighting
    score += min(seeders * 1000, 20000)

    # Size appropriateness for CD audio (100MB - 1.2GB)
    if 80 * 1024 * 1024 <= size_bytes <= 1200 * 1024 * 1024:
        score += 10000
    elif size_bytes < 30 * 1024 * 1024:
        score -= 10000

    return score

def query_apibay_music(query, max_candidates=20):
    """
    Queries Apibay API for music torrents matching the search query.
    """
    results = []
    clean_q = re.sub(r'[^a-zA-Z0-9\s]', ' ', query).strip()
    encoded = urllib.parse.quote(clean_q)
    url = f"https://apibay.org/q.php?q={encoded}&cat=100"

    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        )
        with urllib.request.urlopen(req, timeout=7) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if isinstance(data, list):
                for item in data:
                    name = item.get("name", "")
                    info_hash = item.get("info_hash", "")
                    if not info_hash or info_hash == "0000000000000000000000000000000000000000":
                        continue

                    size = int(item.get("size") or 0)
                    seeders = int(item.get("seeders") or 0)
                    leechers = int(item.get("leechers") or 0)

                    score = score_torrent_candidate(name, size, seeders, query)
                    if score < 0:
                        continue

                    # Build magnet
                    tr_params = "&".join([f"tr={urllib.parse.quote(tr)}" for tr in HIGH_SPEED_BT_TRACKERS])
                    magnet = f"magnet:?xt=urn:btih:{info_hash}&dn={urllib.parse.quote(name)}&{tr_params}"

                    results.append({
                        "id": f"tpb_{info_hash.lower()}",
                        "source": "torrent",
                        "tracker": "Apibay / BitTorrent Swarm",
                        "name": name,
                        "infoHash": info_hash,
                        "size": size,
                        "sizeStr": f"{round(size / (1024 * 1024), 1)} MB",
                        "seeders": seeders,
                        "leechers": leechers,
                        "magnet": magnet,
                        "hasFlacMention": 'flac' in name.lower(),
                        "hasEacMention": any(k in name.lower() for k in ['eac', 'cue', 'cdda']),
                        "score": score
                    })
    except Exception as e:
        log(f"Apibay query error: {e}")

    return results

def search_torrent_cdrip(query, max_results=10):
    """
    Searches torrent sources for candidate lossless optical CD releases.
    """
    candidates = []

    # 1. Direct query
    res1 = query_apibay_music(query)
    candidates.extend(res1)

    # 2. If no strong FLAC match, try "<query> FLAC"
    if not any(c.get("hasFlacMention") for c in candidates):
        res2 = query_apibay_music(f"{query} FLAC")
        # Deduplicate
        existing_hashes = {c["infoHash"] for c in candidates}
        for c in res2:
            if c["infoHash"] not in existing_hashes:
                candidates.append(c)

    # Sort descending by score
    candidates.sort(key=lambda x: x["score"], reverse=True)
    return candidates[:max_results]

def download_torrent_cdrip(magnet_or_torrent, output_dir, timeout_secs=240, progress_cb=None):
    """
    Downloads a torrent release via aria2c into output_dir.
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    aria_bin = "/usr/bin/aria2c" if os.path.exists("/usr/bin/aria2c") else "aria2c"

    args = [
        aria_bin,
        f"--dir={output_dir}",
        "--seed-time=0",
        "--max-connection-per-server=16",
        "--split=16",
        "--bt-max-peers=120",
        f"--bt-stop-timeout={timeout_secs}",
        "--summary-interval=2",
        "--enable-dht=true",
        "--bt-enable-lpd=true",
        "--enable-peer-exchange=true",
        "--peer-id-prefix=-qB4520-",
        "--user-agent=qBittorrent/4.5.2",
        f"--bt-tracker={','.join(HIGH_SPEED_BT_TRACKERS)}",
        "--file-allocation=none",
        "--follow-torrent=mem",
        magnet_or_torrent
    ]

    log(f"Starting BitTorrent swarm transfer via aria2c...")
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    last_pct = 0
    try:
        for line in proc.stdout:
            line = line.strip()
            # Match aria2 output: [#3a55fa 12MiB/45MiB(26%) CN:16 DL:5.2MiB ETA:6s]
            m = re.search(r'\[#\w+\s+([\d.]+\s*[a-zA-Z]+)/([\d.]+\s*[a-zA-Z]+)\((\d+)%\)(?:.*?DL:([\d.]+\s*[a-zA-Z]+))?(?:.*?ETA:([\w\d:]+))?', line)
            if m:
                dl_sz, tot_sz, pct_val, spd, eta_val = m.groups()
                spd_str = f"{spd}/s" if spd else "0 B/s"
                eta_s = eta_val or "--:--"
                print(f"[download] {pct_val}% of {tot_sz} at {spd_str} ETA {eta_s} (BitTorrent Swarm)", flush=True)
                if progress_cb:
                    progress_cb(int(pct_val))
            else:
                pct_m = re.search(r'\((\d{1,3})%\)', line)
                if pct_m:
                    pct = int(pct_m.group(1))
                    if pct != last_pct:
                        last_pct = pct
                        print(f"[download] {pct}% of BitTorrent Swarm at high-speed ETA Calculating...", flush=True)
                        if progress_cb:
                            progress_cb(pct)
                elif 'Download complete' in line or 'download completed' in line:
                    print(f"[download] 100% BitTorrent transfer complete.", flush=True)

        proc.wait(timeout=timeout_secs)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise TimeoutError("BitTorrent transfer timed out waiting for swarm peers.")

    if proc.returncode != 0:
        log(f"Aria2c finished with exit code {proc.returncode}")

    # Inspect downloaded files in output_dir
    files = list(output_dir.rglob("*"))
    flac_files = [f for f in files if f.suffix.lower() == '.flac']
    log(f"Acquired {len(files)} files via BitTorrent ({len(flac_files)} FLAC audio tracks).")

    return str(output_dir)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Torrent CD-Rip Engine")
    parser.add_argument("--search", type=str, help="Search query")
    parser.add_argument("--test", type=str, help="Test search and format output")
    parser.add_argument("--download", type=str, help="Download magnet link or torrent URL")
    parser.add_argument("--out", type=str, default="./temp_torrent_cdrip", help="Output directory")

    args = parser.parse_args()

    if args.test:
        log(f"Running test search for: '{args.test}'")
        res = search_torrent_cdrip(args.test)
        print(f"Found {len(res)} results:")
        for r in res:
            print(f"  • [{r['score']}] {r['name']} ({r['sizeStr']}) - 🟢 {r['seeders']} Seeds")
    elif args.search:
        res = search_torrent_cdrip(args.search)
        print(json.dumps(res))
    elif args.download:
        out = download_torrent_cdrip(args.download, args.out)
        print(f"Downloaded into: {out}")
