const fs = require('fs');
const path = require('path');
const https = require('https');

// Load environment variables from .env file if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [k, ...rest] = trimmed.split('=');
        const v = rest.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[k.trim()]) {
          process.env[k.trim()] = v;
        }
      }
    }
  } catch (e) {}
}

/**
 * Universal Downloader - AI Service Module (Google Gemini Engine)
 * Strictly reserved for Server Owner (Sakura).
 * Powers:
 *  1. Smart Search Copilot (Natural language -> structured download intent)
 *  2. FLAC Checker Audiophile Spectrogram Audit (Deep lossy/cutoff detection)
 *  3. Video Auto-Subtitles (.srt) & Translation
 *  4. Adult & JAV Hub Image Recognition & Japanese Title Cleaning
 *  5. Dirty Filename & Scene Release Parser
 */

const DEFAULT_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite'
];

function getApiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function isAiConfigured() {
  const key = getApiKey();
  return Boolean(key && key.length > 10);
}

function getAiStatus() {
  const configured = isAiConfigured();
  return {
    enabled: configured,
    provider: 'Google Gemini',
    activeModel: DEFAULT_MODELS[0],
    fallbackModels: DEFAULT_MODELS.slice(1),
    features: {
      copilotSearch: configured,
      spectrogramAudit: configured,
      autoSubtitles: configured,
      javRecognition: configured,
      filenameCleaner: configured
    },
    ownerOnly: true
  };
}

/**
 * Internal robust HTTPS caller for Generative Language API
 */
function requestGemini(model, payload, apiKey, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: timeoutMs
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, statusCode: res.statusCode, data: parsed });
          } else {
            resolve({
              ok: false,
              statusCode: res.statusCode,
              error: parsed.error?.message || `HTTP ${res.statusCode}`
            });
          }
        } catch (e) {
          resolve({ ok: false, statusCode: res.statusCode, error: `Invalid JSON response: ${e.message}` });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Gemini API request timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Execute Gemini call with automatic model failover
 */
async function callGemini(payload, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('Gemini API key is not configured in server environment (GEMINI_API_KEY).');
  }

  const modelsToTry = options.models || DEFAULT_MODELS;
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const res = await requestGemini(model, payload, apiKey, options.timeoutMs || 35000);
      if (res.ok && res.data) {
        return { model, data: res.data };
      }
      lastError = res.error || `Error code ${res.statusCode}`;
      // If 404 or 503, try next candidate model
      console.warn(`[AI Engine] Model ${model} returned error: ${lastError}. Trying fallback...`);
    } catch (err) {
      lastError = err.message;
      console.warn(`[AI Engine] Model ${model} network error: ${err.message}. Trying fallback...`);
    }
  }

  throw new Error(`All Gemini models failed. Last error: ${lastError}`);
}

/**
 * Extract text result from Gemini response
 */
function extractResponseText(geminiResult) {
  const candidate = geminiResult?.data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const textPart = parts.find(p => typeof p.text === 'string');
  return textPart ? textPart.text.trim() : '';
}

/**
 * Pillar 1: Smart Search & Intent Parser (Copilot)
 * Takes a natural language prompt and resolves download intent, entities, and parameters.
 */
async function parseSearchIntent(userPrompt) {
  if (!userPrompt || typeof userPrompt !== 'string' || !userPrompt.trim()) {
    throw new Error('Search prompt cannot be empty');
  }

  const systemInstructions = `
You are the AI Media Copilot for Universal Downloader.
Your task is to analyze natural language user download queries and extract structured intent.

Categories:
- "music": Music albums, tracks, discographies, artists. Detect if audiophile 24-bit FLAC / Lossless is requested.
- "movies": Cinema releases, TV series, episodes, anime.
- "adult_jav": Japanese Adult Videos (JAV), actresses, uncensored releases, adult codes (e.g. SSIS-123, IPX-456).
- "direct_url": If the input contains a URL (YouTube, Twitter, TikTok, Instagram, Jable, etc.).
- "general_search": Ambiguous media.

Output strictly valid JSON with no conversational markdown or backticks.
Schema:
{
  "intent": "music" | "movies" | "adult_jav" | "direct_url" | "general_search",
  "query": "clean search query string",
  "artist": "string or null",
  "title": "string or null",
  "album": "string or null",
  "year": "string or null",
  "season": number or null,
  "episode": number or null,
  "javCode": "string or null (e.g. SSIS-888)",
  "javActress": "string or null",
  "quality": "24bit_flac" | "16bit_flac" | "320k" | "4k" | "1080p" | "best",
  "isLosslessAudio": boolean,
  "suggestedTab": "downloader" | "music" | "movies" | "adult-search",
  "directUrl": "url string or null",
  "explanation": "concise 1-sentence description of what will be searched/downloaded"
}
`;

  const payload = {
    contents: [
      {
        parts: [
          { text: systemInstructions },
          { text: `User Prompt: "${userPrompt.trim()}"` }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const res = await callGemini(payload);
  const rawText = extractResponseText(res);
  try {
    const parsed = JSON.parse(rawText);
    return {
      success: true,
      modelUsed: res.model,
      intent: parsed
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse AI JSON response: ${err.message}`,
      raw: rawText
    };
  }
}

/**
 * Pillar 2: Audiophile Spectrogram Audit
 * Analyzes audio spectrogram PNG to authenticate true 24-bit/16-bit Lossless vs upscaled lossy transcode.
 */
async function auditSpectrogram(base64ImageOrDataUri, audioMetadata = {}) {
  if (!base64ImageOrDataUri || typeof base64ImageOrDataUri !== 'string') {
    throw new Error('Spectrogram image is required');
  }

  let cleanBase64 = base64ImageOrDataUri;
  let mimeType = 'image/png';
  if (base64ImageOrDataUri.startsWith('data:')) {
    const match = base64ImageOrDataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      cleanBase64 = match[2];
    }
  }

  const promptText = `
You are a World-Class Audiophile Mastering Sound Engineer & Lossless Audio Authenticity Expert.
Inspect this audio frequency spectrogram generated by FFmpeg.

Determine whether this audio is:
1. GENUINE_HIRES: True 24-bit Hi-Res Studio Master (audio energy smoothly extends beyond 22kHz, up to 40-48kHz or higher without brickwall cutoff).
2. GENUINE_CD: True 16-bit 44.1kHz Red Book CD Lossless (dense frequency coverage up to 20-22kHz Nyquist limit with natural acoustic roll-off).
3. FAKED_UPSCALE: Lossy audio (e.g. YouTube 128k-160k Opus or MP3) transcoded/upscaled into a FLAC container. Look for hard brickwall cutoffs at 16kHz (128k MP3), 19-20.5kHz (320k MP3 / 160k Opus), or total silence in upper frequencies despite high sample rate.
4. LOSSLESS_WITH_COMPRESSION: Mastered from modern digital limiter, but lossless bitstream.

Report strictly valid JSON:
{
  "verdict": "GENUINE_HIRES" | "GENUINE_CD" | "FAKED_UPSCALE" | "LOSSLESS_WITH_COMPRESSION" | "UNCERTAIN",
  "fidelityScore": number from 0 to 100 (where 90-100 is genuine Hi-Res, 80-89 genuine CD, <65 fake transcode),
  "isAuthenticLossless": boolean,
  "cutoffFrequency": "string (e.g. 'No cutoff (extends to 48kHz)', 'Hard cutoff at 20.2 kHz', etc.)",
  "estimatedOriginalSource": "string (e.g. '24-bit / 96 kHz Studio Master', '16-bit / 44.1 kHz Audio CD', '128-160 kbps Lossy Transcode')",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "technicalAnalysis": "Detailed 2-3 sentence analysis of frequency distribution, harmonic decay, and spectral integrity.",
  "badges": ["array", "of", "3-5", "badges", "e.g. Genuine Studio Master, No Nyquist Shelf, Full Dynamic Range"]
}
`;

  const payload = {
    contents: [
      {
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: mimeType,
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const res = await callGemini(payload);
  const rawText = extractResponseText(res);
  try {
    const parsed = JSON.parse(rawText);
    return {
      success: true,
      modelUsed: res.model,
      audit: parsed
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse Spectrogram Audit JSON: ${err.message}`,
      raw: rawText
    };
  }
}

/**
 * Pillar 4: Adult & JAV Hub Image Recognition
 * Identifies actress or Japanese video production code from video thumbnail or frame.
 */
async function identifyJavFromImage(base64ImageOrDataUri, contextText = '') {
  if (!base64ImageOrDataUri) {
    throw new Error('Image data is required for recognition');
  }

  let cleanBase64 = base64ImageOrDataUri;
  let mimeType = 'image/jpeg';
  if (base64ImageOrDataUri.startsWith('data:')) {
    const match = base64ImageOrDataUri.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      cleanBase64 = match[2];
    }
  }

  const promptText = `
You are an expert cataloger of Japanese Adult Videos (JAV) and Asian cinema.
Examine this video frame, cover poster, or actress screenshot.

Extract or infer:
1. Production code series if visible or matching actress/maker aesthetic (e.g. SSIS, IPX, MIDE, STARS, MIDV, PRED, JUL, ABP, SIVR, etc.).
2. Actress names (Romanized and Japanese Kanji if known, e.g. "Yua Mikami (三上悠亜)", "Eimi Fukada (深田えいみ)", etc.).
3. Studio / Maker (e.g. S1 NO.1 STYLE, MOODYZ, IDEA POCKET, SOD, etc.).
4. Visual tags and theme (e.g. Uniform, Romance, Office, Comedy, Drama).
5. Clean English title suggestion.

Output strictly valid JSON:
{
  "detectedCode": "string or null",
  "actressName": "string or null",
  "actressKanji": "string or null",
  "maker": "string or null",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "themeTags": ["tag1", "tag2"],
  "cleanEnglishTitle": "string",
  "searchQuerySuggestion": "optimal search query for finding this video"
}
`;

  const payload = {
    contents: [
      {
        parts: [
          { text: promptText },
          { text: contextText ? `Context text from page or title: "${contextText}"` : '' },
          {
            inlineData: {
              mimeType: mimeType,
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2
    }
  };

  const res = await callGemini(payload);
  const rawText = extractResponseText(res);
  try {
    const parsed = JSON.parse(rawText);
    return {
      success: true,
      modelUsed: res.model,
      recognition: parsed
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse JAV Image Recognition JSON: ${err.message}`,
      raw: rawText
    };
  }
}

/**
 * Pillar 4b: Japanese Video Title & Synopsis Translation & Cleansing
 */
async function translateAndCleanJavTitle(rawTitle, rawSynopsis = '') {
  if (!rawTitle || typeof rawTitle !== 'string') {
    throw new Error('Title is required');
  }

  const promptText = `
Translate and clean this Japanese Adult Video title and synopsis into fluent, natural English.
Remove annoying clickbait marketing prefixes (e.g. 【HD】, 【ハイレゾ】, 【独占配信】, 【VR】, [720p], [FHD]).
Extract any video code (e.g. SSIS-123) and actress names.

Raw Title: "${rawTitle}"
${rawSynopsis ? `Raw Synopsis: "${rawSynopsis}"` : ''}

Output strictly valid JSON:
{
  "code": "extracted code or null",
  "cleanTitle": "clean English title",
  "actresses": ["array of actress names"],
  "englishSynopsis": "concise 2-sentence synopsis in English",
  "genres": ["array of genre tags"]
}
`;

  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const res = await callGemini(payload);
  const rawText = extractResponseText(res);
  try {
    const parsed = JSON.parse(rawText);
    return { success: true, modelUsed: res.model, translated: parsed };
  } catch (err) {
    return { success: false, error: err.message, raw: rawText };
  }
}

/**
 * Pillar 5: Dirty Filename & Scene Release Parser
 * Turns messy torrent/scene filenames into clean library metadata.
 */
async function cleanDirtyFilename(rawFilename) {
  if (!rawFilename || typeof rawFilename !== 'string') {
    throw new Error('Filename is required');
  }

  const promptText = `
You are a media file organization engine. Parse this messy release filename into clean, organized metadata.
Filename: "${rawFilename}"

Output strictly valid JSON:
{
  "mediaType": "movie" | "tv_show" | "music" | "anime" | "general",
  "cleanTitle": "Standardized title without tags",
  "year": "string or null",
  "season": number or null,
  "episode": number or null,
  "episodeTitle": "string or null",
  "artist": "string or null",
  "album": "string or null",
  "trackNumber": number or null,
  "resolution": "4K" | "1080p" | "720p" | "SD" | null,
  "videoCodec": "HEVC" | "AVC" | "AV1" | "VP9" | null,
  "audioCodec": "FLAC" | "DTS-HD" | "TrueHD" | "Atmos" | "AAC" | "AC3" | "MP3" | null,
  "releaseGroup": "string or null",
  "suggestedLibraryPath": "Clean standard filename (e.g. 'Show Name - S01E01 - Title [1080p].mkv' or 'Movie (Year) [4K].mkv')"
}
`;

  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const res = await callGemini(payload);
  const rawText = extractResponseText(res);
  try {
    const parsed = JSON.parse(rawText);
    return { success: true, modelUsed: res.model, parsed };
  } catch (err) {
    return { success: false, error: err.message, raw: rawText };
  }
}

/**
 * Pillar 3: Subtitles & Video Chapters (Audio to Timed SRT)
 */
async function generateSubtitlesFromAudio(audioBase64, language = 'en') {
  if (!audioBase64) {
    throw new Error('Audio snippet is required');
  }

  let cleanBase64 = audioBase64;
  let mimeType = 'audio/mp3';
  if (audioBase64.startsWith('data:')) {
    const match = audioBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      cleanBase64 = match[2];
    }
  }

  const promptText = `
Transcribe this audio track and generate synchronized SubRip (.srt) subtitles in ${language}.
Format strictly as valid standard SRT with sequential numbers, timestamps (00:00:00,000 --> 00:00:00,000), and subtitle lines.
Do not add conversational commentary.
`;

  const payload = {
    contents: [
      {
        parts: [
          { text: promptText },
          {
            inlineData: {
              mimeType: mimeType,
              data: cleanBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1
    }
  };

  const res = await callGemini(payload);
  const srtText = extractResponseText(res);
  return {
    success: true,
    modelUsed: res.model,
    srt: srtText
  };
}

module.exports = {
  getApiKey,
  isAiConfigured,
  getAiStatus,
  callGemini,
  parseSearchIntent,
  auditSpectrogram,
  identifyJavFromImage,
  translateAndCleanJavTitle,
  cleanDirtyFilename,
  generateSubtitlesFromAudio
};
