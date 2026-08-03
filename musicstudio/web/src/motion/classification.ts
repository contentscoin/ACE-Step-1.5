/**
 * `Motion_Classification_Table` (Requirements 31.1, 31.9, 31.10, 31.18; design §8.2).
 *
 * Every animated component is classified as **state-transferring** or **decorative**, exactly once,
 * and 31.18 makes the count of unclassified animated components zero — an invariant, so it is a
 * test over this table rather than a review habit.
 *
 * ### Why the classification is the whole of the reduced-motion behaviour
 *
 * Under `prefers-reduced-motion: reduce`, 31.9 says a decorative animation plays **zero frames** and
 * jumps to its end state, while 31.10 says a state-transferring one keeps running but within
 * **200 ms**. Those are different because the two kinds carry different information: a decorative
 * flourish tells the user nothing, so removing it costs nothing; a state transition is *how the
 * user knows something changed*, and deleting it would leave them guessing whether their click
 * registered.
 *
 * That is also why a component cannot be both. If it could, the reduced-motion path would need a
 * rule for the overlap, and the honest rule — "does this animation tell the user something?" — is
 * the classification itself.
 *
 * ### The four categories of Requirement 31.1
 *
 * 31.1 requires at least one registry component in each of *entry transition*, *hover interaction*,
 * *text reveal* and *loading indicator*, and requires that **100%** of animated components in those
 * categories come from the pinned registry listing. `category` records which one each entry serves,
 * so the invariant is checkable rather than asserted; `amicroComponent` names the registry entry it
 * was installed from, and `src/components/amicro/registry.json` is the listing it must appear in.
 */

export const MOTION_PURPOSES = ['state_transfer', 'decorative'] as const;

export type MotionPurpose = (typeof MOTION_PURPOSES)[number];

/** Requirement 31.1's four categories. */
export const MOTION_CATEGORIES = ['entry', 'hover', 'text', 'loading'] as const;

export type MotionCategory = (typeof MOTION_CATEGORIES)[number];

export interface MotionClassification {
  /** The component's own name, as exported. */
  readonly component: string;
  readonly category: MotionCategory;
  readonly purpose: MotionPurpose;
  /** The `@amicro` registry entry this component was installed from (Requirement 31.1). */
  readonly amicroComponent: string;
  /** Why it is classified this way — the sentence a reviewer would otherwise have to guess. */
  readonly rationale: string;
}

/**
 * The table.
 *
 * Adding an animated component without adding a row here fails
 * `test/motion/classification.test.ts`, which walks the component directory rather than trusting
 * this list to be complete — the invariant of 31.18 is about the *components*, not about the table.
 */
export const MOTION_CLASSIFICATION_TABLE: readonly MotionClassification[] = [
  {
    component: 'EnterTransition',
    category: 'entry',
    purpose: 'state_transfer',
    amicroComponent: 'fade-slide-enter',
    rationale:
      '새 화면·패널이 나타났다는 사실 자체를 전달한다. 제거하면 콘텐츠가 순간 이동해 무엇이 바뀌었는지 알 수 없다.',
  },
  {
    component: 'HoverLift',
    category: 'hover',
    purpose: 'state_transfer',
    amicroComponent: 'hover-lift',
    rationale:
      '포인터가 어떤 대상 위에 있는지를 알린다. 키보드 포커스와 함께 대화형 요소의 현재 대상을 가리키는 채널이다.',
  },
  {
    component: 'TextReveal',
    category: 'text',
    purpose: 'decorative',
    amicroComponent: 'text-reveal',
    rationale:
      '글자가 차례로 드러나는 것은 읽는 사람에게 아무것도 알려주지 않는다. 감소된 모션에서는 완성된 문장을 즉시 보여준다.',
  },
  {
    component: 'WaveformLoader',
    category: 'loading',
    purpose: 'state_transfer',
    amicroComponent: 'waveform-loader',
    rationale:
      'Generation_Job이 대기·진행 중이라는 상태를 전달한다(Req 31.6). 멈춘 표시는 작업이 멈췄다는 뜻으로 읽힌다.',
  },
];

export function classificationOf(component: string): MotionClassification | undefined {
  return MOTION_CLASSIFICATION_TABLE.find((entry) => entry.component === component);
}

export function componentsInCategory(category: MotionCategory): readonly MotionClassification[] {
  return MOTION_CLASSIFICATION_TABLE.filter((entry) => entry.category === category);
}

/** Requirement 31.18's invariant, as a predicate over a set of animated components. */
export function unclassifiedComponents(animated: readonly string[]): readonly string[] {
  return animated.filter((component) => classificationOf(component) === undefined);
}
