// Real artwork when TMDB data exists; otherwise a generated "one-sheet" built from the film's
// genre palette, so the catalog still looks like a shelf of posters without any API key.
const PALETTES = {
  Horror: ['#1a0406', '#8a1218'], 'Sci-Fi': ['#04121f', '#1f7a95'], Romance: ['#2c0819', '#c9486f'], Comedy: ['#2a1a02', '#e2a623'],
  Animation: ['#08203a', '#3aa6dc'], Crime: ['#0c0d10', '#565c68'], Drama: ['#170c26', '#7143ab'], Action: ['#230a02', '#d85a1c'],
  Thriller: ['#061315', '#2e7a66'], Fantasy: ['#0b1f15', '#50a36d'], Adventure: ['#221504', '#bf7f2c'], Mystery: ['#0c0c24', '#4f4fbd'],
  Family: ['#07211f', '#35b8a2'], Music: ['#21062a', '#b653c6'], History: ['#221a0c', '#a3803f'], Sport: ['#08152a', '#3a7bd5'],
};
const hash = (s) => [...s].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381);

export function artStyle(movie) {
  const [dark, light] = PALETTES[movie.genres?.[0]] || PALETTES.Drama;
  const h = hash(movie.title || '');
  const x = 20 + (h % 60);
  const y = 10 + ((h >> 3) % 35);
  const angle = 150 + ((h >> 5) % 60);
  return {
    '--art-dark': dark,
    '--art-light': light,
    backgroundImage: `radial-gradient(circle at ${x}% ${y}%, ${light}cc 0%, ${light}33 28%, transparent 55%),
      linear-gradient(${angle}deg, ${dark} 30%, ${light}88 130%)`,
  };
}

function titleSize(title, wide) {
  const n = title.length;
  if (wide) return n > 34 ? 'xs' : n > 22 ? 's' : n > 12 ? 'm' : 'l';
  return n > 30 ? 'xs' : n > 18 ? 's' : n > 9 ? 'm' : 'l';
}

export default function Poster({ movie, wide = false, className = '', showTitle = true, eager = false }) {
  const src = wide ? movie.backdrop_url : movie.poster_url;
  if (src) {
    return (
      <div className={`art ${wide ? 'art-wide' : 'art-poster'} ${className}`}>
        <img src={src} alt={`${movie.title} ${wide ? 'still' : 'poster'}`} loading={eager ? 'eager' : 'lazy'} />
        {wide && showTitle && <span className="art-overlay-title">{movie.title}</span>}
      </div>
    );
  }
  return (
    <div className={`art art-gen ${wide ? 'art-wide' : 'art-poster'} ${className}`} style={artStyle(movie)} role="img" aria-label={`${movie.title} artwork`}>
      <span className="art-grain" />
      {showTitle && (
        <span className="art-text">
          <span className="art-meta">{movie.year}{movie.director && !wide ? ` · ${movie.director.split(/[,&]/)[0].trim()}` : ''}</span>
          <span className={`art-title t-${titleSize(movie.title, wide)}`}>{movie.title}</span>
        </span>
      )}
    </div>
  );
}
