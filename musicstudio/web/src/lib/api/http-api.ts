/**
 * `StudioApi` over the gateway (roadmap §4.4, slice S7 — track C1).
 *
 * The seam has existed since task 7.3 and `demo-api.ts` was its only implementation; this is the
 * other one. Everything the screens ask for that the gateway serves is a route call here, and
 * everything it does not serve throws `NotServedByGateway` rather than being quietly answered
 * with something plausible — see below.
 *
 * ### The demo banner disappears by itself
 *
 * `backend.kind` is `'gateway'`, and `DemoModeBanner` renders nothing for it. That is the whole
 * mechanism: no build flag, no second source of truth about which backend is wired, and no way
 * to ship a gateway build still claiming to be a demo.
 *
 * ### What the gateway does not serve, and why this throws
 *
 * The gateway mounts auth, generation, library, playback and download. It does not mount
 * sharing (Requirement 14), the timeline (28), effects (29) or mastering (30): those services
 * exist and are tested, but none of their stores has a PostgreSQL adapter, so there is nothing
 * behind a route to mount. The honest thing for a client to do about a call it cannot make is to
 * fail in a way a screen can name. The alternative — falling back to the demo backend for those
 * calls — would put synthesised material on the same screens as real material with nothing
 * saying which was which, and that is the failure `DemoModeBanner` exists to prevent, arrived at
 * from the other direction.
 *
 * ### Audio is downloaded, not streamed, and that is a deliberate trade
 *
 * An `<audio>` element issues its own request and cannot carry an `Authorization` header, and
 * Requirement 12.6 puts the stream behind an ownership check. The two ways out are a credential
 * in the URL or fetching the bytes with the header and handing the element a `blob:`. This takes
 * the second: a URL reaches access logs, `Referer` headers and browser history, and this codebase
 * already refuses to put the engine token in a payload for weaker reasons than that. The cost is
 * real and is paid on load — a long asset arrives before it plays, and seeking is then instant
 * because the object is local. The thing that would fix it properly is a short-lived,
 * stream-scoped ticket the element may carry; that is a gateway change, not a client one.
 */

import type { AssetKind } from '@domain/asset-kind';
import { downloadFormatsFor, ruleOnDownload, type DownloadFormat } from '@domain/library/download';
import { decodeLibraryCursor, encodeLibraryCursor } from '@domain/library/cursor-codec';
import type { LibraryPage, LibraryQueryInput } from '@domain/library/query';
import type { ActiveLyricLine } from '@domain/playback/lyrics-sync';
import type { LoopPosition } from '@domain/playback/loop';
import type { Waveform } from '@domain/playback/waveform';
import type { SongGenerationRequest } from '@domain/song/request';
import type { SongFieldViolation } from '@domain/song/violation';

import type {
  AudioSource,
  DownloadFile,
  DownloadOutcome,
  StudioApi,
  SubmitOutcome,
} from './port';
import type { Session } from './session';
import type { JobState, StudioAsset, StudioJob } from './types';

/** Requirement 13.4's answer to "which plan would allow this", from `domain/credit/plan.ts`. */
const LOSSLESS_PLAN_IDS = ['creator', 'studio'] as const;

/**
 * A call the gateway has no route for.
 *
 * Named rather than a bare `Error` so a screen can tell "this deployment does not offer that"
 * from "that failed": the first is a fact about the build and the second is a fault.
 */
export class NotServedByGateway extends Error {
  constructor(readonly capability: string) {
    super(`이 배포의 게이트웨이는 ${capability} 기능을 제공하지 않습니다.`);
    this.name = 'NotServedByGateway';
  }
}

/** A gateway response that was not success, carrying the error body's own code. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface HttpApiOptions {
  /** Origin of the gateway, e.g. `http://localhost:8080`. No trailing slash needed. */
  readonly baseUrl: string;
  readonly session: Session;
  readonly fetchImpl?: typeof globalThis.fetch;
}

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly [key: string]: unknown;
  };
}

/** The gateway's job states, mapped to the screens' vocabulary. `pending` is `queued`. */
function toJobState(state: string): JobState {
  return state === 'pending' ? 'queued' : (state as JobState);
}

interface JobStatusBody {
  readonly jobId: string;
  readonly state: string;
  readonly queuePosition: number | null;
  readonly progressPercent: number | null;
  readonly estimatedCompletionAtMs: number | null;
  readonly failure: { readonly reason?: string } | null;
  readonly assetIds: readonly string[];
  readonly retryOfJobId: string | null;
}

/**
 * The asset kind a job produced, which its status does not carry.
 *
 * `JobStatusView` reports the lifecycle, not the request. The screens only ever submit songs
 * through this client — `submitSong` is the one entry point — so `song` is what a job of theirs
 * is, and inventing a lookup for a value that cannot vary would be a request per poll for a
 * constant. A client that gains a second kind of submission gains a reason to change this.
 */
const SUBMITTED_ASSET_KIND: AssetKind = 'song';

function toJob(body: JobStatusBody): StudioJob {
  return {
    jobId: body.jobId,
    state: toJobState(body.state),
    assetKind: SUBMITTED_ASSET_KIND,
    queuePosition: body.queuePosition,
    percent: body.progressPercent,
    estimatedCompletionAtMs: body.estimatedCompletionAtMs,
    failureReason: body.failure?.reason ?? null,
    retryOfJobId: body.retryOfJobId,
    assetIds: body.assetIds,
  };
}

/** The acceptance a submit returns, which is thinner than a full status. */
interface AcceptanceBody {
  readonly jobId: string;
  readonly queuePosition: number;
  readonly state: string;
  readonly estimatedCompletionAtMs: number | null;
}

function toAcceptedJob(body: AcceptanceBody): StudioJob {
  return {
    jobId: body.jobId,
    state: toJobState(body.state),
    assetKind: SUBMITTED_ASSET_KIND,
    queuePosition: body.queuePosition,
    percent: null,
    estimatedCompletionAtMs: body.estimatedCompletionAtMs,
    failureReason: null,
    retryOfJobId: null,
    assetIds: [],
  };
}

interface AssetBody {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly assetKind: AssetKind;
  readonly caption: string;
  readonly lyrics: string;
  readonly tags: readonly string[];
  readonly playCount: number;
  readonly createdAtMs: number;
  readonly isDeleted: boolean;
  readonly durationMs?: number;
  readonly sampleRate?: number;
  readonly channels?: number;
  readonly isLoop?: boolean;
}

/**
 * A gateway asset as a screen's record.
 *
 * Three fields are absent from the gateway and are absent *truthfully*, not as placeholders:
 *
 * - `timedLyrics` — Requirement 12.5's timings come from Transcription_Service and no table
 *   stores them, so no asset the gateway serves has any.
 * - `genres` — the `asset_genre` table exists and the publication path does not write it, so a
 *   generated asset genuinely has none.
 * - `aiGenerated` — `true`, and not from the wire: every asset the gateway can serve was made by
 *   an engine (Requirement 16.5), and an upload path that changes that does not exist yet.
 */
function toAsset(body: AssetBody): StudioAsset {
  return {
    id: body.id,
    ownerId: body.ownerId,
    name: body.name,
    assetKind: body.assetKind,
    caption: body.caption,
    lyrics: body.lyrics,
    tags: body.tags,
    playCount: body.playCount,
    createdAtMs: body.createdAtMs,
    isDeleted: body.isDeleted,
    durationMs: body.durationMs ?? 0,
    sampleRate: body.sampleRate ?? 0,
    channels: body.channels ?? 0,
    isLoop: body.isLoop ?? false,
    timedLyrics: null,
    genres: [],
    aiGenerated: true,
  };
}

export function createHttpApi(options: HttpApiOptions): StudioApi {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const origin = options.baseUrl.replace(/\/+$/, '');
  const { session } = options;

  /**
   * One request, with the credential attached and one retry after a refresh.
   *
   * The retry is what makes a 24-hour access token invisible to the screens: the first call
   * after it lapses gets a 401, the session exchanges the refresh token once (however many
   * requests met the 401 together), and the call is made again. A second 401 is a real one.
   */
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (token: string | null): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (token !== null) headers.set('authorization', `Bearer ${token}`);
      return fetchImpl(`${origin}${path}`, { ...init, headers });
    };

    const first = await send(session.current()?.accessToken ?? null);
    if (first.status !== 401) return first;

    const refreshed = await session.refresh();
    if (refreshed === null) return first;
    return send(refreshed);
  }

  /** Reads the gateway's `{ error: { code, message, ... } }` and throws it as one. */
  async function fail(response: Response): Promise<never> {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // A non-JSON failure — a proxy's error page, an empty 502 — still has a status.
    }
    const { code, message, ...details } = body.error ?? {};
    throw new GatewayError(
      response.status,
      typeof code === 'string' ? code : 'request_failed',
      typeof message === 'string' ? message : `게이트웨이가 ${String(response.status)}을 반환했습니다.`,
      details,
    );
  }

  async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await request(path, init);
    if (!response.ok) await fail(response);
    return (await response.json()) as T;
  }

  /** The one call whose 400 is data rather than a failure: Requirements 3.5 and 4.6. */
  async function submit(path: string, body: unknown): Promise<SubmitOutcome> {
    const response = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) return { kind: 'accepted', job: toAcceptedJob((await response.json()) as AcceptanceBody) };

    if (response.status === 400) {
      const failure = (await response.json()) as ErrorBody;
      const violations = failure.error?.violations;
      // Only a field-level refusal is `rejected`; a malformed body that the JSON schema caught
      // is a fault in this client, and reporting it as a user's violation would hide it.
      if (Array.isArray(violations)) {
        return { kind: 'rejected', violations: violations as readonly SongFieldViolation[] };
      }
    }
    return fail(response);
  }

  return {
    backend: { kind: 'gateway' },

    /* ----------------------------------------------------------- generation */

    async submitSong(songRequest: SongGenerationRequest) {
      const { mode, ...body } = songRequest;
      return submit(mode === 'simple' ? '/v1/songs/simple' : '/v1/songs/custom', body);
    },

    async jobStatus(jobId) {
      const response = await request(`/v1/generation-jobs/${encodeURIComponent(jobId)}`);
      // A job the gateway has forgotten — the store is in-memory, so a restart forgets every
      // job in flight — is `null` rather than an error: the screen's own words for it are
      // "그런 작업이 없습니다", and a thrown error would read as a fault in the poll.
      if (response.status === 404) return null;
      if (!response.ok) await fail(response);
      return toJob((await response.json()) as JobStatusBody);
    },

    async retryJob(jobId) {
      return submit(`/v1/generation-jobs/${encodeURIComponent(jobId)}/retry`, {});
    },

    async cancelJob(jobId) {
      const response = await request(`/v1/generation-jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
      });
      if (response.status === 404) return null;
      if (!response.ok) await fail(response);
      return toJob((await response.json()) as JobStatusBody);
    },

    /* -------------------------------------------------------------- library */

    async listAssets(query: LibraryQueryInput): Promise<LibraryPage> {
      const parameters = new URLSearchParams();
      if (query.pageSize !== undefined) parameters.set('pageSize', String(query.pageSize));
      if (query.sortKey !== undefined) parameters.set('sortKey', query.sortKey);
      if (query.assetKind != null) parameters.set('assetKind', query.assetKind);
      if (query.search != null && query.search !== '') parameters.set('search', query.search);
      if (query.cursor != null) parameters.set('cursor', encodeLibraryCursor(query.cursor));

      const suffix = parameters.toString();
      const page = await json<{ assets: AssetBody[]; nextCursor?: string }>(
        `/v1/library/assets${suffix === '' ? '' : `?${suffix}`}`,
      );
      return {
        assets: page.assets.map(toAsset),
        // The cursor goes back out as the triple the domain uses, so the caller hands it
        // straight to the next `listAssets` without knowing it travelled as a string.
        nextCursor: page.nextCursor === undefined ? null : decodeLibraryCursor(page.nextCursor),
      };
    },

    async findAsset(assetId) {
      const response = await request(`/v1/library/assets/${encodeURIComponent(assetId)}`);
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok) await fail(response);
      return toAsset((await response.json()) as AssetBody);
    },

    async renameAsset(assetId, name) {
      return toAsset(
        await json<AssetBody>(`/v1/library/assets/${encodeURIComponent(assetId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      );
    },

    /**
     * Requirements 13.1–13.2, 13.4, 13.9 — the ruling, before any bytes move.
     *
     * Decided here from the same domain function the gateway's own service uses, rather than by
     * asking the gateway to attempt the download and reporting its refusal. Two reasons: the
     * refusal is what the screen renders in full, and the round trip would fetch and encode a
     * file to learn whether it was allowed. `lossless` is the caller's claim about the plan; the
     * gateway is the one that enforces it, and it does so again on `fetchDownload`.
     */
    async planDownload(assetId, format, lossless): Promise<DownloadOutcome> {
      const asset = await this.findAsset(assetId);
      if (asset === null) {
        return { ruling: { allowed: false, refusal: 'download_format_unknown' } };
      }
      const ruling = ruleOnDownload({
        assetKind: asset.assetKind,
        format,
        losslessEntitled: lossless,
        losslessPlanIds: LOSSLESS_PLAN_IDS,
      });
      if (!ruling.allowed) return { ruling };
      // No size is reported: the only honest source for it is the file itself, and the panel's
      // own comment in `port.ts` is that a computed number is indistinguishable on screen from a
      // measured one. `fetchDownload` is what produces the artefact.
      return { ruling };
    },

    async fetchDownload(assetId, format): Promise<DownloadFile> {
      const response = await request(
        `/v1/library/assets/${encodeURIComponent(assetId)}/download?format=${encodeURIComponent(format)}`,
      );
      if (!response.ok) await fail(response);

      const disposition = response.headers.get('content-disposition') ?? '';
      // RFC 5987's form first — it is the one that survives a non-ASCII title.
      const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]*)"/i.exec(disposition);
      const fileName =
        extended?.[1] !== undefined
          ? decodeURIComponent(extended[1])
          : (plain?.[1] ?? `${assetId}.${format}`);

      return {
        blob: await response.blob(),
        fileName,
        // What arrived, not what was asked for. They differ exactly when the user would care.
        deliveredFormat: (response.headers.get('x-delivered-format') as DownloadFormat | null) ?? format,
      };
    },

    downloadFormatsFor(assetKind: AssetKind) {
      return downloadFormatsFor(assetKind);
    },

    /* ------------------------------------------------------------- playback */

    async waveform(assetId, buckets): Promise<Waveform> {
      return json<Waveform>(
        `/v1/playback/assets/${encodeURIComponent(assetId)}/waveform?buckets=${String(buckets)}`,
      );
    },

    async lyricLineAt(): Promise<ActiveLyricLine | null> {
      // Requirement 12.5's timings have no store, so every asset the gateway serves has none —
      // the same `null` `Playback_Service` itself returns, arrived at without a request.
      return null;
    },

    async positionAfter(assetId, elapsedMs): Promise<LoopPosition> {
      return json<LoopPosition>(
        `/v1/playback/assets/${encodeURIComponent(assetId)}/position?elapsedMs=${String(Math.max(0, Math.round(elapsedMs)))}`,
      );
    },

    async audioSource(assetId): Promise<AudioSource> {
      const response = await request(`/v1/playback/assets/${encodeURIComponent(assetId)}/stream`);
      if (!response.ok) await fail(response);
      if (typeof URL.createObjectURL !== 'function') return { url: '', release: () => {} };

      const url = URL.createObjectURL(await response.blob());
      let released = false;
      return {
        url,
        release: () => {
          if (released) return;
          released = true;
          URL.revokeObjectURL(url);
        },
      };
    },

    /* ---------------------------------- what this gateway does not serve yet */

    async setPublished() {
      throw new NotServedByGateway('공개 및 공유');
    },
    async shareState() {
      throw new NotServedByGateway('공개 및 공유');
    },
    async publicPage() {
      throw new NotServedByGateway('공개 페이지');
    },
    async feed() {
      throw new NotServedByGateway('탐색 피드');
    },
    async like() {
      throw new NotServedByGateway('좋아요');
    },
    async project() {
      throw new NotServedByGateway('타임라인');
    },
    async applyEdit() {
      throw new NotServedByGateway('타임라인');
    },
    async undo() {
      throw new NotServedByGateway('타임라인');
    },
    async redo() {
      throw new NotServedByGateway('타임라인');
    },
    async effectChain() {
      throw new NotServedByGateway('이펙트');
    },
    async setEffectChain() {
      throw new NotServedByGateway('이펙트');
    },
    async previewChain() {
      throw new NotServedByGateway('이펙트');
    },
    async versions() {
      throw new NotServedByGateway('버전');
    },
    async saveVersion() {
      throw new NotServedByGateway('버전');
    },
    async setDefaultVersion() {
      throw new NotServedByGateway('버전');
    },
    async masteringSuggestion() {
      throw new NotServedByGateway('마스터링');
    },
  };
}

/** The capabilities a gateway-backed build cannot offer, for a screen that wants to say so. */
export const GATEWAY_UNAVAILABLE_CAPABILITIES = [
  '공개 및 공유',
  '탐색 피드',
  '타임라인',
  '이펙트',
  '마스터링',
] as const;
