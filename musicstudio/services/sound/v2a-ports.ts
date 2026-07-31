/**
 * Narrow outbound ports of the V2A_Service.
 *
 * Same discipline as `bgm-ports.ts` and `sfx-ports.ts`: each is the seam to something this
 * task does not build, stated in the shape Requirement 23 needs rather than waiting for it
 * to exist. Requirement 23 needs more of them than Requirements 21 and 22 did, for one
 * reason — **no V2A engine, no video decoder and no network are reachable from this
 * environment**, so every point where pixels or containers would be touched is a port with a
 * deterministic in-memory implementation behind it in `test/support/v2a-harness.ts`.
 *
 * What is *not* a port, and why: the segmentation arithmetic (23.7), the 24 fps sampling plan
 * (23.6), the onset detector (23.8), the timeline (23.15) and both invariants (23.9, 23.12)
 * are pure functions in `domain/v2a/`. Making them ports would have moved the substance of
 * this task behind a fake and left nothing testable.
 *
 * ### The five ports
 *
 * - `V2aUploadPort` — probes a staged upload into a `ProbedVideoMetadata` record, and
 *   discards it. `discard` exists because Requirement 23.4 does not merely reject a bad
 *   upload, it requires that the file is **not stored**; an effect needs a seam a test can
 *   observe. **Integration point (task 3.1)**: the DSP worker's `ffprobe` fills `probe`.
 *
 * - `V2aFrameSourcePort` — turns a `FrameSamplingPlan` for one segment into an opaque handle
 *   the engine submission references. Opaque on purpose: the product layer has no business
 *   knowing whether frames travel as PNGs, as a tensor or as a path. **Integration point
 *   (task 3.1)**: decoding lives there; this task defines only the plan it consumes.
 *
 * - `V2aSegmentPort` — the engine seam. One call per segment of 23.7, sequentially, each
 *   returning that segment's audio and the visual events detected in it. Sits between the
 *   engine result and job completion for the reason `BgmCandidatePort` does: 23.8's alignment
 *   rate and 23.9's length invariant have to be judged *before* an asset is published.
 *
 * - `V2aPreviewMuxPort` — muxes the original video and the joined audio into the preview file
 *   of 23.12, reporting the measured start offsets so `evaluatePreviewSync` can judge them.
 *   **Integration point (task 3.1)**.
 *
 * - `V2aQualityRejectionPort` — the fail-and-refund step, implemented by the *existing*
 *   `createJobQualityRejection` over `JobRuntime`. One refund path in the system: the same
 *   `CreditRefundPort` Requirements 5.7, 5.8, 6.3, 20.15, 21.18 and 22.19 all use. No second
 *   refund path is added by this task.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { JobFailure } from '../../domain/generation-job/failure';
import type { FrameSamplingPlan } from '../../domain/v2a/frame-sampling';
import type { VideoSegment } from '../../domain/v2a/segmentation';
import type { ProbedVideoMetadata } from '../../domain/v2a/video-metadata';
import type { VisualEvent } from '../../domain/v2a/visual-event-timeline';

import type { V2aQualityCriterion } from './v2a-result';

/* ------------------------------------------------------------------ uploads */

export type VideoProbeOutcome =
  | { readonly kind: 'probed'; readonly metadata: ProbedVideoMetadata }
  /**
   * The container could not be read at all.
   *
   * Distinct from a metadata record that fails validation: an unreadable file has no
   * measurements to report, so Requirement 23.4's "측정값" cannot be filled in, and the
   * rejection says which stage failed instead of inventing numbers.
   */
  | { readonly kind: 'unreadable'; readonly detail: string };

export interface V2aUploadPort {
  probe(uploadId: string): Promise<VideoProbeOutcome>;
  /** Requirement 23.4: the rejected upload is not kept. Also 23.13's deletion. */
  discard(uploadId: string): Promise<void>;
}

/* ------------------------------------------------------------------- frames */

export interface FrameSampleRequest {
  readonly uploadId: string;
  readonly segment: VideoSegment;
  /** Requirement 23.6's plan for this segment, from `domain/v2a/frame-sampling.ts`. */
  readonly plan: FrameSamplingPlan;
}

/**
 * A reference the engine submission carries instead of the frames themselves.
 *
 * `frameCount` is echoed back so the service can check that the source honoured the plan —
 * a sampler that silently returned 23 frames for a 24-frame plan would shift every event in
 * the segment by a frame, and Requirement 23.6 is the only place that could be caught.
 */
export interface SampledFrames {
  readonly handle: string;
  readonly frameCount: number;
  readonly frameRate: number;
}

export interface V2aFrameSourcePort {
  sample(request: FrameSampleRequest): Promise<SampledFrames>;
}

/* ------------------------------------------------------------------ segments */

export interface V2aSegmentRequest {
  readonly jobId: string;
  readonly accountId: string;
  readonly segment: VideoSegment;
  readonly frames: SampledFrames;
  /** Requirement 23.5: forwarded with the video when the caller supplied one. */
  readonly prompt: string | null;
  /** Requirement 23.14: this variant's seed, derived from the base. */
  readonly seed: number;
}

export interface V2aSegmentAudio {
  readonly audio: PcmAudio;
  /**
   * Visual events detected in this segment, with times relative to the **segment** start.
   *
   * Segment-relative rather than clip-relative because that is what a detector looking at one
   * segment can honestly report, and the service is the only thing that knows the segment's
   * offset. Converting there — once, in `v2a-service.ts` — is what keeps 23.15's ascending
   * clip-wide timeline correct across the overlaps of 23.7.
   */
  readonly events: readonly VisualEvent[];
}

export type V2aSegmentOutcome =
  | { readonly kind: 'produced'; readonly result: V2aSegmentAudio }
  /**
   * The engine produced no audio for this segment.
   *
   * Requirements 6.1–6.3 own this case and have already refunded the job, so the V2A_Service
   * records it and touches no credits — the same split `sfx-ports.ts` documents.
   */
  | { readonly kind: 'unproduced'; readonly failure: JobFailure };

export interface V2aSegmentPort {
  /** Requirement 23.7: called once per segment, in ascending segment order. */
  generateSegment(request: V2aSegmentRequest): Promise<V2aSegmentOutcome>;
}

/* ------------------------------------------------------------------- preview */

export interface PreviewMuxRequest {
  readonly uploadId: string;
  readonly jobId: string;
  readonly audio: PcmAudio;
}

export interface PreviewMuxResult {
  readonly previewFileId: string;
  /** Requirement 23.12: measured, not asserted. `evaluatePreviewSync` judges these. */
  readonly audioStartMs: number;
  readonly videoStartMs: number;
  /** When the preview file became readable — Requirement 23.13's `notBefore`. */
  readonly createdAtMs: number;
}

export interface V2aPreviewMuxPort {
  mux(request: PreviewMuxRequest): Promise<PreviewMuxResult>;
}

/* ----------------------------------------------------------------- rejection */

export interface V2aQualityRejection {
  readonly jobId: string;
  readonly accountId: string;
  /** Requirements 23.8, 23.9, 23.12: the criteria this variant did not meet. */
  readonly unmet: readonly V2aQualityCriterion[];
}

export interface V2aQualityRejectionResult {
  /** Credits returned. 0 when the job was never charged or was already terminal. */
  readonly refundedAmount: number;
}

export interface V2aQualityRejectionPort {
  reject(rejection: V2aQualityRejection): Promise<V2aQualityRejectionResult>;
}
