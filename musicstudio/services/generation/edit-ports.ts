/**
 * Narrow outbound ports of the Edit_Task path.
 *
 * Both are seams to the Library_Service (task 5.1), declared here in the shape this
 * task needs rather than waiting for it, following the same discipline as
 * `ports.ts`:
 *
 * - `EditSourceAudioPort` answers "what is the audio behind this asset id" —
 *   container format, length, byte size and the location the engine can open. The
 *   first three are what Requirements 7.10/7.11 judge; the fourth is what
 *   `src_audio_path` carries. **Integration point**: the Library_Service resolves the
 *   stored object into an engine-reachable path (`validate_audio_path` in
 *   `acestep/api/http/release_task_audio_paths.py` accepts a temp-directory or
 *   relative path), and enforces that the asset belongs to the caller.
 * - `EditLineagePort` reads and appends lineage edges. It is deliberately *not* a
 *   second lineage mechanism: the invariants stay in `domain/lineage/invariants.ts`
 *   (task 1.1) and the enforcement in `db/migrations/0006_lineage_invariants.sql`, so
 *   this port only moves edges between them.
 */

import type { LineageEdge, LineageGraph } from '../../domain/lineage/graph';

export interface EditSourceAudioQuery {
  readonly accountId: string;
  readonly assetId: string;
}

/** What the Library_Service reports about an asset an edit wants to start from. */
export interface EditSourceAudioRecord {
  readonly assetId: string;
  readonly format: string;
  readonly durationSeconds: number;
  readonly sizeBytes: number;
  /** Location the engine process can itself open, carried as `src_audio_path`. */
  readonly enginePath: string;
}

export interface EditSourceAudioPort {
  /** `undefined` when no such asset exists for this account. */
  find(query: EditSourceAudioQuery): Promise<EditSourceAudioRecord | undefined>;
}

export interface EditLineagePort {
  /**
   * Existing lineage around these assets, enough to check the invariants against.
   *
   * The ancestors of each id are what the acyclicity and depth rules need; an
   * implementation returning the whole graph is also correct, just slower.
   */
  graphFor(assetIds: readonly string[]): Promise<LineageGraph>;
  /** Appends every edge or none (Requirement 19.13). */
  append(edges: readonly LineageEdge[]): Promise<void>;
}
