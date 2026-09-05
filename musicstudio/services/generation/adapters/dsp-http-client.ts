/**
 * The TypeScript side of the DSP seam (roadmap §4.4, step S3 — client half of S2).
 *
 * `dsp/src/musicstudio_dsp/sidecar.py` exposes every Celery task as `POST /tasks/<name>` with
 * the task's keyword arguments as a JSON object and its result dict as the response. This is the
 * caller. It speaks to exactly one task for now — `normalise_for_storage`, the one the
 * publication path needs — and adding a second is a method that names a task and decodes a dict,
 * not a change to how the wire works.
 *
 * ### Shaped like `createAceHttpTransport`, for the same reasons
 *
 * `fetch` is injected so the production client is testable without a global stub, the base URL
 * is stripped of trailing slashes once, and there is **no timeout of its own**: the publication
 * step runs inside the orchestrator's Requirement 20.14 budget, and a second, quieter deadline
 * here would be the one that fires first and says the least.
 *
 * ### The transport is base64, and this is where that is paid for
 *
 * The sidecar keeps the Celery shell's base64-in-JSON encoding so both shells present one
 * contract; the cost is a 4/3 expansion of every audio buffer through this process's memory. It
 * is the stopgap `worker.py` names, and the step that replaces it — an object key instead of
 * bytes — is a change to this file and the sidecar together, once the object store is reachable
 * from both sides.
 */

/**
 * The containers the pipeline can store in — `STORAGE_FORMAT` in `pipeline.py` is one of these.
 *
 * Not the library's `DownloadFormat`: that is what a user may *ask for* (mp3, ogg included),
 * this is what the store *holds*, and conflating them would let a download format name a
 * stored object that cannot exist.
 */
export type StoredAudioFormat = 'flac' | 'wav';

const STORED_AUDIO_FORMATS: readonly StoredAudioFormat[] = ['flac', 'wav'];

/** What `normalise_for_storage` reports — the sidecar's dict, with the product's names. */
export interface NormalisedAudio {
  readonly bytes: Uint8Array;
  readonly audioFormat: StoredAudioFormat;
  readonly durationMs: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Requirement 19.5: what the engine produced, kept in provenance. */
  readonly originalSampleRate: number;
  readonly originalDurationMs: number;
  readonly lengthErrorMs: number;
  readonly resampled: boolean;
  /**
   * Requirements 16.6, 33.14 — the scheme that marked *this* copy, reported rather than
   * assumed, so the provenance row records what happened rather than a constant.
   */
  readonly watermarkVersion: number;
}

/** The DSP operations the generation path needs. Narrow on purpose; see the header. */
export interface DspClient {
  normaliseForStorage(audio: Uint8Array): Promise<NormalisedAudio>;
}

export interface DspHttpClientConfig {
  /** Sidecar origin, e.g. `http://127.0.0.1:8002`. No trailing slash needed. */
  readonly baseUrl: string;
  /** Injected so the production client is testable without a global stub. */
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** A refusal or failure the sidecar reported, carrying its own code and message. */
export class DspTaskFailed extends Error {
  constructor(
    readonly task: string,
    readonly httpStatus: number,
    readonly code: string,
    message: string,
  ) {
    super(`dsp task ${task} failed (${String(httpStatus)} ${code}): ${message}`);
    this.name = 'DspTaskFailed';
  }
}

const NORMALISE_TASK = 'musicstudio_dsp.normalise_for_storage';

/** The sidecar's error envelope: `{ error: { code, message } }`. */
interface SidecarError {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`dsp response: ${field} is not a string`);
  return value;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`dsp response: ${field} is not a finite number`);
  }
  return value;
}

function readStoredFormat(value: unknown): StoredAudioFormat {
  const text = readString(value, 'audio_format');
  if (!(STORED_AUDIO_FORMATS as readonly string[]).includes(text)) {
    // A container this side cannot name is a container the store would be told to label wrongly.
    throw new TypeError(`dsp response: audio_format ${JSON.stringify(text)} is not a stored format`);
  }
  return text as StoredAudioFormat;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`dsp response: ${field} is not a boolean`);
  return value;
}

export function createDspHttpClient(config: DspHttpClientConfig): DspClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const origin = config.baseUrl.replace(/\/+$/, '');

  async function call(task: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetchImpl(`${origin}/tasks/${task}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as unknown;

    if (!response.ok) {
      const envelope = (typeof payload === 'object' && payload !== null ? payload : {}) as SidecarError;
      const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'unknown';
      const message =
        typeof envelope.error?.message === 'string' ? envelope.error.message : 'no message';
      throw new DspTaskFailed(task, response.status, code, message);
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new TypeError(`dsp response for ${task} is not an object`);
    }
    return payload as Record<string, unknown>;
  }

  return {
    async normaliseForStorage(audio) {
      const result = await call(NORMALISE_TASK, {
        audio_base64: Buffer.from(audio).toString('base64'),
      });
      // Every field is checked rather than cast. The sidecar is our own process, but a field
      // that arrives as the wrong type is a version skew between the two shells, and the row
      // this feeds is written once and never modified (Requirement 33.7) — so it has to be right
      // before it is written, not discovered after.
      return {
        bytes: new Uint8Array(Buffer.from(readString(result.audio_base64, 'audio_base64'), 'base64')),
        audioFormat: readStoredFormat(result.audio_format),
        durationMs: readNumber(result.duration_ms, 'duration_ms'),
        sampleRate: readNumber(result.sample_rate, 'sample_rate'),
        channels: readNumber(result.channels, 'channels'),
        originalSampleRate: readNumber(result.original_sample_rate, 'original_sample_rate'),
        originalDurationMs: readNumber(result.original_duration_ms, 'original_duration_ms'),
        lengthErrorMs: readNumber(result.length_error_ms, 'length_error_ms'),
        resampled: readBoolean(result.resampled, 'resampled'),
        watermarkVersion: readNumber(result.watermark_version, 'watermark_version'),
      };
    },
  };
}
