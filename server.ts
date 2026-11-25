import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const CACHE_DIR = path.resolve(__dirname, '.voice-cache');

const VOICE_CACHE_VERSION = 'v2';

interface VoiceLineSpec {
  text: string;
  style: string;
  voiceName: 'Fenrir' | 'Charon' | 'Puck' | 'Kore' | 'Zephyr';
}

/**
 * Hilarious, passionate colloquial Chinese billiard-hall voice-actor scripts
 * ONLY for break-and-pot (开球有下) and consecutive-pot streaks (2+ 连杆).
 * Uses high-throughput gemini-3.8-flash-lite-tts with expressive voice-actor style
 * direction, serialized request pacing, and versioned RAM + disk caching.
 */
const VOICE_LINES: Record<string, VoiceLineSpec> = {
  break_pot: {
    text: '哎哟喂！开球有下！今天这手气，稳了！',
    style:
      'Hilarious, hyper-passionate Chinese male game voice actor with charismatic theatrical hype and playful swagger in Mandarin. Burst out cheering on 哎哟喂！, punch 开球有下！ with booming pride, then brag with a big cheeky grin on 今天这手气，稳了！ Authentic human emotion, zero robotic stiffness.',
    voiceName: 'Fenrir',
  },
  streak_2: {
    text: '两杆连进！哎哟，有点东西啊你小子！',
    style:
      'Expressive, charismatic Chinese male voice actor doing a hyped-up comedic shout in Mandarin. Deliver 两杆连进！ with crisp theatrical punch, then flip into impressed playful buddy-banter with a grinning chuckle on 哎哟，有点东西啊你小子！ Natural lively colloquial pacing.',
    voiceName: 'Fenrir',
  },
  streak_3: {
    text: '三连杆啦！这手感烫手啊，对面赶紧擦擦汗！',
    style:
      'Booming, hilarious Chinese sports hype announcer voice actor in Mandarin. Rising thrilled excitement on 三连杆啦！, followed by dramatic cheeky trash-talk swagger on 这手感烫手啊，对面赶紧擦擦汗！ Lively, human, super engaging delivery.',
    voiceName: 'Fenrir',
  },
  streak_4: {
    text: '四连杆！对面别站着了，搬个小板凳慢慢看吧！',
    style:
      'Legendary theatrical Chinese male voice actor delivering outrageous comedic trash-talk with mock-epic grandeur in Mandarin. Thunderous bold callout on 四连杆！, pause a comic beat, then deliver a cheeky, grinning, ultra-confident roast on 对面别站着了，搬个小板凳慢慢看吧！',
    voiceName: 'Fenrir',
  },
  streak_5: {
    text: '五连杆！离谱！你往袋口偷偷装吸铁石了吧！',
    style:
      'Wildly stunned, hilarious Chinese male voice actor losing his mind in Mandarin. Explosive comedic disbelief on 五连杆！离谱！, then roaring with exaggerated astonishment and laughter on 你往袋口偷偷装吸铁石了吧！',
    voiceName: 'Fenrir',
  },
  streak_6: {
    text: '天呐彻底杀疯了！快叫老板结账，这台子归你了！',
    style:
      'Ultimate climax Chinese male game voice actor in full comedic-epic overdrive in Mandarin. Thunderous ecstatic baritone roar on 天呐彻底杀疯了！, bursting with triumphant laughter and hyped-up billiard-hall swagger on 快叫老板结账，这台子归你了！',
    voiceName: 'Fenrir',
  },
};

const voiceCache = new Map<string, Buffer>();
const voiceInFlight = new Map<string, Promise<Buffer>>();

// Load any previously persisted versioned voice WAVs from disk on startup
try {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  for (const clipId of Object.keys(VOICE_LINES)) {
    const filePath = path.join(CACHE_DIR, `${VOICE_CACHE_VERSION}_${clipId}.wav`);
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      if (buf.length > 44) {
        voiceCache.set(clipId, buf);
      }
    }
  }
} catch {
  // Disk cache is optional; RAM cache still works
}

// Gentle server-side serial queue + 429 cooldown tracker to stay safely inside quota limits
let quotaCooldownUntilMs = 0;
let lastApiCallMs = 0;
let queueTail: Promise<void> = Promise.resolve();
const MIN_REQUEST_GAP_MS = 1200;

let cachedAiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!cachedAiClient) {
    cachedAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedAiClient;
}

class RateLimitError extends Error {
  public readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`TTS rate limit active, retry after ${retryAfterSec}s`);
    this.retryAfterSec = retryAfterSec;
  }
}

function parseRetrySeconds(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/retry in\s+([\d.]+)s/i) ?? msg.match(/retryDelay["']?\s*:\s*["']?(\d+)s/i);
  if (match) {
    const parsed = Math.ceil(Number(match[1]));
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(120, parsed);
  }
  return 35;
}

function isQuotaOrRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
}

function enqueueSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(async () => {
    const now = Date.now();
    if (now < quotaCooldownUntilMs) {
      const waitSec = Math.max(1, Math.ceil((quotaCooldownUntilMs - now) / 1000));
      throw new RateLimitError(waitSec);
    }
    const elapsed = now - lastApiCallMs;
    if (elapsed < MIN_REQUEST_GAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed));
    }
    lastApiCallMs = Date.now();
    return fn();
  });
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function synthesizeVoiceClip(clipId: string, spec: VoiceLineSpec): Promise<Buffer> {
  const cached = voiceCache.get(clipId);
  if (cached) return cached;

  const existing = voiceInFlight.get(clipId);
  if (existing) return existing;

  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }

  const job = enqueueSerialized(async () => {
    const doubleCheck = voiceCache.get(clipId);
    if (doubleCheck) return doubleCheck;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: spec.text,
                speechMetadata: {
                  style: spec.style,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: spec.voiceName,
              },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error(`No audio data returned for voice clip "${clipId}"`);
      }

      const wavBuffer = Buffer.from(base64Audio, 'base64');
      voiceCache.set(clipId, wavBuffer);

      // Persist to local disk cache asynchronously so restarts reuse the WAV without API calls
      try {
        fs.writeFile(
          path.join(CACHE_DIR, `${VOICE_CACHE_VERSION}_${clipId}.wav`),
          wavBuffer,
          () => {},
        );
      } catch {
        // noop
      }

      return wavBuffer;
    } catch (err) {
      if (isQuotaOrRateLimitError(err)) {
        const retrySec = parseRetrySeconds(err);
        quotaCooldownUntilMs = Date.now() + retrySec * 1000;
        throw new RateLimitError(retrySec);
      }
      throw err;
    }
  });

  voiceInFlight.set(clipId, job);
  try {
    return await job;
  } finally {
    voiceInFlight.delete(clipId);
  }
}

async function startServer() {
  const app = express();

  app.get('/api/voice/:clipId', async (req, res) => {
    const clipId = req.params.clipId;
    const spec = Object.prototype.hasOwnProperty.call(VOICE_LINES, clipId)
      ? VOICE_LINES[clipId]
      : null;

    if (!spec) {
      res.status(404).json({ error: 'Unknown voice clip ID' });
      return;
    }

    // Serve cached clip immediately even if cooldown is active
    const cached = voiceCache.get(clipId);
    if (cached) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(cached);
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({ error: 'Voice synthesis service unavailable: missing API key' });
      return;
    }

    if (Date.now() < quotaCooldownUntilMs) {
      const retrySec = Math.max(1, Math.ceil((quotaCooldownUntilMs - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retrySec));
      res.status(429).json({ error: 'TTS quota cooldown active', retryAfterSec: retrySec });
      return;
    }

    try {
      const wavBuffer = await synthesizeVoiceClip(clipId, spec);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(wavBuffer);
    } catch (err) {
      if (err instanceof RateLimitError) {
        res.setHeader('Retry-After', String(err.retryAfterSec));
        res.status(429).json({
          error: 'TTS rate limit reached, please retry shortly',
          retryAfterSec: err.retryAfterSec,
        });
        return;
      }
      console.error(`[TTS] Failed to generate clip "${clipId}":`, err);
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to synthesize voice clip',
      });
    }
  });

  if (IS_PROD) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
