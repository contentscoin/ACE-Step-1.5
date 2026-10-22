/**
 * `npm run engine:smoke` — make one real song with the ACE-Step engine alone.
 *
 * Reads the engine origin and token the gateway reads (`MUSICSTUDIO_ENGINE_URL`,
 * `MUSICSTUDIO_ENGINE_API_TOKEN`), runs health → submit → poll → fetch through the real
 * adapter, and writes every produced file under `--out` (default `data/smoke`).
 *
 * Exit codes: 0 a song was written; 1 the engine failed at the printed stage; 2 bad arguments.
 *
 *   npm run engine:smoke -- --duration 30 --caption "warm lo-fi piano" --thinking
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { AceEngineAdapter } from '../adapters/ace/ace-engine-adapter';
import { EngineSmokeFailure, runEngineSmoke, smokeSongRequest } from '../adapters/ace/engine-smoke';
import { createAceHttpTransport } from '../adapters/ace/transport';
import { DEFAULT_ENGINE_URL } from '../api/gateway/config';
import { JOB_TIMEOUT_MS } from '../domain/generation-job/timeout';
import { systemClock } from '../services/clock';

const POLL_INTERVAL_MS = 2_000;

const { values } = parseArgs({
  options: {
    caption: { type: 'string', default: 'calm instrumental piano, soft and warm' },
    duration: { type: 'string', default: '10' },
    thinking: { type: 'boolean', default: false },
    out: { type: 'string', default: 'data/smoke' },
  },
});

const durationSeconds = Number(values.duration);
if (!Number.isFinite(durationSeconds)) {
  process.stderr.write(`--duration must be a number of seconds, got ${values.duration}\n`);
  process.exit(2);
}

const baseUrl = process.env['MUSICSTUDIO_ENGINE_URL']?.trim() || DEFAULT_ENGINE_URL;
const apiToken = process.env['MUSICSTUDIO_ENGINE_API_TOKEN']?.trim() || undefined;

let request;
try {
  request = smokeSongRequest({ caption: values.caption, durationSeconds, thinking: values.thinking });
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const adapter = new AceEngineAdapter({
  engineId: 'ace-step-smoke',
  transport: createAceHttpTransport({ baseUrl, ...(apiToken === undefined ? {} : { apiToken }) }),
  clock: systemClock,
});

process.stdout.write(
  `engine ${baseUrl} · ${String(durationSeconds)} s · thinking ${String(values.thinking)}\n`,
);

try {
  const outcome = await runEngineSmoke({
    adapter,
    request,
    clock: systemClock,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: POLL_INTERVAL_MS,
    timeoutMs: JOB_TIMEOUT_MS,
    onProgress: (status) => {
      const percent = status.progressPercent === undefined ? '' : ` ${String(status.progressPercent)}%`;
      process.stdout.write(`  state ${String(status.state)}${percent}\n`);
    },
  });

  await mkdir(values.out, { recursive: true });
  for (const [index, result] of outcome.results.entries()) {
    const path = join(values.out, `${outcome.engineJobId}-${String(index)}.flac`);
    await writeFile(path, result.audioBuffer);
    const { bpm, keyScale, durationSeconds: length } = result.trackMetadata;
    process.stdout.write(
      `wrote ${path} (${String(result.audioBuffer.length)} bytes; ` +
        `bpm ${String(bpm)}, key ${String(keyScale)}, length ${String(length)} s)\n`,
    );
  }
  process.stdout.write(`done in ${(outcome.elapsedMs / 1000).toFixed(1)} s\n`);
} catch (error: unknown) {
  // An `EngineSmokeFailure` message already starts with its stage.
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`engine smoke failed at ${reason}\n`);
  if (error instanceof EngineSmokeFailure && error.stage === 'health') {
    process.stderr.write(`  is the engine running at ${baseUrl}? (start_api_server.bat / .sh)\n`);
  }
  process.exit(1);
}
