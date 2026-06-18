interface ThuribleSpinnerProps {
  size?: number;
}

export function ThuribleSpinner({ size = 32 }: ThuribleSpinnerProps) {
  const h = size * 1.6;
  const w = size * 0.6;
  const cx = w / 2;

  // Censer body proportions
  const bodyTop = h * 0.38;
  const bodyH = h * 0.42;
  const bodyW = w * 0.7;
  const bodyX = (w - bodyW) / 2;
  const bodyRx = bodyW * 0.18;

  // Handle ring
  const ringR = w * 0.14;
  const ringY = h * 0.06;

  return (
    <span className="thurible-spinner" aria-label="AI is contemplating...">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} fill="none">
        <g className="thurible-swing" style={{ transformOrigin: `${cx}px ${ringY}px` }}>

          {/* Handle ring (pivot) */}
          <circle cx={cx} cy={ringY} r={ringR} stroke="#D4C3A3" strokeWidth="1.5" />

          {/* Left chain */}
          <line x1={cx - w * 0.22} y1={ringY + ringR} x2={cx - bodyW * 0.25} y2={bodyTop} stroke="#8B949E" strokeWidth="1" strokeDasharray="3 2" />
          {/* Right chain */}
          <line x1={cx + w * 0.22} y1={ringY + ringR} x2={cx + bodyW * 0.25} y2={bodyTop} stroke="#8B949E" strokeWidth="1" strokeDasharray="3 2" />

          {/* Chain links to lid */}
          <line x1={cx - bodyW * 0.25} y1={bodyTop} x2={cx - w * 0.08} y2={bodyTop} stroke="#8B949E" strokeWidth="1" />
          <line x1={cx + bodyW * 0.25} y1={bodyTop} x2={cx + w * 0.08} y2={bodyTop} stroke="#8B949E" strokeWidth="1" />

          {/* Lid */}
          <ellipse cx={cx} cy={bodyTop} rx={bodyW * 0.55} ry={bodyRx * 0.5} stroke="#D4C3A3" strokeWidth="1.2" />
          {/* Lid knob */}
          <circle cx={cx} cy={bodyTop - bodyRx * 0.5} r={bodyRx * 0.35} stroke="#D4C3A3" strokeWidth="1" />

          {/* Censer body */}
          <path
            d={`M${cx - bodyW * 0.5} ${bodyTop}
                L${cx - bodyW * 0.52} ${bodyTop + bodyH * 0.7}
                Q${cx - bodyW * 0.5} ${bodyTop + bodyH + bodyRx} ${cx} ${bodyTop + bodyH + bodyRx}
                Q${cx + bodyW * 0.5} ${bodyTop + bodyH + bodyRx} ${cx + bodyW * 0.52} ${bodyTop + bodyH * 0.7}
                L${cx + bodyW * 0.5} ${bodyTop}
                Z`}
            stroke="#D4C3A3" strokeWidth="1.2" fill="#D4C3A3" fillOpacity="0.08"
          />

          {/* Perforations (vents on body) */}
          {[0.35, 0.5, 0.65].map((frac, i) => (
            <g key={i}>
              <circle cx={cx - bodyW * 0.2} cy={bodyTop + bodyH * frac} r="1" fill="#D4C3A3" opacity="0.5" />
              <circle cx={cx + bodyW * 0.2} cy={bodyTop + bodyH * frac} r="1" fill="#D4C3A3" opacity="0.5" />
            </g>
          ))}

          {/* Inner glow (embers) */}
          <ellipse cx={cx} cy={bodyTop + bodyH * 0.45} rx={bodyW * 0.15} ry={bodyH * 0.15} fill="#F4A460" opacity="0.15" />

        </g>

        {/* Smoke particles (independent of swing, rising from top) */}
        <circle cx={cx - w * 0.08} cy={bodyTop - bodyRx} r="2" fill="#D4C3A3" opacity="0" className="thurible-smoke" />
        <circle cx={cx + w * 0.06} cy={bodyTop - bodyRx * 0.5} r="1.5" fill="#D4C3A3" opacity="0" className="thurible-smoke-delayed" />
        <circle cx={cx} cy={bodyTop - bodyRx * 1.2} r="2.5" fill="#D4C3A3" opacity="0" className="thurible-smoke-delayed2" />

      </svg>
    </span>
  );
}
