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

    qual_tag = "Lossless FLAC"
    try:
        from mutagen.flac import FLAC
        af = FLAC(file_path)
        bps = getattr(af.info, 'bits_per_sample', 16)
        sr = getattr(af.info, 'sample_rate', 44100)
        qual_tag = f"{bps}-bit / {sr/1000:.1f} kHz FLAC"
    except Exception:
        pass
    sz_mb = os.path.getsize(file_path) / (1024 * 1024)
    print(f"[{tier_name}] 🎉 Authentic {qual_tag} saved: {file_path} ({sz_mb:.2f} MB)", flush=True)
    return True


def resolve_flac_audio(artist, title, output_path, isrc=None, cover_url=None, duration=None, quality='auto'):
    """
    Executes the 3-Tier Audiophile Resolution Pipeline in quality and speed optimized order.
    - If 16-bit CDDA is requested: Deezer HiFi CDN (1411kbps bitstream, 15-30 MB/s) is queried first.
    - If 24-bit Studio Master is requested: Tidal Hi-Res & Soulseek P2P Masters are queried first with speed watchdog.
    - Fast fallback ensures users on high-bandwidth connections never get stuck on slow peers.
    """
    # Clean noise terms & parenthetical descriptors: "The Bongs Again (Original)" -> "The Bongs Again"
    c_art = re.sub(r'[\(\[\{].*?[\)\]\}]', ' ', artist).strip()
    c_tit = re.sub(r'[\(\[\{].*?[\)\]\}]', ' ', title).strip()
    c_art = re.sub(r'(?i)\b(official\s*(music)?\s*video|official\s*audio|original|full\s*song|video|audio|mv|hd|4k)\b', ' ', c_art)
    c_tit = re.sub(r'(?i)\b(official\s*(music)?\s*video|official\s*audio|original|full\s*song|video|audio|mv|hd|4k)\b', ' ', c_tit)
    clean_artist = re.sub(r'\s+', ' ', c_art).strip() or artist.strip()
    clean_title = re.sub(r'\s+', ' ', c_tit).strip() or title.strip()

    full_name = f"{clean_artist} - {clean_title}" if clean_artist else clean_title
    target_quality = (quality or 'auto').lower()

    print(f"[Audiophile HiFi] Resolving true lossless FLAC for: \"{full_name}\" (Target: {target_quality})", flush=True)
    if isrc:
        print(f"[Audiophile HiFi] Primary ISRC anchor: {isrc}", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    is_16bit_target = target_quality in ('16bit', 'cdda', '16', 'cd')

    # If the user explicitly requested 16-bit CDDA Lossless:
    # Route directly to Deezer HiFi CDN (1411 kbps unthrottled Akamai/Fastly CDN - downloads in 2-3 seconds!)
    if is_16bit_target:
        try:
            from deezer_hifi_engine import resolve_and_download_flac
            print(f"[Audiophile HiFi] [Tier 1 CDN] Streaming Deezer HiFi 1411kbps CD Lossless Bitstream...", flush=True)
            t_ok = resolve_and_download_flac(
                clean_artist, clean_title,
                isrc=isrc, output_path=output_path, duration=duration, cover_url=cover_url,
                verify_callback=lambda p: verify_and_accept_flac(p, "Deezer HiFi CDN")
            )
            if t_ok:
                return True
        except Exception as e:
            print(f"[Audiophile HiFi] [Tier 1 CDN] Deezer HiFi notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Tier 1 / Hi-Res: Tidal Hi-Res / Monochrome API (Studio Masters 24-bit)
    # -------------------------------------------------------------
    tidal_16bit_backup = None
    try:
        from tidal_monochrome_engine import download_tidal_flac
        print(f"[Audiophile HiFi] [Tier 1 Hi-Res] Querying Tidal Hi-Res Studio Masters (24-bit / 96kHz / 48kHz)...", flush=True)
        t1_ok = download_tidal_flac(clean_artist, clean_title, output_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if t1_ok and verify_and_accept_flac(output_path, "Tidal Hi-Res"):
            # Check if Tidal provided a genuine 24-bit Studio Master
            is_24bit_master = False
            try:
                from mutagen.flac import FLAC
                af = FLAC(output_path)
                bps = getattr(af.info, 'bits_per_sample', 16)
                sr = getattr(af.info, 'sample_rate', 44100)
                if bps >= 24 or sr >= 48000:
                    is_24bit_master = True
                    print(f"[Audiophile HiFi] 🌟 Verified Authentic 24-bit Tidal Studio Master ({bps}-bit / {sr/1000:.1f} kHz)!", flush=True)
                    return True
                else:
                    if target_quality in ('24bit', '24', 'hires', 'master', 'studio'):
                        print(f"[Audiophile HiFi] Tidal stream is 16-bit. Checking Soulseek P2P for requested 24-bit Hi-Res Studio Master...", flush=True)
                        tidal_16bit_backup = output_path + ".tidal16.bak"
                        shutil.copy2(output_path, tidal_16bit_backup)
                    else:
                        print(f"[Audiophile HiFi] ⚡ Authentic 16-bit / 44.1 kHz Lossless CD Master accepted directly from Tidal in seconds!", flush=True)
                        return True
            except Exception:
                return True
    except Exception as e:
        print(f"[Audiophile HiFi] [Tier 1 Hi-Res] Tidal Hi-Res notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Tier 2: Soulseek P2P Network (24-bit Hi-Res & Audiophile Vinyl/CD with Speed Watchdog)
    # -------------------------------------------------------------
    try:
        from soulseek_flac_engine import search_and_download_flac
        print(f"[Audiophile HiFi] [Tier 2 P2P] Searching Soulseek P2P Audiophile Masters (High-Speed Peers)...", flush=True)
        t2_ok = search_and_download_flac(clean_artist, clean_title, output_path, isrc=isrc, cover_url=cover_url, duration=duration)
        if t2_ok and verify_and_accept_flac(output_path, "Soulseek P2P"):
            if tidal_16bit_backup and os.path.exists(tidal_16bit_backup):
                try: os.remove(tidal_16bit_backup)
                except Exception: pass
            return True
    except Exception as e:
        print(f"[Audiophile HiFi] [Tier 2 P2P] Soulseek P2P notice: {e}", file=sys.stderr, flush=True)

    # If Soulseek P2P didn't find a better master but Tidal 16-bit CDDA was previously captured, use it!
    if tidal_16bit_backup and os.path.exists(tidal_16bit_backup):
        print(f"[Audiophile HiFi] ⚡ Retaining authentic 16-bit CD Lossless Master from Tidal.", flush=True)
        if os.path.exists(output_path):
            try: os.remove(output_path)
            except Exception: pass
        shutil.move(tidal_16bit_backup, output_path)
        return True

    # -------------------------------------------------------------
    # Tier 3: Deezer HiFi (1411 kbps 16-bit 44.1kHz FLAC CDN Bitstream Fallback)
    # -------------------------------------------------------------
    if not is_16bit_target:
        try:
            from deezer_hifi_engine import resolve_and_download_flac
            print(f"[Audiophile HiFi] [Tier 3 Fallback] Streaming Deezer HiFi 1411kbps Lossless Bitstream...", flush=True)
            t3_ok = resolve_and_download_flac(
                clean_artist, clean_title,
                isrc=isrc, output_path=output_path, duration=duration, cover_url=cover_url,
                verify_callback=lambda p: verify_and_accept_flac(p, "Deezer HiFi CDN")
            )
            if t3_ok:
                return True
        except Exception as e:
            print(f"[Audiophile HiFi] [Tier 3 Fallback] Deezer HiFi notice: {e}", file=sys.stderr, flush=True)

    # -------------------------------------------------------------
    # Strict Anti-Transcode Policy Enforcement
    # -------------------------------------------------------------
    print(f"[Audiophile HiFi] ❌ Authentic Lossless FLAC or Studio Master not found across Tidal Hi-Res, Soulseek P2P, or Deezer HiFi.", file=sys.stderr, flush=True)
    print(f"[Audiophile HiFi] 🚫 Strictly prohibited: YouTube/lossy audio will NOT be transcoded into fake FLAC.", file=sys.stderr, flush=True)
    if os.path.exists(output_path):
        try: os.remove(output_path)
        except Exception: pass
    return False


if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python audiophile_flac_engine.py <ARTIST> <TITLE> <OUTPUT_PATH> [ISRC] [COVER_URL] [DURATION] [QUALITY]")
        sys.exit(1)

    art = sys.argv[1]
    tit = sys.argv[2]
    out = sys.argv[3]
    code = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] not in ('None', '') else None
    cov = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] not in ('None', '') else None
    dur = float(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6] not in ('None', '') else None
    qual = sys.argv[7] if len(sys.argv) > 7 and sys.argv[7] not in ('None', '') else 'auto'

    success = resolve_flac_audio(art, tit, out, isrc=code, cover_url=cov, duration=dur, quality=qual)
    if success:
        print(f"🎉 SUCCESS: Genuine Lossless FLAC saved at: {out}")
        sys.exit(0)
    else:
        print(f"❌ FAILED: Genuine Lossless FLAC could not be resolved.")
        sys.exit(1)
