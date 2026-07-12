// Quiet decorative oscilloscope-style trace line. Pure CSS animation (see
// .ambient-trace-path in globals.css) so it needs no client JS and already
// respects prefers-reduced-motion via a plain media query.
export function AmbientTrace({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 800 60"
      preserveAspectRatio="none"
      className={className}
    >
      <path
        d="M0,30 L60,30 L75,10 L95,50 L115,15 L135,30 L200,30 L215,22 L230,38 L245,30 L340,30 L358,8 L376,52 L394,30 L500,30 L512,24 L524,36 L536,30 L640,30 L655,14 L672,46 L689,30 L800,30"
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.22"
      />
      <path
        className="ambient-trace-path"
        d="M0,30 L60,30 L75,10 L95,50 L115,15 L135,30 L200,30 L215,22 L230,38 L245,30 L340,30 L358,8 L376,52 L394,30 L500,30 L512,24 L524,36 L536,30 L640,30 L655,14 L672,46 L689,30 L800,30"
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="40 200"
      />
    </svg>
  );
}
