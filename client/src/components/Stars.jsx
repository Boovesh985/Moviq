import { useState } from 'react';

/** Read-only rating, Letterboxd style: ★★★½ */
export function Stars({ value, className = '' }) {
  if (value == null) return null;
  const full = Math.floor(value);
  const half = value - full >= 0.5;
  return (
    <span className={`stars ${className}`} aria-label={`${value} out of 5 stars`}>
      {'★'.repeat(full)}{half ? '½' : ''}
    </span>
  );
}

/** Half-star input: ten hit zones over five stars. Click the current value again to clear. */
export function StarInput({ value, onChange, size = 34 }) {
  const [hover, setHover] = useState(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="star-input" style={{ '--size': `${size}px` }} onMouseLeave={() => setHover(null)} role="radiogroup" aria-label="Rating">
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = shown >= n ? 1 : shown >= n - 0.5 ? 0.5 : 0;
        return (
          <span key={n} className="star-slot">
            <span className="star-bg">★</span>
            <span className="star-fg" style={{ width: `${fill * 100}%` }}>★</span>
            {[n - 0.5, n].map((v) => (
              <button
                key={v}
                type="button"
                className={v % 1 ? 'hit-left' : 'hit-right'}
                role="radio"
                aria-checked={value === v}
                aria-label={`${v} stars`}
                onMouseEnter={() => setHover(v)}
                onFocus={() => setHover(v)}
                onBlur={() => setHover(null)}
                onClick={() => onChange(value === v ? null : v)}
              />
            ))}
          </span>
        );
      })}
    </div>
  );
}
