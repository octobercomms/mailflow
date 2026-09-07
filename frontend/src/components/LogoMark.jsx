// October mail mark — a gold tile with a white envelope chevron, used in the
// Sidebar and LoginPage. The tile fill is the CSS --accent token (the bold
// brand gold), so it matches the favicon / app icon and follows the theme —
// including a theme-scoped remap such as October Studio's dark sidebar rail —
// with no JS. `size` sets both width and height (the mark is square).
export default function LogoMark({ size = 40 }) {
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
      <rect fill="var(--accent)" width="566.929113" height="566.929138" />
      <polygon fill="#fff" points="283.932645 312.946266 39.975011 196.976898 39.975011 256.804909 284.155801 372.880455 284.18762 372.789757 284.222009 372.885033 526.975011 254.124428 526.975011 194.044106 283.932645 312.946266" />
    </svg>
  );
}
