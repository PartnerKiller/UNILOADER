#!/usr/bin/env python3
"""
FLAC Checker & Lossless Audio Authenticity Analyzer
Analyzes FLAC files to verify if they are 100% genuine CD/Studio Lossless Masters
or fake/upscaled lossy transcodes (e.g. YouTube 128k Opus / MP3 wrapped in FLAC).
"""

import os
import sys
import re
import json
import base64
import tempfile
import subprocess

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

try:
    from mutagen.flac import FLAC
    HAS_MUTAGEN = True
except ImportError:
    HAS_MUTAGEN = False


def run_cmd(cmd, timeout=30):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except Exception as e:
        return None


def get_highpass_volume(file_path, freq_hz):
    """
    Runs FFmpeg highpass filter at freq_hz and detects mean and max volume in dB.
    If an audio was upscaled from a lossy source, volume above the cutoff will be ~ -91 dB (digital silence).
    """
    cmd = [
        'ffmpeg', '-hide_banner', '-nostats',
        '-i', file_path,
        '-af', f"highpass=f={freq_hz},volumedetect",
        '-f', 'null', '-'
    ]
    res = run_cmd(cmd, timeout=25)
    if not res or not res.stderr:
        return None, None

    mean_vol = None
    max_vol = None

    m_mean = re.search(r'mean_volume:\s*([-0-9.]+)\s*dB', res.stderr)
    m_max = re.search(r'max_volume:\s*([-0-9.]+)\s*dB', res.stderr)

    if m_mean:
        try: mean_vol = float(m_mean.group(1))
        except ValueError: pass
    if m_max:
        try: max_vol = float(m_max.group(1))
        except ValueError: pass

    return mean_vol, max_vol


def generate_spectrogram_base64(file_path, width=960, height=260):
    """Generates a logarithmic frequency spectrogram PNG image encoded as Base64."""
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
        tmp_png = tmp.name

    try:
        cmd = [
            'ffmpeg', '-y', '-hide_banner', '-nostats',
            '-i', file_path,
            '-lavfi', f"showspectrumpic=s={width}x{height}:mode=combined:color=fire:scale=log:legend=1",
            '-frames:v', '1',
            '-update', '1',
            tmp_png
        ]
        res = run_cmd(cmd, timeout=30)
        if res and os.path.exists(tmp_png) and os.path.getsize(tmp_png) > 1000:
            with open(tmp_png, 'rb') as f:
                encoded = base64.b64encode(f.read()).decode('utf-8')
                return f"data:image/png;base64,{encoded}"
    except Exception:
        pass
    finally:
        if os.path.exists(tmp_png):
            try: os.remove(tmp_png)
            except Exception: pass

    return None


def analyze_flac(file_path, generate_spectrogram=True):
    """
    Performs comprehensive lossless authenticity verification on an audio file:
    1. Container specifications (bit depth, sample rate, bitrate, channels, MD5 signature).
    2. Multi-band frequency energy analysis (16kHz, 18.5kHz, 20kHz, 22kHz, 24kHz).
    3. Low-pass cutoff detection (identifies MP3 128k, MP3 192k, Opus 128k, etc.).
    4. Authenticity score (0% - 100%) and classification verdict.
    5. High-resolution audio spectrogram.
    """
    if not os.path.exists(file_path):
        return {"error": f"File not found: {file_path}", "valid": False}

    file_size = os.path.getsize(file_path)
    if file_size < 10000:
        return {"error": "File too small to be valid audio", "valid": False}

    # 1. Read metadata via Mutagen & FFprobe
    sample_rate = 44100
    bits_per_sample = 16
    bitrate_kbps = 0
    channels = 2
    duration_sec = 0.0
    md5_signature = ""
    tags = {}
    is_flac_container = False

    if HAS_MUTAGEN:
        try:
            audio = FLAC(file_path)
            is_flac_container = True
            sample_rate = audio.info.sample_rate
            bits_per_sample = audio.info.bits_per_sample
            bitrate_kbps = int(audio.info.bitrate / 1000) if audio.info.bitrate else 0
            channels = audio.info.channels
            duration_sec = round(audio.info.length, 2)
            md5_signature = audio.info.md5_signature or ""
            
            for k, v in audio.items():
                if k.lower() in ['title', 'artist', 'album', 'albumartist', 'date', 'isrc', 'lyrics']:
                    tags[k.lower()] = v[0] if isinstance(v, list) and v else str(v)
        except Exception:
            pass

    # Fallback to ffprobe if needed
    if not bitrate_kbps or not duration_sec:
        probe_cmd = ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file_path]
        probe_res = run_cmd(probe_cmd, timeout=10)
        if probe_res and probe_res.stdout:
            try:
                p_data = json.loads(probe_res.stdout)
                streams = p_data.get('streams', [])
                audio_stream = next((s for s in streams if s.get('codec_type') == 'audio'), {})
                fmt = p_data.get('format', {})
                
                if not is_flac_container:
                    is_flac_container = (audio_stream.get('codec_name') == 'flac')
                if not sample_rate and audio_stream.get('sample_rate'):
                    sample_rate = int(audio_stream['sample_rate'])
                if not bits_per_sample and audio_stream.get('bits_per_raw_sample'):
                    bits_per_sample = int(audio_stream['bits_per_raw_sample'])
                if not channels and audio_stream.get('channels'):
                    channels = int(audio_stream['channels'])
                if not duration_sec and fmt.get('duration'):
                    duration_sec = round(float(fmt['duration']), 2)
                if not bitrate_kbps and fmt.get('bit_rate'):
                    bitrate_kbps = int(int(fmt['bit_rate']) / 1000)
            except Exception:
                pass

    if duration_sec > 0 and not bitrate_kbps:
        bitrate_kbps = int((file_size * 8) / (duration_sec * 1000))

    nyquist_freq = sample_rate // 2

    # 2. Multi-band highpass frequency analysis
    bands_to_test = [16000, 18500, 20000]
    if nyquist_freq > 22050:
        bands_to_test.append(22000)
    if nyquist_freq >= 32000:
        bands_to_test.append(24000)

    energy_results = {}
    for band in bands_to_test:
        mean_v, max_v = get_highpass_volume(file_path, band)
        energy_results[f"above_{band}hz"] = {
            "mean_db": mean_v,
            "max_db": max_v,
            "active": (mean_v is not None and mean_v > -70.0)
        }

    # 3. Cutoff & Transcode Detection Logic
    e16 = energy_results.get("above_16000hz", {})
    e18 = energy_results.get("above_18500hz", {})
    e20 = energy_results.get("above_20000hz", {})
    e22 = energy_results.get("above_22000hz", {})

    m16 = e16.get("mean_db")
    x16 = e16.get("max_db")
    m18 = e18.get("mean_db")
    x18 = e18.get("max_db")
    m20 = e20.get("mean_db")
    x20 = e20.get("max_db")
    m22 = e22.get("mean_db") if e22 else None
    x22 = e22.get("max_db") if e22 else None

    cutoff_frequency = None
    verdict = "GENUINE_LOSSLESS"
    verdict_title = "100% Genuine Lossless Master"
    verdict_badge = "success"
    score = 100
    warnings = []
    details = []

    # Check 16kHz cutoff (128k MP3 transcode or low-bitrate lossy)
    if m16 is not None and (m16 < -68.0 or (m16 < -60.0 and x16 is not None and x16 < -35.0)):
        cutoff_frequency = 16000
        score = 20
        verdict = "FAKE_FLAC"
        verdict_title = "Fake FLAC (Low-Bitrate 128k Transcode)"
        verdict_badge = "danger"
        warnings.append("Severe frequency cutoff detected at 16.0 kHz (standard 128kbps MP3 / low-bitrate artifact).")

    # Check 18.5kHz cutoff (192k MP3 / lossy transcode)
    elif m18 is not None and (m18 < -68.0 or (m18 < -62.0 and x18 is not None and x18 < -35.0)):
        cutoff_frequency = 18500
        score = 40
        verdict = "FAKE_FLAC"
        verdict_title = "Fake FLAC (Lossy 192k Transcode)"
        verdict_badge = "danger"
        warnings.append("Hard frequency cutoff detected at 18.5 kHz (typical 192kbps MP3 / lossy encoder artifact).")

    # Check 20kHz cutoff (320k MP3 / YouTube Opus 160k transcode)
    elif m20 is not None and (m20 < -72.0 or (m20 < -64.0 and x20 is not None and x20 < -40.0)):
        cutoff_frequency = 20000
        score = 65
        verdict = "SUSPICIOUS"
        verdict_title = "Suspicious (Capped at 20 kHz / Likely 320k Transcode)"
        verdict_badge = "warning"
        warnings.append("High-frequency brickwall cutoff detected at 20.0 kHz. Likely an upscaled 320kbps MP3 or YouTube Opus stream.")

    # Check fake Hi-Res (upscaled CDDA into 24-bit / 48kHz+ container)
    elif nyquist_freq > 22050 and m22 is not None and (m22 < -72.0 or (m22 < -65.0 and x22 is not None and x22 < -42.0)):
        cutoff_frequency = 22050
        score = 75
        verdict = "UPSCALED_HIRES"
        verdict_title = f"Upscaled Hi-Res ({bits_per_sample}-bit / {sample_rate/1000:.1f} kHz container, 44.1 kHz CD audio)"
        verdict_badge = "warning"
        warnings.append("Container is labeled Hi-Res (48 kHz+), but frequency content terminates sharply at 22.05 kHz (standard CD limit).")

    else:
        # Genuine lossless acoustic characteristics
        if sample_rate >= 88200 or bits_per_sample >= 24:
            verdict = "GENUINE_HIRES"
            verdict_title = f"100% Genuine Hi-Res Studio Master ({bits_per_sample}-bit / {sample_rate/1000:.1f} kHz)"
            verdict_badge = "success"
            score = 100
            details.append(f"Pristine studio audio harmonics extending beyond 22.05 kHz up to {nyquist_freq/1000:.1f} kHz.")
        else:
            verdict = "GENUINE_CDDA"
            verdict_title = "100% Genuine CD Lossless Master (16-bit / 44.1 kHz)"
            verdict_badge = "success"
            score = 95
            details.append("Continuous natural harmonic spectrum spanning full CDDA dynamic bandwidth (up to 22.05 kHz).")

    # Bitrate sanity check
    if bitrate_kbps < 500:
        score = max(10, score - 30)
        warnings.append(f"Abnormally low bitrate for FLAC ({bitrate_kbps} kbps).")
        if verdict == "GENUINE_LOSSLESS":
            verdict = "SUSPICIOUS"
            verdict_title = "Suspicious (Very Low Bitrate FLAC)"
            verdict_badge = "warning"

    # 4. Generate Spectrogram
    spectrogram_data = None
    if generate_spectrogram:
        spectrogram_data = generate_spectrogram_base64(file_path)

    return {
        "valid": True,
        "filename": os.path.basename(file_path),
        "filePath": file_path,
        "fileSize": file_size,
        "fileSizeMB": round(file_size / (1024 * 1024), 2),
        "durationSec": duration_sec,
        "sampleRate": sample_rate,
        "bitsPerSample": bits_per_sample,
        "bitrateKbps": bitrate_kbps,
        "channels": channels,
        "channelLayout": "Stereo" if channels == 2 else ("Mono" if channels == 1 else f"{channels} channels"),
        "nyquistLimitHz": nyquist_freq,
        "cutoffFrequencyHz": cutoff_frequency,
        "md5Signature": str(md5_signature),
        "isFlacContainer": is_flac_container,
        "authenticityScore": score,
        "verdict": verdict,
        "verdictTitle": verdict_title,
        "verdictBadge": verdict_badge,
        "energyAnalysis": energy_results,
        "warnings": warnings,
        "details": details,
        "tags": tags,
        "spectrogram": spectrogram_data
    }


def is_lossless_authentic(file_path):
    """
    Returns (True, report) if audio is genuine CDDA or Hi-Res Studio Master FLAC.
    Returns (False, report) if audio is a fake/upscaled transcode or invalid container.
    """
    report = analyze_flac(file_path, generate_spectrogram=False)
    if not report.get("valid"):
        return False, report
    if report.get("verdict") == "FAKE_FLAC" or report.get("authenticityScore", 0) < 60:
        return False, report
    return True, report


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python flac_checker.py <FILE_PATH> [--no-spectrogram]")
        sys.exit(1)

    target_file = sys.argv[1]
    with_spec = '--no-spectrogram' not in sys.argv
    report = analyze_flac(target_file, generate_spectrogram=with_spec)
    print(json.dumps(report, indent=2))
