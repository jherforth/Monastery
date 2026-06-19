import { useAppStore } from '../store/useAppStore';

interface SpinnerProps {
  size?: number;
}

export function Spinner({ size = 28 }: SpinnerProps) {
  const theme = useAppStore(s => s.theme);
  const logoSrc = theme === 'monastery-dark' ? '/images/logoDark.svg' : '/images/logoLight.svg';

  const waveRings = [0, 1, 2, 3];

  return (
    <span className="bell-spinner" style={{ width: size * 2.2, height: size * 2.2 }} aria-label="AI is contemplating...">
      {waveRings.map((i) => (
        <span
          key={i}
          className="bell-wave"
          style={{ width: size * 1.8, height: size * 1.8 }}
        />
      ))}
      <span className="bell-logo">
        <img src={logoSrc} alt="Monastery" style={{ width: size, height: size }} />
      </span>
    </span>
  );
}
