// October mail mark — used in the Sidebar and LoginPage. If a custom app logo has been
// uploaded (Settings → Appearance), it is shown here; otherwise the built-in mark (a gold
// tile with a white envelope chevron) is used. This is the in-app logo only — it does NOT
// change the favicon / PWA app icon. The built-in tile fill is the CSS --accent token so it
// follows the theme. `size` sets both width and height (the mark is square).
import { useState, useEffect } from 'react';
import { useStore } from '../store/index.js';

export default function LogoMark({ size = 40 }) {
  const brandLogoVersion = useStore(s => s.brandLogoVersion);
  // Probe the uploaded logo; show it only once it actually loads, so there is no
  // broken-image flash when none is set (the built-in mark shows until then / instead).
  const [customOk, setCustomOk] = useState(false);
  useEffect(() => { setCustomOk(false); }, [brandLogoVersion]);

  return (
    <span style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      {!customOk && (
        <svg
          width={size}
          height={size}
          viewBox="0 0 566.929113 566.929138"
          xmlns="http://www.w3.org/2000/svg"
          style={{ flexShrink: 0 }}
          role="img"
          aria-label="October"
        >
          <rect fill="var(--accent)" width="566.929113" height="566.929138" />
          <polygon fill="#fff" points="283.932645 312.946266 39.975011 196.976898 39.975011 256.804909 284.155801 372.880455 284.18762 372.789757 284.222009 372.885033 526.975011 254.124428 526.975011 194.044106 283.932645 312.946266" />
        </svg>
      )}
      <img
        src={`/api/branding/logo?v=${brandLogoVersion}`}
        width={size}
        height={size}
        alt="October"
        onLoad={() => setCustomOk(true)}
        onError={() => setCustomOk(false)}
        style={{
          width: size, height: size, objectFit: 'contain', flexShrink: 0,
          display: customOk ? 'block' : 'none',
        }}
      />
    </span>
  );
}
