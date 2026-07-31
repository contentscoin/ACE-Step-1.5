import { describe, expect, it } from 'vitest';

import { ACE_FORMAT_INPUT_PATH } from '../../../adapters/ace/format-input';
import { satisfiesDraftStructure } from '../../../domain/lyrics/draft-structure';
import { parseLyrics } from '../../../domain/lyrics/lyrics-parser';
import {
  LYRICS_CANDIDATE_CHOICES,
  selectLyricsCandidate,
  type LyricsEnrichmentProposal,
} from '../../../services/lyrics/lyrics-assistant';
import { createLyricsHarness } from '../../support/lyrics-harness';

/**
 * Lyrics_Assistant (Requirements 8.1–8.5).
 *
 * Driven through the real `/format_input` adapter over a scripted transport, so these
 * exercise the whole path from the service's vocabulary to the wire and back.
 *
 * Requirement 8.6 has its own suite (`credit-invariance.test.ts`) because it is a
 * statement about what the assistant *cannot* do rather than about what it returns.
 */

const DRAFT = { caption: 'lo-fi study beat', lyrics: '[Verse]\nrain on the window' } as const;

/** A draft the engine could plausibly return: tagged, with a Verse and a Chorus. */
const ENGINE_LYRICS = '[Verse 1]\nquiet morning light\n\n[Chorus]\nhold on, hold on';

function proposalOf(outcome: Awaited<ReturnType<ReturnType<typeof createLyricsHarness>['assistant']['enrich']>>): LyricsEnrichmentProposal {
  if (outcome.kind !== 'proposed') throw new Error(`expected a proposal, got ${outcome.kind}`);
  return outcome.proposal;
}

describe('Requirement 8.1 — enrichment returns the seven formatted values', () => {
  it('calls the engine\'s format endpoint and returns everything it reported', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({
      caption: 'warm lo-fi study beat with vinyl crackle',
      lyrics: ENGINE_LYRICS,
      bpm: 82,
      key_scale: 'F major',
      time_signature: '4',
      duration: 165,
      vocal_language: 'en',
    });

    const proposal = proposalOf(await assistant.enrich(DRAFT));

    expect(transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH)).toBeDefined();
    expect(proposal.enriched).toEqual({
      caption: 'warm lo-fi study beat with vinyl crackle',
      lyrics: ENGINE_LYRICS,
      bpm: 82,
      keyScale: 'F major',
      timeSignature: 4,
      durationSeconds: 165,
      vocalLanguage: 'en',
    });
  });

  it('forwards the musical hints the user already chose', async () => {
    const { assistant, transport } = createLyricsHarness();
    await assistant.enrich({ ...DRAFT, bpm: 90, vocalLanguage: 'ko' });

    expect(transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH).body.param_obj).toEqual({
      bpm: 90,
      language: 'ko',
    });
  });

  it('returns the enriched lyrics parsed into sections', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: ENGINE_LYRICS });

    const proposal = proposalOf(await assistant.enrich(DRAFT));
    expect(proposal.enrichedStructure.sections.map((section) => section.type)).toEqual([
      { kind: 'recognised', name: 'Verse', ordinal: 1 },
      { kind: 'recognised', name: 'Chorus' },
    ]);
  });

  it('surfaces a Requirement 9.4 warning from the enriched lyrics', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: '[Hook]\nsing' });

    expect(proposalOf(await assistant.enrich(DRAFT)).warnings).toHaveLength(1);
  });

  it('keeps the user\'s value on the enriched side where the engine reported nothing', async () => {
    // Requirement 8.2 asks the user to compare two complete alternatives; a side with
    // holes in it is not comparable.
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: null, lyrics: null, bpm: null });

    const proposal = proposalOf(await assistant.enrich({ ...DRAFT, bpm: 77 }));
    expect(proposal.enriched.caption).toBe(DRAFT.caption);
    expect(proposal.enriched.lyrics).toBe(DRAFT.lyrics);
    expect(proposal.enriched.bpm).toBe(77);
  });
});

describe('Requirement 8.2 — both sides are presented and the user must choose', () => {
  it('returns the original unchanged alongside the enriched result', async () => {
    const { assistant } = createLyricsHarness();
    const proposal = proposalOf(await assistant.enrich({ ...DRAFT, bpm: 70 }));

    expect(proposal.original).toEqual({
      caption: DRAFT.caption,
      lyrics: DRAFT.lyrics,
      bpm: 70,
      keyScale: null,
      timeSignature: null,
      durationSeconds: null,
      vocalLanguage: null,
    });
    expect(proposal.enriched).not.toEqual(proposal.original);
  });

  it('offers no preselection: the proposal carries no chosen side', async () => {
    const { assistant } = createLyricsHarness();
    const proposal = proposalOf(await assistant.enrich(DRAFT));

    // The requirement is that the *system* does not decide, so there must be nothing
    // on the proposal a client could read as a decision.
    expect(Object.keys(proposal).sort()).toEqual([
      'enriched',
      'enrichedStructure',
      'original',
      'warnings',
    ]);
  });

  it('returns exactly the side the caller names', async () => {
    const { assistant } = createLyricsHarness();
    const proposal = proposalOf(await assistant.enrich(DRAFT));

    expect(selectLyricsCandidate(proposal, 'original')).toBe(proposal.original);
    expect(selectLyricsCandidate(proposal, 'enriched')).toBe(proposal.enriched);
    expect(LYRICS_CANDIDATE_CHOICES).toEqual(['original', 'enriched']);
  });
});

describe('Requirements 8.3, 8.4 — a topic-words-only draft', () => {
  it('asks the engine for lyrics with an empty lyrics field', async () => {
    const { assistant, transport } = createLyricsHarness();
    await assistant.draft({ topic: 'first snow, missing someone' });

    const body = transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH).body;
    expect(body.prompt).toBe('first snow, missing someone');
    expect(body.lyrics).toBe('');
  });

  it('returns a draft carrying structure tags', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'winter ballad', lyrics: ENGINE_LYRICS });

    const outcome = await assistant.draft({ topic: 'first snow' });
    if (outcome.kind !== 'drafted') throw new Error(`expected a draft, got ${outcome.kind}`);

    expect(outcome.draft.lyrics).toContain('[Verse 1]');
    expect(outcome.draft.lyrics).toContain('[Chorus]');
    expect(outcome.draft.caption).toBe('winter ballad');
  });

  it('returns the draft as canonical printed text, ready for Custom_Mode', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({
      caption: 'c',
      lyrics: '[verse]\r\n\r\nline one\r\n[CHORUS]\r\nhook',
    });

    const outcome = await assistant.draft({ topic: 't' });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');

    // Casing normalised, blank-line runs collapsed, terminators normalised.
    expect(outcome.draft.lyrics).toBe('[Verse]\nline one\n\n[Chorus]\nhook');
  });

  it('guarantees at least one Verse and one Chorus in any draft it returns', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: ENGINE_LYRICS });

    const outcome = await assistant.draft({ topic: 't' });
    if (outcome.kind !== 'drafted') throw new Error('expected a draft');
    expect(satisfiesDraftStructure(outcome.draft.structure)).toBe(true);
    expect(satisfiesDraftStructure(parseLyrics(outcome.draft.lyrics).document)).toBe(true);
  });

  it('refuses a draft that is missing a Chorus, naming what is missing', async () => {
    // Synthesising the section would mean inventing lyric content the user never asked
    // for; the engine is stochastic, so the caller can simply ask again.
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: '[Verse]\nonly a verse' });

    const outcome = await assistant.draft({ topic: 't' });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unreachable');
    expect(outcome.code).toBe('lyrics_draft_structure_incomplete');
    expect(outcome.missingSections).toEqual(['Chorus']);
  });

  it('refuses a draft with no tags at all, naming both missing sections', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: 'just some untagged lines' });

    const outcome = await assistant.draft({ topic: 't' });
    if (outcome.kind !== 'failed') throw new Error('expected a refusal');
    expect(outcome.missingSections).toEqual(['Verse', 'Chorus']);
  });

  it('does not accept a near-miss tag as a Verse', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: '[Versee]\na\n[Chorus]\nb' });

    const outcome = await assistant.draft({ topic: 't' });
    if (outcome.kind !== 'failed') throw new Error('expected a refusal');
    expect(outcome.missingSections).toEqual(['Verse']);
  });

  it('accepts an ordinalled Verse', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.setFormattedSample({ caption: 'c', lyrics: '[Verse 2]\na\n[Chorus]\nb' });
    expect((await assistant.draft({ topic: 't' })).kind).toBe('drafted');
  });
});

describe('Requirement 8.5 — an engine failure leaves the input unchanged', () => {
  it('returns the failure reason and the original input verbatim', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.failNext(ACE_FORMAT_INPUT_PATH, 500, 'format_sample failed: LLM init failed');

    const outcome = await assistant.enrich({ ...DRAFT, bpm: 70, vocalLanguage: 'ko' });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('unreachable');

    expect(outcome.code).toBe('lyrics_enrichment_engine_failed');
    expect(outcome.reason).toContain('/format_input');
    expect(outcome.original).toEqual({
      caption: DRAFT.caption,
      lyrics: DRAFT.lyrics,
      bpm: 70,
      keyScale: null,
      timeSignature: null,
      durationSeconds: null,
      vocalLanguage: 'ko',
    });
  });

  it('invents no value for a field the user left empty', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.failNext(ACE_FORMAT_INPUT_PATH, 503);

    const outcome = await assistant.enrich(DRAFT);
    if (outcome.kind !== 'failed') throw new Error('expected a failure');
    expect(outcome.original.bpm).toBeNull();
    expect(outcome.original.keyScale).toBeNull();
  });

  it('reports a drafting failure the same way', async () => {
    const { assistant, transport } = createLyricsHarness();
    transport.failNext(ACE_FORMAT_INPUT_PATH, 502, 'engine down');

    const outcome = await assistant.draft({ topic: 'a topic' });
    if (outcome.kind !== 'failed') throw new Error('expected a failure');
    expect(outcome.code).toBe('lyrics_enrichment_engine_failed');
    // The topic is what the user typed; it comes back as the caption, unchanged.
    expect(outcome.original.caption).toBe('a topic');
    expect(outcome.original.lyrics).toBe('');
  });
});
