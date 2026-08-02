/**
 * The seams around `Timeline_Service` (design §2.2, §2.3).
 *
 * Two of them, declared as interfaces so every rule in Requirement 28 is testable without
 * PostgreSQL — the arrangement `services/sound/sfx-ports.ts` and `services/effects/ports.ts`
 * use, and the only one that works here, since no database is reachable in this environment.
 *
 * ### Why the record and the project are different types
 *
 * `TimelineProject` is the state an edit transforms and the printer serialises;
 * `TimelineProjectRecord` is what a store keeps, which is that plus the undo history and the two
 * timestamps. Requirement 28.32 excludes exactly those three from the project equivalence
 * relation, so keeping them out of `TimelineProject` makes the exclusion structural instead of a
 * rule the comparison has to remember. See `domain/timeline/project.ts`.
 *
 * ### Why the asset catalogue reports deletion rather than hiding it
 *
 * Requirement 28.36 requires a project referencing a deleted asset to remain *readable*, with the
 * affected clips flagged and their identifiers listed in the response. A port that returned `null`
 * for a deleted asset would make that impossible — the service could not tell "deleted" from
 * "never existed", and 28.36's list would be empty for exactly the case it exists to describe. So
 * `isDeleted` is a field, and `null` means genuinely absent.
 */

import type { EditHistory } from '../../domain/timeline/history';
import type { TimelineProject } from '../../domain/timeline/project';

export interface TimelineProjectRecord {
  readonly project: TimelineProject;
  /** Requirement 28.22's ledger. Excluded from Requirement 28.32's relation. */
  readonly history: EditHistory;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface TimelineProjectStore {
  insert(record: TimelineProjectRecord): Promise<void>;
  /** `null` when no project has that id. Ownership is the service's check, not the store's. */
  load(projectId: string): Promise<TimelineProjectRecord | null>;
  update(record: TimelineProjectRecord): Promise<void>;
  remove(projectId: string): Promise<void>;
  listByOwner(ownerId: string): Promise<readonly TimelineProjectRecord[]>;
}

/** What the timeline needs to know about an `Audio_Asset`; see the header on `isDeleted`. */
export interface TimelineAssetState {
  readonly assetId: string;
  readonly ownerId: string;
  readonly durationMs: number;
  /** Requirement 28.36's 삭제 표시 상태. */
  readonly isDeleted: boolean;
}

export interface TimelineAssetCatalogue {
  lookup(assetId: string): Promise<TimelineAssetState | null>;
}
