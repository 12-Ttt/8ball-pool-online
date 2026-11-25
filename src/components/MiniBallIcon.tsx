import React from 'react';
import { BALL_STYLES } from '../game/constants';

interface MiniBallIconProps {
  ballId: number;
  pocketed?: boolean;
  highlight?: boolean;
  size?: number;
}

export const MiniBallIcon: React.FC<MiniBallIconProps> = ({
  ballId,
  pocketed = false,
  highlight = false,
  size = 24,
}) => {
  const style = BALL_STYLES[ballId];
  if (!style) return null;

  const clipId = `mini-ball-clip-${ballId}-${size}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      className={`shrink-0 transition-opacity duration-200 ${
        pocketed ? 'opacity-20 grayscale' : 'opacity-100'
      }`}
      aria-label={`${style.label}${pocketed ? '（已进袋）' : ''}`}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="14" cy="14" r="12" />
        </clipPath>
        <radialGradient id={`${clipId}-shade`} cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="50%" stopColor="rgba(255,255,255,0)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.42)" />
        </radialGradient>
      </defs>

      {highlight && !pocketed && (
        <circle
          cx="14"
          cy="14"
          r="13.2"
          fill="none"
          stroke="#d4a853"
          strokeWidth="1.5"
        />
      )}

      <g clipPath={`url(#${clipId})`}>
        {style.isStripe ? (
          <>
            <rect x="2" y="2" width="24" height="24" fill="#f5f1e6" />
            <rect x="2" y="7.2" width="24" height="13.6" fill={style.color} />
          </>
        ) : (
          <rect x="2" y="2" width="24" height="24" fill={style.color} />
        )}

        <circle cx="14" cy="14" r="5.6" fill="#faf7f0" />
        <text
          x="14"
          y="14.5"
          textAnchor="middle"
          dominantBaseline="central"
          fill="#141518"
          fontSize={ballId >= 10 ? '7.8' : '8.8'}
          fontWeight="700"
          fontFamily="Plus Jakarta Sans, sans-serif"
        >
          {ballId}
        </text>
        <circle cx="14" cy="14" r="12" fill={`url(#${clipId}-shade)`} />
      </g>

      <circle
        cx="14"
        cy="14"
        r="12"
        fill="none"
        stroke={ballId === 8 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.32)'}
        strokeWidth="0.9"
      />
    </svg>
  );
};
