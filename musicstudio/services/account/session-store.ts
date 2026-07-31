/**
 * Session cache port (design §2.4: "Redis: 세션 캐시").
 *
 * Every protected request resolves its access token against this store, which
 * makes the store the revocation point: deleting a session invalidates a token
 * pair before its `exp`. Entries expire with the refresh token so the cache
 * never outlives the credential it describes.
 */
export interface SessionRecord {
  readonly sessionId: string;
  readonly accountId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface SessionStore {
  save(record: SessionRecord): Promise<void>;
  find(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
}
