/**
 * How a state is shown without colour (Requirements 31.16, 32.16).
 *
 * > THE MusicStudio SHALL 성공, 경고, 오류 상태를 서로 다른 아이콘 형상 1개와 서로 다른 상태
 * > 서술 텍스트 라벨 1개를 포함한 2개 이상의 비색상 채널로 표시한다
 *
 * ### One table, because two would drift apart in exactly the way that matters
 *
 * This started life inside `CueAnnouncer`, where it served the sound layer's cues. But the clause
 * is about **the product's** success, warning and error states, and those also appear as the
 * download refusal on the asset screen, the edit rejection on the timeline, and the chain
 * violations on the mastering screen. Each of those was a red box: colour, and only colour.
 *
 * Two tables would have been the natural shape — one for cues, one for messages — and the failure
 * mode is specific: someone unifies the icons in one of them for tidiness, the other keeps three,
 * and the criterion is half true. So there is one table, and `StatusMessage` and `CueAnnouncer`
 * both read it.
 *
 * ### The colour is the third channel, never the first
 *
 * `tone` is here because a red box *is* better than a grey one for a user who can see it. What it
 * must not be is the carrier — which is why it is the last field and why the test asserts the
 * shapes and labels are pairwise distinct while saying nothing about the colours.
 */

export const STATUS_KINDS = ['neutral', 'success', 'warning', 'error'] as const;
export type StatusKind = (typeof STATUS_KINDS)[number];

export interface StatusPresentation {
  /** Non-colour channel 1: a shape, distinct per state. */
  readonly shape: string;
  /** Non-colour channel 2: a word, distinct per state. */
  readonly label: string;
  /** The third channel. Never alone. */
  readonly tone: string;
  readonly surface: string;
}

export const STATUS_PRESENTATION: Readonly<Record<StatusKind, StatusPresentation>> = {
  neutral: { shape: '·', label: '알림', tone: 'var(--line)', surface: 'var(--surface)' },
  success: { shape: '▲', label: '성공', tone: 'var(--accent)', surface: 'var(--surface)' },
  warning: { shape: '■', label: '경고', tone: 'var(--danger)', surface: 'var(--surface)' },
  error: { shape: '●', label: '오류', tone: 'var(--danger)', surface: 'var(--danger-surface)' },
};

/** The three the clause names. `neutral` is ours and is not part of the requirement. */
export const STATED_STATUS_KINDS = ['success', 'warning', 'error'] as const;

export function statusPresentation(kind: StatusKind): StatusPresentation {
  return STATUS_PRESENTATION[kind];
}
