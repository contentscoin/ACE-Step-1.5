/**
 * The AI-generation notices, on every screen that shows an asset.
 *
 * Requirements 16.5 (모든 Audio_Asset의 상세 화면과 공개 페이지) and 16.13 (`dialogue` says
 * 합성 음성 as well).
 *
 * ### Why this is a component and not two spans
 *
 * The detail screen and the public page have to say the same thing, and the failure this
 * prevents is not a wrong label — it is a *missing* one. A hand-written `<span>AI 생성</span>`
 * on each screen is two places to drop it, and dropping it breaks no test that asserts on
 * data. There is one component, its labels come from `@domain/disclosure/ai-disclosure`, and
 * `test/pages/disclosure.test.tsx` renders every asset kind through both screens.
 *
 * The notices are a `<ul>` rather than loose spans because they are a list of statements about
 * the asset, and a screen reader announcing "list, 2 items" is the difference between two
 * separate facts and one run-on phrase.
 */

import type { ReactNode } from 'react';

import type { AssetKind } from '@domain/asset-kind';
import { disclosureLabel, visibleDisclosuresFor } from '@domain/disclosure/ai-disclosure';

import { chip } from '../styles/ui';

export interface DisclosureBadgesProps {
  readonly assetKind: AssetKind;
}

export function DisclosureBadges({ assetKind }: DisclosureBadgesProps): ReactNode {
  const obligations = visibleDisclosuresFor(assetKind);

  return (
    <ul
      aria-label="AI 생성 표기"
      style={{
        display: 'flex',
        gap: 6,
        flexWrap: 'wrap',
        listStyle: 'none',
        margin: 0,
        padding: 0,
      }}
    >
      {obligations.map((obligation) => (
        <li key={obligation}>
          <span style={chip} data-disclosure={obligation}>
            {disclosureLabel(obligation)}
          </span>
        </li>
      ))}
    </ul>
  );
}
