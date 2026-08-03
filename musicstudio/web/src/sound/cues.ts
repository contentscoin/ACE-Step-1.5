/**
 * The 78 Semantic_Cues (Requirement 32.1).
 *
 * ### Why the table is the sound layer's centre and not a lookup beside it
 *
 * Requirement 32.1 does not ask for 78 sounds. It asks for 78 *mappings*, each carrying a cue
 * name, **at least one screen element identifier**, and **one sentence describing the state**. The
 * clause is about a sound never being the only channel: Requirement 32.15 then requires that the
 * named element and that sentence appear within 200 ms of the cue, and 32.16 requires that
 * success, warning and error be distinguishable without colour. A product that shipped 78 audio
 * files and no table would satisfy none of that.
 *
 * So the table is data, and it is exhaustive by construction: `SEMANTIC_CUES` is `as const`,
 * `SemanticCue` is its keys, and everything downstream — the policy, the announcer, the packs — is
 * typed by that union. A 79th cue is a change to this file and to nothing else; a cue played with
 * no entry here does not typecheck.
 *
 * ### `elements` are identifiers, not selectors
 *
 * Each entry names the element the user should look at, in a `route:element` form. They are
 * identifiers rather than CSS selectors because a selector is a claim about the current markup and
 * would rot silently; an identifier is a claim about *which thing on which screen*, which survives
 * the markup being rewritten. `test/sound/cues.test.ts` checks the form and checks that every
 * route named is a route the router actually has.
 *
 * **Honest scope**: not every element identifier here is rendered by a component today — the voice
 * and moderation screens are Phase 8. The table is complete because Requirement 32.1 is about the
 * mapping being complete, and a cue with no entry is a cue that cannot be played. Where a screen
 * does exist, `CueAnnouncer` renders the sentence beside it.
 *
 * ### Loops are a property of the state, not of the sound
 *
 * A cue is a loop when the state it describes is one the user *waits inside* — queued, running,
 * rendering, training. Requirement 32.7 then stops it when that state ends, and 32.21 refuses to
 * evict it under voice pressure. Marking a cue as a loop because its audio file happens to be
 * seamless would put a decoration where a status indicator belongs.
 */

/** Requirement 32.16's three states, plus the neutral one that is none of them. */
export const CUE_SEVERITIES = ['neutral', 'success', 'warning', 'error'] as const;
export type CueSeverity = (typeof CUE_SEVERITIES)[number];

export const CUE_KINDS = ['oneshot', 'loop'] as const;
export type CueKind = (typeof CUE_KINDS)[number];

export interface CueDefinition {
  readonly kind: CueKind;
  readonly severity: CueSeverity;
  /** Requirement 32.1: at least one. `route:element`. */
  readonly elements: readonly [string, ...string[]];
  /** Requirement 32.1: one sentence describing the state, shown by Requirement 32.15. */
  readonly status: string;
}

/**
 * The table. Grouped by subsystem, in the order a user meets them.
 *
 * The count is fixed at 78 by `CUE_COUNT` below and asserted by the test suite, so the number in
 * Requirement 32.1 is checked rather than believed.
 */
export const SEMANTIC_CUES = {
  /* ------------------------------------------------------------- generation */
  'generation.submit.accepted': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['generate:job-panel'],
    status: '생성 요청이 접수되었습니다.',
  },
  'generation.submit.rejected': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['generate:violations', 'generate:form'],
    status: '요청한 값 중 일부가 허용 범위를 벗어나 접수되지 않았습니다.',
  },
  'generation.queued': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['generate:job-panel', 'generate:queue-position'],
    status: '대기열에서 차례를 기다리는 중입니다.',
  },
  'generation.running': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['generate:job-panel', 'generate:progress'],
    status: '생성이 진행 중입니다.',
  },
  'generation.progress.milestone': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['generate:progress'],
    status: '생성 진행률이 갱신되었습니다.',
  },
  'generation.succeeded': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['generate:job-panel', 'generate:result-link'],
    status: '생성이 완료되어 결과를 확인할 수 있습니다.',
  },
  'generation.failed': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['generate:job-panel', 'generate:failure-reason'],
    status: '생성이 실패했습니다. 사유가 표시되어 있습니다.',
  },
  'generation.cancelled': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['generate:job-panel'],
    status: '생성 요청이 취소되었습니다.',
  },
  'generation.retry.started': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['generate:job-panel'],
    status: '같은 요청으로 새 작업을 시작했습니다.',
  },
  'generation.batch.completed': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['generate:job-panel'],
    status: '배치의 모든 결과가 준비되었습니다.',
  },
  'generation.mode.switched': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['generate:mode-tabs'],
    status: '생성 모드를 전환했습니다.',
  },
  'generation.seed.locked': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['generate:seed-field'],
    status: '시드를 고정했습니다. 같은 입력이면 같은 결과가 나옵니다.',
  },

  /* ----------------------------------------------------------------- credit */
  'credit.reserved': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['account:credit-balance'],
    status: '요청에 필요한 크레딧을 예약했습니다.',
  },
  'credit.charged': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['account:credit-balance'],
    status: '크레딧이 차감되었습니다.',
  },
  'credit.refunded': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['account:credit-balance'],
    status: '실패한 작업의 크레딧이 환불되었습니다.',
  },
  'credit.insufficient': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['account:credit-balance', 'generate:job-panel'],
    status: '크레딧이 부족하여 요청을 접수하지 못했습니다.',
  },
  'credit.lowBalance': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['account:credit-balance'],
    status: '남은 크레딧이 적습니다.',
  },

  /* ---------------------------------------------------------------- library */
  'library.search.results': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['library:result-count'],
    status: '검색 결과를 표시했습니다.',
  },
  'library.search.empty': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['library:empty-state'],
    status: '조건에 맞는 자산이 없습니다.',
  },
  'library.filter.applied': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['library:kind-filter'],
    status: '종류 필터를 적용했습니다.',
  },
  'library.sort.changed': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['library:sort-select'],
    status: '정렬 기준을 변경했습니다.',
  },
  'library.page.next': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['library:pager'],
    status: '다음 페이지를 불러왔습니다.',
  },
  'library.page.previous': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['library:pager'],
    status: '이전 페이지로 돌아왔습니다.',
  },
  'library.asset.renamed': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:name-field'],
    status: '자산 이름을 변경했습니다.',
  },
  'library.asset.deleted': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['library:trash-notice'],
    status: '자산을 휴지통으로 옮겼습니다. 보관 기간 안에는 복원할 수 있습니다.',
  },
  'library.asset.restored': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['library:trash-notice'],
    status: '자산을 복원했습니다.',
  },
  'library.asset.purged': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['library:trash-notice'],
    status: '자산을 영구 삭제했습니다. 되돌릴 수 없습니다.',
  },
  'library.playlist.created': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['library:playlist-list'],
    status: '재생목록을 만들었습니다.',
  },
  'library.playlist.itemAdded': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['library:playlist-list'],
    status: '재생목록에 자산을 추가했습니다.',
  },
  'library.tag.added': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:tag-list'],
    status: '태그를 추가했습니다.',
  },
  'library.tag.rejected': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['asset:tag-list'],
    status: '태그가 길이 또는 개수 제한을 넘어 추가되지 않았습니다.',
  },

  /* --------------------------------------------------------------- download */
  'download.prepared': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:download-panel'],
    status: '다운로드 파일이 준비되었습니다.',
  },
  'download.refused.plan': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['asset:download-refusal'],
    status: '무손실 다운로드는 상위 요금제에서 제공됩니다.',
  },
  'download.refused.format': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['asset:download-refusal'],
    status: '이 자산 종류가 제공하지 않는 형식입니다.',
  },
  'download.started': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['asset:download-panel'],
    status: '파일을 내려받는 중입니다.',
  },
  'download.completed': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:download-panel'],
    status: '다운로드가 끝났습니다.',
  },

  /* --------------------------------------------------------------- playback */
  'playback.play': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:transport'],
    status: '재생을 시작했습니다.',
  },
  'playback.pause': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:transport'],
    status: '재생을 일시정지했습니다.',
  },
  'playback.seek': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:waveform'],
    status: '재생 위치를 옮겼습니다.',
  },
  'playback.loop.enabled': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:transport'],
    status: '반복 재생을 켰습니다.',
  },
  'playback.loop.wrapped': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:transport'],
    status: '루프가 처음으로 돌아왔습니다.',
  },
  'playback.ended': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:transport'],
    status: '재생이 끝났습니다.',
  },
  'playback.buffering': {
    kind: 'loop',
    severity: 'warning',
    elements: ['asset:transport'],
    status: '오디오를 기다리는 중입니다.',
  },
  'playback.error': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['asset:transport'],
    status: '오디오를 재생할 수 없습니다.',
  },

  /* ---------------------------------------------------------------- sharing */
  'sharing.published': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:share-panel', 'asset:share-link'],
    status: '자산을 공개하고 링크를 발급했습니다.',
  },
  'sharing.revoked': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['asset:share-panel'],
    status: '공개를 철회했습니다. 기존 링크는 더 이상 열리지 않습니다.',
  },
  'sharing.link.copied': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['asset:share-link'],
    status: '공개 링크를 복사했습니다.',
  },
  'sharing.remix.allowed': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['asset:share-panel'],
    status: '다른 사용자의 리믹스를 허용했습니다.',
  },
  'sharing.like.added': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['explore:like-button'],
    status: '좋아요를 눌렀습니다.',
  },
  'sharing.like.repeat': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['explore:like-button'],
    status: '이미 좋아요를 누른 자산입니다. 수는 그대로입니다.',
  },
  'sharing.feed.loaded': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['explore:feed'],
    status: '탐색 피드를 불러왔습니다.',
  },

  /* --------------------------------------------------------------- timeline */
  'timeline.clip.added': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['timeline:tracks'],
    status: '클립을 배치했습니다.',
  },
  'timeline.clip.moved': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:tracks'],
    status: '클립을 옮겼습니다.',
  },
  'timeline.clip.snapped': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:tracks'],
    status: '클립이 가장 가까운 격자에 붙었습니다.',
  },
  'timeline.clip.trimmed': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:clip-inspector'],
    status: '클립을 트림했습니다. 원본 파일은 그대로입니다.',
  },
  'timeline.clip.split': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['timeline:tracks'],
    status: '클립을 둘로 나눴습니다.',
  },
  'timeline.clip.deleted': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['timeline:tracks'],
    status: '클립을 삭제했습니다.',
  },
  'timeline.clip.muted': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:clip-inspector'],
    status: '클립 음소거를 전환했습니다.',
  },
  'timeline.edit.refused': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['timeline:rejection'],
    status: '편집이 거부되었습니다. 위반한 조건이 표시되어 있습니다.',
  },
  'timeline.undo': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:history-controls'],
    status: '직전 편집을 되돌렸습니다.',
  },
  'timeline.redo': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['timeline:history-controls'],
    status: '되돌린 편집을 다시 실행했습니다.',
  },
  'timeline.mixdown.rendering': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['timeline:mixdown-panel'],
    status: '믹스다운을 렌더링하는 중입니다.',
  },
  'timeline.mixdown.completed': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['timeline:mixdown-panel'],
    status: '믹스다운이 완료되었습니다.',
  },

  /* ------------------------------------------------------ effects, mastering */
  'effects.chain.itemAdded': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['mastering:chain-editor'],
    status: '체인에 이펙트를 추가했습니다.',
  },
  'effects.chain.itemRemoved': {
    kind: 'oneshot',
    severity: 'neutral',
    elements: ['mastering:chain-editor'],
    status: '체인에서 이펙트를 제거했습니다.',
  },
  'effects.parameter.outOfRange': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['mastering:chain-violations'],
    status: '파라미터가 허용 범위를 벗어났습니다.',
  },
  'effects.preview.started': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['mastering:preview'],
    status: '이펙트 체인을 미리 듣는 중입니다. 저장되지 않습니다.',
  },
  'effects.version.saved': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['mastering:version-list'],
    status: '새 버전으로 저장했습니다.',
  },
  'effects.version.promoted': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['mastering:version-list'],
    status: '이 버전을 기본 버전으로 지정했습니다.',
  },
  'mastering.analysis.running': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['mastering:measurement'],
    status: '라우드니스와 트루 피크를 측정하는 중입니다.',
  },
  'mastering.suggestion.ready': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['mastering:suggestion-header'],
    status: '마스터링 제안이 준비되었습니다.',
  },
  'mastering.suggestion.fallback': {
    kind: 'oneshot',
    severity: 'warning',
    elements: ['mastering:suggestion-header'],
    status: '모델 제안을 받지 못해 기본 제안을 적용했습니다.',
  },
  'mastering.applied': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['mastering:chain-editor'],
    status: '마스터링 체인을 적용했습니다.',
  },

  /* -------------------------------------------------------- voice, persona */
  'voice.consent.recorded': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['voice:consent-panel'],
    status: '음성 사용 동의를 기록했습니다.',
  },
  'voice.profile.blocked': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['voice:profile-status'],
    status: '동의가 철회된 프로필이라 사용할 수 없습니다.',
  },
  'persona.training.running': {
    kind: 'loop',
    severity: 'neutral',
    elements: ['persona:training-status'],
    status: '페르소나를 학습하는 중입니다.',
  },
  'persona.training.completed': {
    kind: 'oneshot',
    severity: 'success',
    elements: ['persona:training-status'],
    status: '페르소나 학습이 끝나 선택할 수 있습니다.',
  },
  'persona.training.failed': {
    kind: 'oneshot',
    severity: 'error',
    elements: ['persona:training-status'],
    status: '페르소나 학습이 실패했습니다.',
  },
} as const satisfies Readonly<Record<string, CueDefinition>>;

export type SemanticCue = keyof typeof SEMANTIC_CUES;

/** Requirement 32.1's number, as a constant the tests check the table against. */
export const CUE_COUNT = 78;

export const SEMANTIC_CUE_NAMES = Object.keys(SEMANTIC_CUES) as readonly SemanticCue[];

export function cueDefinition(cue: SemanticCue): CueDefinition {
  return SEMANTIC_CUES[cue];
}

export function isSemanticCue(value: unknown): value is SemanticCue {
  return typeof value === 'string' && Object.hasOwn(SEMANTIC_CUES, value);
}

/** The loop cues, which Requirement 32.21 excludes from eviction and 32.7 stops on completion. */
export const LOOP_CUES: readonly SemanticCue[] = SEMANTIC_CUE_NAMES.filter(
  (cue) => SEMANTIC_CUES[cue].kind === 'loop',
);
