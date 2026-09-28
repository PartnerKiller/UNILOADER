# Comprehensive Technical Report: Universal-Downloader Inbuilt FLAC Checker & Lossless Authenticity Engine

**Author / Engineering**: SAKURA & Antigravity  
**System Component**: `flac_checker.py` & Audiophile Resolution Pipeline  
**Version**: Universal Downloader v4.17.3  
**Classification**: Technical Architecture & DSP Specification  
**Downloadable File**: `FLAC_CHECKER_REPORT.md`  

---

## 1. Executive Summary & Purpose

The **Universal Downloader Inbuilt FLAC Checker** is a high-precision digital signal processing (DSP) and spectral analysis engine. Its primary purpose is to **definitively distinguish between 100% genuine lossless Studio/CD masters and counterfeit/upscaled lossy transcodes** (such as MP3 or YouTube Opus encapsulated inside a `.flac` container).

In contemporary digital media distribution, thousands of audio files shared across P2P networks (Soulseek, torrent swarms) or downloaded from conversion websites are "fake FLACs"—lossy files (128 kbps MP3, 160 kbps Opus, 256 kbps AAC) re-encoded into uncompressed FLAC. While an operating system or media player will report these files as `FLAC 16-bit / 44.1 kHz, 1000+ kbps`, the audio data above 16 kHz or 20 kHz is permanently lost, replaced by digital silence.

The FLAC Checker was engineered to enforce **Audio Quality Rule #1**:
> **Strict Lossless Guarantee**: Prioritize genuine 24-bit Hi-Res Studio Masters and 16-bit CD Lossless bitstreams. Strictly prohibit fake/lossy transcodes: YouTube transcoding to FLAC is completely disabled, and all incoming audio candidates undergo spectral cutoff verification before being served or saved.

---

## 2. Core Programs, Libraries & Tools Used

The FLAC Checker is implemented in Python 3 (`flac_checker.py`), integrated with a Node.js Express backend (`server.js`), and orchestrated within the 3-Tier Audiophile Pipeline (`audiophile_flac_engine.py`).

| Tool / Library | Role & Technical Responsibility |
| :--- | :--- |
| **FFmpeg** | High-performance audio DSP engine. Executes multi-band Fast Fourier Transform (FFT) brickwall filtering (`firequalizer`), mean/peak decibel level measurement (`volumedetect`), high-pass fallback filtering (`highpass`), and logarithmic visual spectrogram generation (`showspectrumpic`). |
| **FFprobe** | Multimedia container analysis tool. Probes stream metadata, channel count, bits per raw sample, exact audio duration, uncompressed stream bitrate, and container codec flags in JSON format. |
| **Mutagen (`mutagen.flac.FLAC`)** | Low-level Python audio metadata parser. Reads native FLAC metadata blocks, sample rates, bit depths, Vorbis comment tags (Title, Artist, Album, Date, ISRC, Lyrics), and extracts the embedded 128-bit MD5 signature of uncompressed audio stream data. |
| **Python 3 (`flac_checker.py`)** | Core algorithmic engine. Calculates Nyquist frequency limits, coordinates FFmpeg subprocess pipelines, parses volume detect metrics, executes transcode pattern classification, calculates authenticity scores (0–100%), and generates JSON reports. |
| **Node.js / Express (`server.js`)** | Web application layer. Exposes REST API endpoints (`/api/flac-check`, `/api/flac-check/recent`, `/api/flac-check/clear-recent`), manages file uploads via Base64/multipart, enforces RBAC feature permissions, and spawns the Python worker process. |
| **Web Frontend (`app.js` & `index.html`)** | User interface layer. Implements drag-and-drop file inspection, dynamic decibel energy bars, high-resolution Base64 spectrogram rendering, Vorbis comment inspection, and one-click verification from the active download queue. |

---

## 3. How the Analysis Works (Step-by-Step DSP Pipeline)

When an audio file is submitted for analysis—either manually through the web UI or automatically during a high-speed download—the pipeline executes five sequential verification phases:

```
[ Input Audio (.flac/.wav) ]
            │
            ▼
┌───────────────────────────────────────────────┐
│ 1. Container & Bitstream Integrity Check     │
│    • Validate magic bytes: 'fLaC'             │
│    • Extract Bit Depth, Sample Rate, MD5      │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ 2. Nyquist Boundary Calculation               │
│    • Nyquist Limit = Sample Rate / 2          │
│    • 44.1 kHz -> 22.05 kHz | 96 kHz -> 48 kHz │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ 3. Multi-Band FFT Brickwall Isolation         │
│    • FFmpeg 'firequalizer' at 16k, 18.5k,     │
│      20k, 22k, 24k Hz                         │
│    • FFmpeg 'volumedetect' (Mean & Max dB)    │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ 4. Cutoff Frequency & Pattern Classification  │
│    • Digital Silence floor: <= -89.0 dB       │
│    • Identify MP3 128k, 192k, 320k, Opus 160k │
│    • Identify 44.1k CDDA in 48k+ container    │
│    • Compute Authenticity Score (0 - 100%)    │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│ 5. Logarithmic Spectrogram Generation         │
│    • FFmpeg 'showspectrumpic' (mode=combined) │
│    • Export Base64 PNG visualization          │
└───────────────────────────────────────────────┘
```

---

### Step 1: Container & Bitstream Integrity Verification
1. **Magic Bytes Validation**: Inspects the first 4 bytes of the binary stream. Valid FLAC files must begin with `0x66 0x4C 0x61 0x43` (`fLaC`). Corrupted or raw renamed lossy files are instantly caught.
2. **Metadata Extraction via Mutagen**: Reads the `STREAMINFO` block:
   - Sample Rate ($f_s$, e.g., 44,100 Hz, 48,000 Hz, 96,000 Hz, 192,000 Hz).
   - Bits per Sample ($b$, e.g., 16-bit, 24-bit, 32-bit).
   - Number of Channels (Mono / Stereo / 5.1 Surround).
   - Audio Duration ($T$ in seconds).
   - MD5 Audio Signature: A 128-bit hash computed solely over the raw uncompressed audio samples.
3. **FFprobe Fallback**: If Mutagen encounters non-standard container wrappers or raw PCM WAV files, FFprobe probes the file via JSON stream extraction.

---

### Step 2: Nyquist-Shannon Boundary Calculation
According to the Nyquist-Shannon sampling theorem, a discrete digital audio signal can only represent frequencies up to half of its sampling frequency:

$$f_{\text{Nyquist}} = \frac{f_s}{2}$$

- **Standard CDDA (44.1 kHz)**: Upper frequency limit is **22.05 kHz**.
- **Broadcast / Film Standard (48.0 kHz)**: Upper frequency limit is **24.0 kHz**.
- **Hi-Res Studio Master (96.0 kHz)**: Upper frequency limit is **48.0 kHz**.
- **Extreme Audiophile Studio (192.0 kHz)**: Upper frequency limit is **96.0 kHz**.

Any frequency energy claimed beyond $f_{\text{Nyquist}}$ is mathematical aliasing noise. Conversely, the absence of acoustic energy well below $f_{\text{Nyquist}}$ indicates a low-pass filter artifact typical of lossy compression.

---

### Step 3: Multi-Band FFT Brickwall Isolation & Volume Detection
This is the core scientific innovation of the FLAC Checker. Instead of relying on metadata tags (which can be easily faked), the engine measures the **actual acoustic power** in the extreme upper spectrum.

The analyzer isolates high-frequency bands using an FFmpeg **Finite Impulse Response (FIR) Fast Fourier Transform equalizer (`firequalizer`)** configured with a brickwall cutoff:

```bash
ffmpeg -hide_banner -nostats -i "input.flac" \
  -af "firequalizer=gain_entry='entry(0,-120);entry(15999,-120);entry(16000,0);entry(22050,0)',volumedetect" \
  -f null -
```

#### Why `firequalizer`?
Traditional IIR high-pass filters (`highpass=f=20000`) have a gentle slope (e.g., 12 dB/octave or 24 dB/octave). That means loud frequencies below 20 kHz "leak" through the filter, contaminating the volume measurement.  
In contrast, `firequalizer` applies a **-120 dB brickwall attenuation** immediately below the target frequency ($f - 1\text{ Hz}$), leaving only genuine ultrasonic energy above the threshold.

#### Frequency Bands Evaluated:
1. **Above 16.0 kHz**: Evaluates presence of frequencies above standard 128 kbps MP3 cutoffs.
2. **Above 18.5 kHz**: Evaluates presence of frequencies above typical 192 kbps MP3 / 128 kbps AAC cutoffs.
3. **Above 20.0 kHz**: Evaluates presence of frequencies above 320 kbps MP3 and YouTube Opus (160 kbps) cutoffs.
4. **Above 22.0 kHz**: Evaluates ultrasonic content beyond the standard CDDA boundary ($f > 22.05\text{ kHz}$) for Hi-Res candidate streams.
5. **Above 24.0 kHz**: Evaluates extended studio acoustic harmonics on 96 kHz+ files.

The output is processed by FFmpeg's `volumedetect` filter, which outputs exact root-mean-square (RMS) `mean_volume` and peak `max_volume` in decibels relative to full scale (dBFS).

---

### Step 4: Cutoff Frequency & Transcode Identification Logic

When lossy encoders compress audio, they discard high frequencies using a steep psychoacoustic low-pass filter:
- **128 kbps MP3**: Brickwall cutoff at **16.0 kHz**.
- **192 kbps MP3**: Brickwall cutoff at **18.5 kHz – 19.0 kHz**.
- **320 kbps MP3 & YouTube Opus**: Hard cutoff at **20.0 kHz – 20.5 kHz**.
- **True Lossless CDDA**: Natural harmonic roll-off extending smoothly up to **22.05 kHz**.
- **True Lossless 24-bit Hi-Res**: Active acoustic harmonics extending past **22.05 kHz** up to **48.0 kHz** or higher.

#### Decibel Energy Thresholds:
- **Digital Silence Floor**: When a lossy encoder cuts off audio, the volume above that cutoff drops to the digital dithering noise floor: $\le -89.0\text{ dBFS}$ to $-91.0\text{ dBFS}$.
- **Active Lossless Audio**: Genuine acoustic recordings (even vintage analog tape from the 1950s) maintain continuous high-frequency energy between $-50.0\text{ dBFS}$ and $-78.0\text{ dBFS}$.

```
Typical Mean Volume Above Frequency:

dBFS
 0 ┼──────────────────────────────────────────────────────────
   │
-20│
   │
-40│               ● Genuine 24-bit Studio Master (-45 dB)
   │               │
-60│               ● Genuine 16-bit CD Lossless (-68 dB)
   │               │
-80│═══════════════╪══════════════════════════════════════════ Cutoff Threshold (-80 dB)
   │               │
-90│───────────────▼── Digital Silence (-91.2 dB) ── Fake FLAC / Transcode
   └───────────────┬──────────────────────────────────────────
                 20 kHz
```

#### Decision Matrix & Classification Verdicts:

| Condition Detected | Authenticity Score | Verdict Code | Verdict Title & Clinical Diagnosis |
| :--- | :---: | :--- | :--- |
| Energy above 16.0 kHz is $\le -89\text{ dB}$ (or $<-86\text{ dB}$ and peak $<-55\text{ dB}$) | **20%** | `FAKE_FLAC` | **Fake FLAC (Low-Bitrate 128k Transcode)**<br>Severe cutoff detected at 16.0 kHz. Source was a 128 kbps MP3 or low-quality stream re-encoded to FLAC. |
| Energy above 18.5 kHz is $\le -89\text{ dB}$ (or $<-86\text{ dB}$ and peak $<-60\text{ dB}$) | **40%** | `FAKE_FLAC` | **Fake FLAC (Lossy 192k Transcode)**<br>Hard cutoff detected at 18.5 kHz. Source was a 192 kbps MP3 or 128 kbps AAC encoder output. |
| Energy above 20.0 kHz is $\le -89\text{ dB}$ (or $<-88\text{ dB}$ and peak $<-70\text{ dB}$) | **65%** | `SUSPICIOUS` | **Suspicious (Capped at 20 kHz / Likely 320k Transcode)**<br>Frequency cliff at 20.0 kHz. Typical artifact of 320 kbps LAME MP3 or YouTube 160 kbps Opus stream. |
| Sample rate $\ge 48\text{ kHz}$, but energy above 22.05 kHz drops to $\le -89\text{ dB}$ | **75%** | `UPSCALED_HIRES` | **Upscaled Hi-Res (24-bit container, 44.1 kHz CD audio)**<br>Container is 48 kHz/96 kHz, but content terminates sharply at 22.05 kHz (standard CD limit). Typical of official anime/film soundtrack CD masters resampled to 48 kHz for video sync. PCM is genuine, but ultrasonic content is absent. |
| Sample rate $= 44.1\text{ kHz}$, smooth continuous energy up to 22.05 kHz | **95%** | `GENUINE_CDDA` | **100% Genuine CD Lossless Master (16-bit / 44.1 kHz)**<br>Pristine dynamic bandwidth with continuous natural harmonic decay across the entire Red Book CDDA spectrum. |
| Sample rate $\ge 48\text{ kHz}$ or Bit depth $\ge 24\text{ bit}$, energy extends past 22.05 kHz | **100%** | `GENUINE_HIRES` | **100% Genuine Hi-Res Studio Master (24-bit / 96 kHz+)**<br>Pristine studio master harmonics extending into ultrasonic frequencies beyond 22.05 kHz up to the full Nyquist boundary. |

---

### Step 5: High-Resolution Logarithmic Spectrogram Generation

To provide the user with immediate visual proof, the engine utilizes FFmpeg's `showspectrumpic` filter:

```bash
ffmpeg -y -hide_banner -nostats -i "input.flac" \
  -lavfi "showspectrumpic=s=960x260:mode=combined:color=fire:scale=log:legend=1" \
  -frames:v 1 -update 1 "spectrogram.png"
```

- **Dimensions**: $960 \times 260$ pixels.
- **Color Map**: `fire` palette (dark blue/purple = low amplitude $\to$ bright red/orange = high amplitude $\to$ white = peak energy).
- **Scale**: `log` (logarithmic frequency axis). This mirrors human pitch perception and visually expands the critical 10 kHz – 24 kHz transition zone.
- **Legend**: `1` (displays frequency axis scale in kHz and amplitude scale in dB).
- **Output**: Converted to an in-memory Base64 data URI (`data:image/png;base64,...`) and embedded directly into the response JSON for instant rendering in the browser without writing lingering cache files to disk.

---

## 4. Automated Pipeline Integration (`audiophile_flac_engine.py`)

The FLAC Checker is not just a passive tool; it acts as an **automated firewall** inside the live media acquisition engine:

```python
# audiophile_flac_engine.py snippet
def verify_and_accept_flac(file_path, tier_name):
    # 1. Binary validation
    with open(file_path, 'rb') as f:
        if f.read(4) != b'fLaC':
            return False

    # 2. Automated spectral authenticity check
    is_ok, report = is_lossless_authentic(file_path)
    score = report.get("authenticityScore", 0)

    if not is_ok:
        print(f"[{tier_name}] ❌ REJECTED FAKE FLAC: Lossy cutoff detected (Score: {score}/100)", file=sys.stderr)
        os.remove(file_path)
        return False  # Triggers automatic fallback to next Tier!

    print(f"[{tier_name}] ✅ Verified Genuine Lossless Master: Score {score}/100", flush=True)
    return True
```

### Self-Healing Resolution Flow:
1. **Tier 1 (Tidal Hi-Res)**: Queries official studio FLAC masters directly.
2. **Tier 2 (Soulseek P2P)**: Downloads the candidate FLAC from high-speed audiophile peers.  
   $\to$ **FLAC Checker runs instantly on the downloaded file.**  
   $\to$ If the peer shared an upscaled YouTube rip (capped at 20 kHz), the file is **immediately deleted**.  
   $\to$ The engine automatically falls back to **Tier 3**.
3. **Tier 3 (Deezer HiFi CDN)**: Streams bit-for-bit Red Book CDDA (1411 kbps FLAC, 16-bit / 44.1 kHz) via direct Blowfish CBC stream decryption.

---

## 5. REST API Specifications

The engine exposes three authenticated REST endpoints in `server.js`:

### 1. Execute Analysis: `POST /api/flac-check`
Runs complete spectral and container analysis on an audio file.

- **Request Body (JSON)**:
  - `filePath`: Absolute file path on the server (e.g., `/home/sakura/Uni-Downloads/Music/track.flac`).
  - `jobId`: Active download queue job ID (auto-resolves file location).
  - `fileBase64`: Base64 encoded audio string (for direct drag-and-drop web uploads).
- **Response (JSON)**:
```json
{
  "valid": true,
  "filename": "Coldplay - Hymn for the Weekend.flac",
  "filePath": "/home/sakura/Uni-Downloads/Music/Coldplay - Hymn for the Weekend.flac",
  "fileSize": 38459201,
  "fileSizeMB": 36.68,
  "durationSec": 258.12,
  "sampleRate": 44100,
  "bitsPerSample": 16,
  "bitrateKbps": 1191,
  "channels": 2,
  "channelLayout": "Stereo",
  "nyquistLimitHz": 22050,
  "cutoffFrequencyHz": null,
  "md5Signature": "a3b9f4e2d1c08e5a7b6c9d8e1f2a3b4c",
  "isFlacContainer": true,
  "authenticityScore": 95,
  "verdict": "GENUINE_CDDA",
  "verdictTitle": "100% Genuine CD Lossless Master (16-bit / 44.1 kHz)",
  "verdictBadge": "success",
  "energyAnalysis": {
    "above_16000hz": { "mean_db": -61.2, "max_db": -24.1, "active": true },
    "above_18500hz": { "mean_db": -68.4, "max_db": -32.5, "active": true },
    "above_20000hz": { "mean_db": -73.8, "max_db": -41.0, "active": true }
  },
  "warnings": [],
  "details": [
    "Continuous natural harmonic spectrum spanning full CDDA dynamic bandwidth (up to 22.05 kHz)."
  ],
  "tags": {
    "title": "Hymn for the Weekend",
    "artist": "Coldplay",
    "album": "A Head Full of Dreams",
    "date": "2015",
    "isrc": "GBAYE1501170"
  },
  "spectrogram": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
}
```

### 2. List Recent Files: `GET /api/flac-check/recent`
Scans download directories (`Uni-Downloads/Music`, temporary job buffers) and returns the 35 most recently acquired FLAC files for quick inspection in the dropdown menu.

### 3. Purge Files: `POST /api/flac-check/clear-recent`
Purges temporary inspection buffers and downloaded FLAC files from server storage, returning the total file count deleted and megabytes freed.

---

## 6. Frontend UI Components

The web user interface (viewable at `#viewFlacChecker`) features an audiophile control cockpit:

1. **Interactive Dropzone**:
   - Supports HTML5 Drag-and-Drop and Electron native file dialogs.
   - Converts browser client files to Base64 in chunks for upload and instant server-side analysis.
2. **Recent Downloads Selector**:
   - Real-time dropdown populated with recently downloaded tracks. Selecting any track initiates analysis in under 1.5 seconds.
3. **Verdict Banner**:
   - Color-coded dynamically (`verdict-success` = Emerald Green, `verdict-warning` = Amber Orange, `verdict-danger` = Rose Red).
   - Displays overall score badge (e.g. `Score: 100/100`), classification verdict, and file name.
4. **Hardware Specifications Grid**:
   - Six interactive telemetry tiles displaying Sample Rate, Nyquist Boundary, Bit Depth (with Studio PCM badge), Uncompressed Bitrate, Channel Geometry, and Detected Cutoff Frequency.
5. **Multi-Band Decibel Energy Gauges**:
   - Five animated progress bars measuring RMS energy at 16.0 kHz, 18.5 kHz, 20.0 kHz, 22.0 kHz, and 24.0 kHz.
   - Shows active decibel levels (e.g. `-64.2 dB`) or highlights hard digital silence (`Silence (Cutoff)`).
6. **Logarithmic Spectrogram Canvas**:
   - Renders the full-spectrum Base64 spectrogram.
   - Users can visually verify the presence of frequencies up to 22.05 kHz or 48.0 kHz with no cutoffs.
7. **Vorbis Metadata Accordion**:
   - Collapsible panel displaying raw Vorbis comment fields, embedded lyrics, ISRC, and stream signatures.

---

## 7. Verification & Diagnostic Commands

To manually run the FLAC Checker from the server terminal (`ssh sakura`):

```bash
# Full analysis with JSON output and spectrogram
python3 /home/sakura/jav/flac_checker.py "/path/to/music.flac"

# Quick analysis without generating spectrogram
python3 /home/sakura/jav/flac_checker.py "/path/to/music.flac" --no-spectrogram

# Direct FFmpeg high-pass check at 20 kHz (measuring decibel floor)
ffmpeg -hide_banner -nostats -i "music.flac" \
  -af "firequalizer=gain_entry='entry(0,-120);entry(19999,-120);entry(20000,0);entry(22050,0)',volumedetect" \
  -f null -
```

---

## 8. Summary Table: Audio Formats & Spectral Signatures

| Source Format | Container Sample Rate | True Audio Cutoff | Mean Energy @ 20 kHz | Classification Verdict |
| :--- | :---: | :---: | :---: | :---: |
| **MP3 128 kbps** | 44.1 kHz | **16.0 kHz** | $\le -91\text{ dB}$ (Digital Silence) | `FAKE_FLAC` (Score: 20%) |
| **MP3 192 kbps** | 44.1 kHz | **18.5 kHz** | $\le -91\text{ dB}$ (Digital Silence) | `FAKE_FLAC` (Score: 40%) |
| **MP3 320 kbps** | 44.1 kHz | **20.0 kHz** | $\le -89\text{ dB}$ (Digital Silence) | `SUSPICIOUS` (Score: 65%) |
| **YouTube Opus** | 48.0 kHz | **20.0 kHz** | $\le -89\text{ dB}$ (Digital Silence) | `SUSPICIOUS` (Score: 65%) |
| **CDDA (Deezer/Tidal)** | 44.1 kHz | **22.05 kHz** (Full CDDA) | $-65\text{ dB}$ to $-75\text{ dB}$ (Active) | `GENUINE_CDDA` (Score: 95%) |
| **Upscaled CDDA** | 48.0 / 96.0 kHz | **22.05 kHz** (CD Limit) | $\le -89\text{ dB}$ above 22.05 kHz | `UPSCALED_HIRES` (Score: 75%) |
| **Hi-Res Master** | 96.0 / 192.0 kHz | **48.0 / 96.0 kHz** | $-50\text{ dB}$ to $-70\text{ dB}$ (Ultrasonic) | `GENUINE_HIRES` (Score: 100%) |

---
*Report generated and maintained by Universal Downloader Core Engineering.*
