import { INTERNAL_CUT_SITE_STYLE, internalCutSiteBadgeDomStyle } from '@waypoint/sequence-utils';

export function InternalCutSiteBadge() {
  return (
    <span aria-hidden data-testid="internal-cut-site-badge" style={internalCutSiteBadgeDomStyle()}>
      {INTERNAL_CUT_SITE_STYLE.badgeChar}
    </span>
  );
}
