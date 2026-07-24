// October logomark — two horizontal bars, used in Sidebar and LoginPage.
// Exact geometry from the October brand mark (410×182): top bar full width,
// bottom bar 80% width, both h=68 with a 46 gap, bars flush to top/bottom edges.
// Reads the *effective* accent hex (theme value, or a custom-CSS override of
// --accent) so the bars are October gold and re-render on theme/custom-CSS changes.
// `size` sets the WIDTH; height follows the mark's natural aspect ratio.
import { useState, useEffect } from 'react';
import { getEffectiveAccent, subscribeAccent } from '../themes.js';

const AR = 182 / 410; // native height / width

export default function LogoMark({ size = 40 }) {
  const [accent, setAccent] = useState(getEffectiveAccent);
  useEffect(() => {
    // Re-sync in case the accent changed between render and this effect, then
    // subscribe for future theme/custom-CSS changes (cleanup unsubscribes).
    setAccent(getEffectiveAccent());
    return subscribeAccent(setAccent);
  }, []);

  return (
    <svg
      width={size}
      height={size * AR}
      viewBox="0 0 410 182"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
      role="img"
      aria-label="October"
    >
      <g fill={accent}>
        <rect x="0" y="0"   width="410" height="68" />
        <rect x="0" y="114" width="328" height="68" />
      </g>
    </svg>
  );
}
