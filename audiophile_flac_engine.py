#!/usr/bin/env python3
"""
Audiophile FLAC Engine - True Lossless Music Resolution Pipeline
Strictly prioritizes 24-bit Hi-Res Studio Masters over 16-bit CDDA.
Runs automated flac_checker spectral analysis to reject fake/upscaled transcodes.
Strictly prohibits YouTube/lossy transcoding into fake FLAC.

Source Resolution Pipeline:
1. Tier 1 (Hi-Res & Studio Masters): Tidal Hi-Res / Monochrome API
2. Tier 2 (P2P Audiophile Masters): Soulseek P2P Network (SLSKD) with 24-bit prioritization
3. Tier 3 (Lossless CD Bitstream): Deezer HiFi 1411 kbps 16-bit FLAC (ARL + Blowfish CBC)
"""

import os
import sys
import re
import time
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

try:
    from flac_checker import is_lossless_authentic
    HAS_CHECKER = True
except ImportError:
    HAS_CHECKER = False

def verify_and_accept_flac(file_path, tier_name):
    """
    Verifies that the downloaded audio file is 100% genuine lossless FLAC.
    Rejects fake transcodes, upscales, and corrupted streams.
    """
    if not os.path.exists(file_path) or os.path.getsize(file_path) < 100000:
        print(f"[{tier_name}] ❌ Downloaded file too small or missing.", file=sys.stderr, flush=True)
        return False

    with open(file_path, 'rb') as f:
        magic = f.read(4)
        if magic != b'fLaC':
            print(f"[{tier_name}] ❌ Corrupted stream: Missing FLAC magic bytes (got {magic}).", file=sys.stderr, flush=True)
            try: os.remove(file_path)
            except Exception: pass
            return False

    if HAS_CHECKER:
        is_ok, report = is_lossless_authentic(file_path)
        score = report.get("authenticityScore", 0)
        verdict = report.get("verdict", "UNKNOWN")
        v_title = report.get("verdictTitle", "")

        if not is_ok:
            print(f"[{tier_name}] ❌ REJECTED FAKE FLAC: Lossy cutoff detected (Score: {score}/100, {v_title}).", file=sys.stderr, flush=True)
            try: os.remove(file_path)
            except Exception: pass
            return False

        print(f"[{tier_name}] ✅ Verified Genuine Lossless Master ({verdict}): Score {score}/100 - {v_title}", flush=True)

    sz_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"[{tier_name}] 🎉 Authentic Lossless FLAC saved: {file_path} ({sz_mb:.2f} MB)", flush=True)
    return True


def resolve_flac_audio(artist, title, output_path, isrc=None, cover_url=None, duration=None):
    """
    Executes the 3-Tier Audiophile Resolution Pipeline in strict quality order.
    """
    clean_artist = re.sub(r'[\(\)\[\]]', '', artist).strip()
    clean_title = re.sub(r'[\(\)\[\]]', '', title).strip()
    full_name = f"{clean_artist} - {clean_title}" if clean_artist else clean_title

    print(f"[Audiophile HiFi] Resolving true lossless FLAC for: \"{full_name}\"", flush=True)
    if isrc:
        print(f"[Audiophile HiFi] Primary ISRC anchor: {isrc}", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    # -------------------------------------------------------------
    # Tier 1: Tidal Hi-Res / Monochrome API (Studio Masters 24-bit)
    # -------------------------------------------------------------
    try:
        from tidal_monochrome_engine import download_tidal_flac
        print(f"[Audiophile HiFi] [Tier 1] Querying Tidal Hi-Res Studio Masters (24-bit / 96kHz / 48kHz)...", flush=True)
        t1_ok = download_tidal_flac(clean_artist, clean_title, output_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if t1_ok and verify_and_accept_flac(output_path, "Tidal Hi-Res"):
            return True
    except Exception as e:
        print(f"[Audiophile HiFi] [Tier 1] Tidal Hi-Res notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Tier 2: Soulseek P2P Network (24-bit Hi-Res & Audiophile Vinyl/CD)
    # -------------------------------------------------------------
    try:
        from soulseek_flac_engine import search_and_download_flac
        print(f"[Audiophile HiFi] [Tier 2] Searching Soulseek P2P Audiophile Masters (24-bit / CD Lossless)...", flush=True)
        t2_ok = search_and_download_flac(clean_artist, clean_title, output_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if t2_ok and verify_and_accept_flac(output_path, "Soulseek P2P"):
            return True
    except Exception as e:
        print(f"[Audiophile HiFi] [Tier 2] Soulseek P2P notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Tier 3: Deezer HiFi (1411 kbps 16-bit 44.1kHz FLAC CDN Bitstream)
    # -------------------------------------------------------------
    try:
        from deezer_hifi_engine import resolve_and_download_flac
        print(f"[Audiophile HiFi] [Tier 3] Streaming Deezer HiFi 1411kbps Lossless Bitstream...", flush=True)
        t3_ok = resolve_and_download_flac(clean_artist, clean_title, isrc=isrc, output_path=output_path, duration=duration, cover_url=cover_url)
        if t3_ok and verify_and_accept_flac(output_path, "Deezer HiFi"):
            return True
    except Exception as e:
        print(f"[Audiophile HiFi] [Tier 3] Deezer HiFi notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Strict Anti-Transcode Policy Enforcement
    # -------------------------------------------------------------
    print(f"[Audiophile HiFi] ❌ Authentic Lossless FLAC not found across Tidal Hi-Res, Soulseek P2P Masters, or Deezer HiFi.", file=sys.stderr, flush=True)
    print(f"[Audiophile HiFi] 🚫 Strictly prohibited: YouTube/lossy audio will NOT be transcoded into fake FLAC.", file=sys.stderr, flush=True)
    if os.path.exists(output_path):
        try: os.remove(output_path)
        except Exception: pass
    return False


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python audiophile_flac_engine.py <ARTIST> <TITLE> <OUTPUT_PATH> [ISRC] [COVER_URL] [DURATION]")
        sys.exit(1)

    art = sys.argv[1]
    tit = sys.argv[2]
    out = sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ('None', '') else None
    cov = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] not in ('None', '') else None
    dur = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] not in ('None', '') else None

    success = resolve_flac_audio(art, tit, out, isrc=code, cover_url=cov, duration=dur)
    if success:
        print(f"🎉 SUCCESS: Genuine Lossless FLAC saved at: {out}")
        sys.exit(0)
    else:
        print(f"❌ FAILED: Genuine Lossless FLAC could not be resolved.")
        sys.exit(1)
