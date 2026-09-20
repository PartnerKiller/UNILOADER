# 1:1 Physical CD-Rip Archival Pipeline (Preserved Archive)

## Overview
This directory preserves the full codebase, algorithms, and multi-source scrapers for the **1:1 CD-Rip Archival Engine**.

The complete development trajectory and production-ready commit history are also permanently preserved in Git branch:
```bash
git checkout feature/cdrip-pipeline
```

## Preserved Components
1. **`cdrip_engine.py`**:
   - Primary orchestration pipeline: multi-source resolution across Soulseek P2P, Telegram archival channels, and BitTorrent lossless swarms.
   - Fallback logic to Deezer HiFi 1411 kbps CDDA stream / Tidal Hi-Res.
   - Comprehensive provenance scoring and AccurateRip verification.

2. **`cdrip_verifier.py`**:
   - Multi-pass Red Book Audio CD (16-bit / 44.1 kHz PCM) verification.
   - Exact Audio Copy (EAC) and XLD log parsing (Test & Copy CRC match, extraction drive offset, AccurateRip confidence scoring).
   - CUE sheet sector parser (`INDEX 01` pregap boundaries, track indexing).
   - High-resolution packaging scan verification (Front, Back, CD booklet).

3. **`catalogue_parser.py`**:
   - Optical disc catalogue number extraction and normalization for global and regional labels (EMI, Saregama/HMV CDNF, Asha Audio, SVF, Sony Music, CBS/Columbia).

4. **`telegram_cdrip_engine.py`**:
   - Telegram web scraper for indexed lossless archival channels.
   - Parses document attachments for `.flac`, `.cue`, `.log`, and `.zip` archives.

5. **`torrent_cdrip_engine.py`**:
   - BitTorrent lossless tracker and TPB/Apibay query engine for authentic optical CD-Rip packages.

6. **`telegram_channels.json`**:
   - Curated list of active Telegram archival repositories.
