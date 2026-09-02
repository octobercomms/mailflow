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
      viewBox="0 0 567.028442 566.929134"
      xmlns="http://www.w3.org/2000/svg"
      style={{ flexShrink: 0 }}
      role="img"
      aria-label="October"
    >
      <rect fill={accent} width="567.028442" height="566.929134" />
      <polygon fill="#fff" points="284.047058 242.579784 0 126.610424 0 186.438427 284.306885 302.513988 284.343933 302.42329 284.383972 302.518566 567.028442 183.757946 567.028442 123.677624 284.047058 242.579784" />
    </svg>
  );
}
