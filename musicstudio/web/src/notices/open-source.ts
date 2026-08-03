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
  readonly url: string;
  /** Reproduced verbatim where the licence requires it. */
  readonly copyright: string;
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
];

export function noticeFor(name: string): OpenSourceNotice | undefined {
  return OPEN_SOURCE_NOTICES.find((notice) => notice.name === name);
}
