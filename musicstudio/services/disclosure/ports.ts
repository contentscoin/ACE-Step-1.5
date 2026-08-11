/**
 * The one seam the disclosure service needs (Requirement 16.6).
 *
 * Everything else about disclosure is a pure function of the asset's kind and lives in
 * `domain/disclosure/ai-disclosure.ts`. What is not pure is the audio: whether the stored
 * bytes actually carry the inaudible mark is a question only the DSP worker can answer, and
 * `dsp/src/musicstudio_dsp/watermark.py` is the implementation this describes.
 */

/** What `detect_watermark` reports, field for field. */
export interface WatermarkDetection {
  readonly detected: boolean;
  /** Standard-normal under the null — see the Python module for what that buys. */
  readonly statistic: number;
  /** The scheme version whose carrier matched, or `null` when none did. */
  readonly version: number | null;
}

export interface WatermarkPort {
  /**
   * Read the mark back out of a stored asset.
   *
   * Takes the object key rather than the bytes: a stored asset is minutes of audio, and a
   * port that took bytes would make every verification pull the whole object through this
   * process to hand it straight back to the worker.
   */
  detect(objectKey: string): Promise<WatermarkDetection>;
}
