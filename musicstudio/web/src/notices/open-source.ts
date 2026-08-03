/**
 * Open-source notices (Requirement 31.17, and design §9.6's licence story).
 *
 * 31.17 requires Amicro's licence notice to appear on the product's open-source notice screen. It
 * is data rather than markup so the screen renders a list and the *list* is what a test asserts —
 * a notice hand-written into JSX is a notice that can be deleted in a refactor without anything
 * noticing.
 *
 * The Amicro entry is here even though its components are vendored: copying source under a
 * permissive licence is what a component registry is for, and the copy carries the same obligation
 * the dependency would have. Dropping the notice because the code now lives in our tree would be
 * exactly the mistake the criterion exists to prevent.
 */

export interface OpenSourceNotice {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  /** Where a reader goes to find it: a project URL, or a source path for our own work. */
  readonly url: string;
  /** Reproduced verbatim where the licence requires it. */
  readonly copyright: string;
  /**
   * Our own work rather than a dependency.
   *
   * Requirement 32.20 asks for the interface sounds' licence on this screen, and those sounds are
   * synthesised here rather than licensed in. A first-party entry has no upstream project to link
   * to, so it points at the source instead — which is why the URL check in the test is per kind
   * rather than one rule for everything.
   */
  readonly firstParty?: true;
}

export const OPEN_SOURCE_NOTICES: readonly OpenSourceNotice[] = [
  {
    name: 'Amicro',
    version: 'v1.0.1',
    license: 'MIT',
    url: 'https://github.com/Subhan-code/Amicro--Micro-transitions-',
    copyright: 'Copyright (c) Syed Subhan',
  },
  {
    name: 'React',
    version: '19',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
    copyright: 'Copyright (c) Meta Platforms, Inc. and affiliates.',
  },
  {
    name: 'Motion',
    version: '12',
    license: 'MIT',
    url: 'https://github.com/motiondivision/motion',
    copyright: 'Copyright (c) 2018 Framer B.V.',
  },
  {
    name: 'Tailwind CSS',
    version: '4',
    license: 'MIT',
    url: 'https://github.com/tailwindlabs/tailwindcss',
    copyright: 'Copyright (c) Tailwind Labs, Inc.',
  },
  {
    name: 'Zustand',
    version: '5',
    license: 'MIT',
    url: 'https://github.com/pmndrs/zustand',
    copyright: 'Copyright (c) 2019 Paul Henschel',
  },
  {
    name: 'TanStack Query',
    version: '5',
    license: 'MIT',
    url: 'https://github.com/TanStack/query',
    copyright: 'Copyright (c) 2021-present Tanner Linsley',
  },
  {
    // Requirement 32.20: the interface sounds' licence, on the open-source notice screen.
    //
    // The entry is here even though nothing was licensed *in*: the cues are synthesised by
    // `src/sound/packs.ts` rather than shipped as files, and saying so is what the clause is for.
    // A reader looking for the sound assets' provenance should find this rather than nothing, and
    // if a designed pack is ever licensed, this line is where it goes.
    name: 'MusicStudio 인터페이스 사운드',
    version: '1',
    license: '자체 제작 (오디오 파일 없음 · 오실레이터 합성)',
    url: 'musicstudio/web/src/sound/packs.ts',
    firstParty: true,
    copyright: 'Copyright (c) MusicStudio',
  },
];

export function noticeFor(name: string): OpenSourceNotice | undefined {
  return OPEN_SOURCE_NOTICES.find((notice) => notice.name === name);
}
