# Project Instructions & Rules: Universal-Downloader

## 1. Audio Quality Rules (Lossless & FLAC)
- **Always Download the Best Quality of FLAC**:
  - Prioritize 24-bit Hi-Res Studio Masters (192 kHz / 96 kHz / 88.2 kHz / 48 kHz, 24-bit / 32-bit) over 16-bit 44.1 kHz CD Lossless.
  - Rank candidate streams, peer files, and local caches strictly by bit depth (`bitDepth`), sample rate (`sampleRate`), and uncompressed bitrate.
  - Prefer genuine Studio Master / Vinyl / SACD / Hi-Res releases whenever available.
  - Never downgrade or accept a lower resolution/bitrate if a higher quality genuine lossless stream is accessible.
  - Strictly prohibit fake/lossy transcodes: YouTube transcoding to FLAC is completely disabled to prevent upscaled fake FLAC.

## 2. Source Resolution Pipeline
1. **Tier 1 (Hi-Res & Studio Masters)**: Tidal Hi-Res / Monochrome API.
2. **Tier 2 (P2P Audiophile Masters)**: Soulseek P2P Network (SLSKD) with 24-bit Hi-Res prioritization and free-slot routing.
3. **Tier 3 (Lossless CD Bitstream)**: Deezer HiFi 1411 kbps 16-bit 44.1 kHz FLAC CDN with territory fallback token support and Blowfish CBC stream decryption.

## 3. Git & Deployment Policy
- **Always update to git**: After making fixes or modifications, commit and push changes to the repository (`PartnerKiller/JAV-Downloader` on branch `main`).
- **Remote Sync**: Synchronize updated files to the production host/service and restart `jav-downloader.service`.
- **Confidentiality**: Never commit secrets, tokens, API keys, passwords, credentials, or private network IPs to Git.

## 4. UI Versioning Policy
- **Always update the version tag in `public/index.html` (`<span class="version-tag">...</span>`)**:
  - **Major updates**: `X.X.0` (bump major or minor release value and reset patch to `0`, e.g., `v3.8.0` → `v3.9.0` or `v4.0.0`).
  - **Minor updates**: `0.0.X` (bump patch value for bug fixes, tweaks, and maintenance, e.g., `v3.9.0` → `v3.9.1`).
  - *(where `X` is the main incremented value)*.

## 5. Remote Host SSH Command
- **Always use `ssh sakura`**: Never use the full IP address (`ssh sakura@192.168.0.10`); always use the configured SSH host alias `ssh sakura`.


