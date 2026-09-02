// October mail mark — accent tile with a white envelope chevron. Used in Sidebar
// and LoginPage. The tile fill reads the *effective* accent hex (theme value, or a
// custom-CSS override of --accent) so it re-renders on theme/custom-CSS changes; the
// chevron stays white. `size` sets both width and height (the mark is square).
import { useState, useEffect } from 'react';
import { getEffectiveAccent, subscribeAccent } from '../themes.js';

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
      height={size}
      viewBox="0 0 566.929113 566.929138"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
      role="img"
      aria-label="October"
    >
      <rect fill={accent} width="566.929113" height="566.929138" />
      <polygon fill="#fff" points="283.932645 312.946266 39.975011 196.976898 39.975011 256.804909 284.155801 372.880455 284.18762 372.789757 284.222009 372.885033 526.975011 254.124428 526.975011 194.044106 283.932645 312.946266" />
    </svg>
  );
}
