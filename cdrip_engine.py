#!/usr/bin/env python3
"""
CD-Rip Acquisition & Provenance Engine (cdrip_engine.py)
Dedicated subsystem for acquiring and verifying 1:1 physical Audio CD releases.
- Searches P2P swarms (SLSKD) for entire album release folders.
- Prioritizes directories containing .cue sheets, EAC/XLD logs, and Scans/.
- Scores candidates via the CD-Rip Provenance Ranking Matrix (favoring authentic Red Book 16-bit 44.1kHz).
- Downloads complete release packages and executes multi-pass cdrip_verifier.
- Falls back to 16-bit CDDA lossless stream if no optical rip directory is currently seeded.
"""

import os
import sys
import re
import time
import json
import shutil
import urllib.parse
from curl_cffi import requests

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from catalogue_parser import parse_catalogue_number, is_catalogue_query, clean_search_tokens
from cdrip_verifier import inspect_cdrip_directory, verify_red_book_pcm

SLSKD_API_BASE = os.environ.get('SLSKD_API_BASE', 'http://127.0.0.1:5030/api/v0')
session = requests.Session(impersonate="chrome124")

def log(msg):
    print(f"[CD-Rip Engine] {msg}", flush=True)

def is_slskd_online():
    try:
        r = session.get(f"{SLSKD_API_BASE}/options", timeout=2)
        return r.status_code == 200
    except Exception:
        return False

def get_slskd_downloads_dir():
    try:
        r = session.get(f"{SLSKD_API_BASE}/options", timeout=2)
        if r.status_code == 200:
            d = r.json().get('directories', {}).get('downloads')
            if d and os.path.exists(d):
                return d
    except Exception:
        pass
    env_dir = os.environ.get('SLSKD_DOWNLOADS_DIR')
    if env_dir and os.path.exists(env_dir):
        return env_dir
    if sys.platform == 'win32':
        win_dir = os.path.join(os.environ.get('LOCALAPPDATA', 'C:\\Users\\sayan\\AppData\\Local'), 'slskd', 'downloads')
        if os.path.exists(win_dir):
            return win_dir
    return '/home/sakura/slskd_downloads'

def score_cdrip_directory(folder_path, files, username, peer_info=None):
    """
    Computes CD-Rip Provenance Ranking Matrix score:
    Score = (10,000 * tracks) + 50,000 (if .log) + 30,000 (if .cue) + 20,000 (if Scans)
    Penalizes 24-bit web upscales to favor genuine 16-bit 44.1kHz Red Book CD releases.
    """
    score = 0
    flac_count = 0
    has_log = False
    has_cue = False
    has_scans = False
    is_24bit_indicated = False

    fn_lower = folder_path.lower()
    if any(k in fn_lower for k in ['24bit', '24-bit', '24/96', '24/192', 'vinyl', 'sacd']):
        is_24bit_indicated = True

    for f in files:
        f_name = f.get('filename', '').lower()
        if f_name.endswith('.flac'):
            flac_count += 1
            # Check for 24-bit markers
            if any(k in f_name for k in ['24bit', '24-bit', '24_96', '24_192']):
                is_24bit_indicated = True
        elif f_name.endswith('.log'):
            has_log = True
        elif f_name.endswith('.cue'):
            has_cue = True
        elif any(f_name.endswith(ext) for ext in ['.jpg', '.jpeg', '.png']):
            if any(k in f_name for k in ['front', 'back', 'cd', 'disc', 'tray', 'matrix', 'scan']):
                has_scans = True

    score += flac_count * 10000
    if has_log:
        score += 50000
    if has_cue:
        score += 30000
    if has_scans:
        score += 20000

    # Genuine 16-bit CDDA physical releases are prioritized over 24-bit web masters
    if is_24bit_indicated:
        score -= 25000

    # Bonus for known Bengali audiophile release keywords
    if any(k in fn_lower for k in ['asha audio', 'saregama', 'hmv', 'svf', 'sif', 'cdda', 'eac', 'accurip']):
        score += 15000

    # Peer upload speed & free slots
    if peer_info:
        if peer_info.get('hasFreeUploadSlot'):
            score += 15000
        up_speed = peer_info.get('uploadSpeed', 0)
        score += min(int(up_speed / 1024), 20000)

    return score, {
        "folder": folder_path,
        "username": username,
        "flacCount": flac_count,
        "hasLog": has_log,
        "hasCue": has_cue,
        "hasScans": has_scans,
        "is24BitIndicated": is_24bit_indicated,
        "files": files,
        "score": score
    }

def search_and_acquire_cdrip(artist, title_or_catalogue, output_dir, isrc=None, cover_url=None):
    """
    Main acquisition pipeline for 1:1 CD-Rip.
    """
    log(f"Initiating 1:1 CD-Rip resolution for: Artist='{artist}', Target='{title_or_catalogue}'")
    os.makedirs(output_dir, exist_ok=True)

    # 1. Inspect catalogue number
    cat_meta = parse_catalogue_number(title_or_catalogue) or parse_catalogue_number(artist)
    if cat_meta:
        log(f"💿 Recognized Commercial CD Catalogue Identifier: [{cat_meta['label']}] {cat_meta['normalized']}")

    # Formulate Search Queries
    search_queries = []
    if cat_meta:
        search_queries.append(cat_meta['normalized'])
        # Also stripped query
        search_queries.append(cat_meta['raw'])

    clean_target = clean_search_tokens(title_or_catalogue)
    clean_art = clean_search_tokens(artist)

    if clean_art and clean_target:
        search_queries.append(f"{clean_art} {clean_target}")
    elif clean_target:
        search_queries.append(clean_target)

    # Check SLSKD daemon
    slskd_available = is_slskd_online()
    best_candidate_folder = None

    if slskd_available:
        log(f"Querying Soulseek P2P network via SLSKD API ({SLSKD_API_BASE})...")
        for q in search_queries:
            if not q or len(q) < 3:
                continue
            log(f"Broadcasting P2P release search: \"{q}\"")
            try:
                r = session.post(f"{SLSKD_API_BASE}/searches", json={"searchText": q}, timeout=6)
                if r.status_code in (200, 201):
                    search_id = r.json().get('id')
                    # Poll for responses over 4-6 seconds
                    time.sleep(3)
                    resp_r = session.get(f"{SLSKD_API_BASE}/searches/{search_id}/responses", timeout=6)
                    if resp_r.status_code == 200:
                        responses = resp_r.json() or []
                        log(f"Received P2P responses from {len(responses)} peers.")
                        
                        # Group files by folder per peer
                        for peer_resp in responses:
                            uname = peer_resp.get('username')
                            p_info = {
                                "hasFreeUploadSlot": peer_resp.get('hasFreeUploadSlot', False),
                                "uploadSpeed": peer_resp.get('uploadSpeed', 0),
                                "queueLength": peer_resp.get('queueLength', 0)
                            }
                            files = peer_resp.get('files', [])
                            folders = {}
                            for f in files:
                                fn = f.get('filename', '')
                                folder_name = os.path.dirname(fn.replace('\\', '/'))
                                folders.setdefault(folder_name, []).append(f)

                            for f_path, f_list in folders.items():
                                score, meta = score_cdrip_directory(f_path, f_list, uname, p_info)
                                if meta["flacCount"] > 0:
                                    if best_candidate_folder is None or score > best_candidate_folder["score"]:
                                        best_candidate_folder = meta
                if best_candidate_folder and best_candidate_folder.get("hasLog") and best_candidate_folder.get("hasCue"):
                    log(f"Found pristine CD-Rip candidate: {best_candidate_folder['folder']} (Score: {best_candidate_folder['score']})")
                    break
            except Exception as e:
                log(f"Search query error: {e}")

    # 2. Download from candidate or fallback
    downloaded_files = []
    if best_candidate_folder and best_candidate_folder.get("files"):
        target_peer = best_candidate_folder["username"]
        cand_files = best_candidate_folder["files"]
        log(f"Enqueuing candidate directory from peer @{target_peer}: {len(cand_files)} files (.flac, .cue, .log, scans)...")

        # Enqueue files via SLSKD
        try:
            for f in cand_files:
                f_name = f.get('filename')
                session.post(f"{SLSKD_API_BASE}/transfers/enqueue/{urllib.parse.quote(target_peer)}", json=[{
                    "filename": f_name,
                    "size": f.get('size', 0)
                }], timeout=5)
            log(f"Candidate package enqueued. Monitoring P2P transfer streams...")

            # Wait for transfer or check SLSKD download directory
            slsk_dl_dir = get_slskd_downloads_dir()
            # Copy matching files to output_dir
            peer_dir = os.path.join(slsk_dl_dir, target_peer)
            timeout = 35
            start_t = time.time()
            while time.time() - start_t < timeout:
                time.sleep(2)
                if os.path.exists(peer_dir):
                    copied = 0
                    for root, _, fs in os.walk(peer_dir):
                        for file in fs:
                            src_p = os.path.join(root, file)
                            dest_p = os.path.join(output_dir, file)
                            if not os.path.exists(dest_p) or os.path.getsize(dest_p) < os.path.getsize(src_p):
                                shutil.copy2(src_p, dest_p)
                                copied += 1
                    if copied > 0:
                        log(f"Synced {copied} release files from peer cache.")
                        break
        except Exception as e:
            log(f"Peer transfer handling notice: {e}")

    # 3. Check Telegram Archival Channels if no optical P2P package acquired
    existing_flacs = [f for f in os.listdir(output_dir) if f.endswith('.flac')] if os.path.exists(output_dir) else []
    if not existing_flacs:
        log("🔍 Querying Telegram Lossless Archival Channels & Joined Repositories...")
        try:
            from telegram_cdrip_engine import search_telegram_cdrip, download_telegram_cdrip
            tg_q = f"{clean_art} {clean_target}".strip() if (clean_art and clean_target) else (clean_target or clean_art)
            tg_candidates = search_telegram_cdrip(tg_q, max_results=5)
            if not tg_candidates and clean_target:
                tg_candidates = search_telegram_cdrip(clean_target, max_results=5)

            if tg_candidates:
                best_tg = tg_candidates[0]
                log(f"Found Telegram CD-Rip release: @{best_tg['channel']} - {best_tg['fileName']} ({best_tg['sizeStr']}) [Score: {best_tg['score']}]")
                download_telegram_cdrip(best_tg['channel'], best_tg['messageId'], output_dir)
                existing_flacs = [f for f in os.listdir(output_dir) if f.endswith('.flac')]
                if existing_flacs:
                    log(f"Successfully unpacked {len(existing_flacs)} FLAC tracks from Telegram archive.")
            else:
                log("No matching optical release found in Telegram channels.")
        except Exception as e:
            log(f"Telegram acquisition notice: {e}")

    # 4. Check BitTorrent Lossless Swarms if still unseeded
    existing_flacs = [f for f in os.listdir(output_dir) if f.endswith('.flac')] if os.path.exists(output_dir) else []
    if not existing_flacs:
        log("🔍 Querying Lossless BitTorrent Swarms (Apibay / Trackers)...")
        try:
            from torrent_cdrip_engine import search_torrent_cdrip, download_torrent_cdrip
            bt_q = f"{clean_art} {clean_target}".strip() if (clean_art and clean_target) else (clean_target or clean_art)
            tor_candidates = search_torrent_cdrip(bt_q, max_results=5)
            if not tor_candidates and clean_target:
                tor_candidates = search_torrent_cdrip(clean_target, max_results=5)

            if tor_candidates:
                best_tor = tor_candidates[0]
                log(f"Found BitTorrent CD-Rip swarm: \"{best_tor['name']}\" ({best_tor['sizeStr']}) - 🟢 {best_tor['seeders']} Seeds [Score: {best_tor['score']}]")
                download_torrent_cdrip(best_tor['magnet'], output_dir, timeout_secs=180)
                existing_flacs = [f for f in os.listdir(output_dir) if f.endswith('.flac')]
                if existing_flacs:
                    log(f"Successfully downloaded {len(existing_flacs)} FLAC tracks from BitTorrent swarm.")
            else:
                log("No active lossless torrent swarm found.")
        except Exception as e:
            log(f"BitTorrent acquisition notice: {e}")

    # 5. Fallback to 16-bit CDDA Bitstream (Deezer HiFi / Tidal) if no optical rip was found anywhere
    existing_flacs = [f for f in os.listdir(output_dir) if f.endswith('.flac')] if os.path.exists(output_dir) else []
    if not existing_flacs:
        log("⚠️ No active optical CD-Rip package was found across Soulseek, Telegram, or Torrents.")
        log("⚡ Falling back to 16-bit / 44.1 kHz Lossless CDDA Bitstream (Deezer HiFi CDN / Tidal)...")

        clean_art = clean_art or artist.strip()
        clean_tit = clean_target or title_or_catalogue.strip()
        flac_out_path = os.path.join(output_dir, f"{clean_art} - {clean_tit}.flac".replace('/', '_'))

        # Fallback 1: Deezer HiFi CDN
        fallback_ok = False
        try:
            from deezer_hifi_engine import resolve_and_download_flac
            log("Querying Deezer HiFi 1411 kbps FLAC Bitstream...")
            d_res = resolve_and_download_flac(clean_art, clean_tit, flac_out_path)
            if d_res and os.path.exists(flac_out_path) and os.path.getsize(flac_out_path) > 1024 * 1024:
                fallback_ok = True
                log("Successfully acquired Red Book 16-bit / 44.1 kHz FLAC from Deezer HiFi CDN.")
        except Exception as e:
            log(f"Deezer HiFi fallback notice: {e}")

        # Fallback 2: Tidal Hi-Res Lossless
        if not fallback_ok:
            try:
                from audiophile_flac_engine import resolve_audiophile_flac
                log("Querying Tidal Lossless CDN...")
                t_res = resolve_audiophile_flac(clean_art, clean_tit, flac_out_path)
                if t_res and os.path.exists(flac_out_path):
                    log("Successfully acquired 16-bit Lossless stream from Tidal.")
            except Exception as e:
                log(f"Tidal fallback notice: {e}")
        if not fallback_ok:
            try:
                from tidal_monochrome_engine import download_tidal_flac
                fallback_ok = download_tidal_flac(
                    clean_art, clean_tit, flac_out_path, isrc=isrc, cover_url=cover_url
                )
            except Exception as e:
                log(f"Tidal fallback notice: {e}")

    # 4. Multi-Pass Verification & Manifest Generation
    log("Running multi-pass CD-Rip Provenance Verification...")
    verification_result = inspect_cdrip_directory(output_dir)
    provenance = verification_result.get("provenanceLevel", "UNKNOWN")
    fidelity_score = verification_result.get("fidelityScore", 0)
    summary = verification_result.get("summary", {})

    log(f"============================================================")
    log(f"💿 PROVENANCE CLASSIFICATION: {provenance} (Score: {fidelity_score}/100)")
    log(f"📁 Tracks: {summary.get('flacCount', 0)} | Red Book 16/44.1: {summary.get('allRedBookCompliant', False)}")
    log(f"📜 Rip Log: {summary.get('hasLog', False)} | CUE Sheet: {summary.get('hasCue', False)} | Scans: {summary.get('scanCount', 0)}")
    if verification_result.get("manifestPath"):
        log(f"📝 Audit Manifest generated: {verification_result['manifestPath']}")
    log(f"============================================================")

    # Package full CD-Rip directory into a release zip archive
    try:
        zip_base = output_dir.rstrip('/\\')
        shutil.make_archive(zip_base, 'zip', output_dir)
        log(f"📦 Packaged complete 1:1 CD-Rip archive: {zip_base}.zip")
    except Exception as e:
        log(f"Archive zip notice: {e}")

    return verification_result

def acquire_cdrip_targeted(source, out_dir, tg_channel=None, tg_msg_id=None, torrent_magnet=None):
    """
    Directly acquires a specific candidate from Telegram or BitTorrent swarm.
    """
    os.makedirs(out_dir, exist_ok=True)
    if source == 'telegram' and tg_channel and tg_msg_id:
        log(f"Targeted optical acquisition from Telegram @{tg_channel} (Message {tg_msg_id})...")
        from telegram_cdrip_engine import download_telegram_cdrip
        download_telegram_cdrip(tg_channel, tg_msg_id, out_dir)
    elif source == 'torrent' and torrent_magnet:
        log("Targeted optical acquisition from BitTorrent swarm...")
        from torrent_cdrip_engine import download_torrent_cdrip
        download_torrent_cdrip(torrent_magnet, out_dir)

    # Verification & packaging
    log("Running multi-pass CD-Rip Provenance Verification...")
    verification_result = inspect_cdrip_directory(out_dir)
    provenance = verification_result.get("provenanceLevel", "UNKNOWN")
    fidelity_score = verification_result.get("fidelityScore", 0)
    summary = verification_result.get("summary", {})

    log(f"============================================================")
    log(f"💿 PROVENANCE CLASSIFICATION: {provenance} (Score: {fidelity_score}/100)")
    log(f"📁 Tracks: {summary.get('flacCount', 0)} | Red Book 16/44.1: {summary.get('allRedBookCompliant', False)}")
    log(f"📜 Rip Log: {summary.get('hasLog', False)} | CUE Sheet: {summary.get('hasCue', False)} | Scans: {summary.get('scanCount', 0)}")
    if verification_result.get("manifestPath"):
        log(f"📝 Audit Manifest generated: {verification_result['manifestPath']}")
    log(f"============================================================")

    try:
        zip_base = out_dir.rstrip('/\\')
        shutil.make_archive(zip_base, 'zip', out_dir)
        log(f"📦 Packaged complete 1:1 CD-Rip archive: {zip_base}.zip")
    except Exception as e:
        log(f"Archive zip notice: {e}")

    return verification_result

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python cdrip_engine.py <artist> <title_or_catalogue> [output_dir] [isrc] [cover_url] [--source <telegram|torrent>] ...")
        sys.exit(1)

    art = sys.argv[1]
    tit = sys.argv[2]
    out_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.getcwd(), "cdrip_downloads")
    isrc_val = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'None' else None
    cov_val = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] != 'None' else None

    # Check for targeted source flags
    source = 'auto'
    tg_channel = None
    tg_msg_id = None
    torrent_magnet = None

    for i in range(len(sys.argv)):
        if sys.argv[i] == '--source' and i + 1 < len(sys.argv):
            source = sys.argv[i + 1]
        elif sys.argv[i] == '--tg-channel' and i + 1 < len(sys.argv):
            tg_channel = sys.argv[i + 1]
        elif sys.argv[i] == '--tg-msg-id' and i + 1 < len(sys.argv):
            tg_msg_id = int(sys.argv[i + 1])
        elif sys.argv[i] == '--torrent-magnet' and i + 1 < len(sys.argv):
            torrent_magnet = sys.argv[i + 1]

    if source in ('telegram', 'torrent') and (tg_channel or torrent_magnet):
        res = acquire_cdrip_targeted(source, out_dir, tg_channel=tg_channel, tg_msg_id=tg_msg_id, torrent_magnet=torrent_magnet)
    else:
        res = search_and_acquire_cdrip(art, tit, out_dir, isrc=isrc_val, cover_url=cov_val)

    sys.exit(0 if res.get("success") else 1)
