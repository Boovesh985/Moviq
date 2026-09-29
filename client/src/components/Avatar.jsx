export default function Avatar({ user, size = 32 }) {
  const name = user?.display_name || user?.username || '?';
  return (
    <span className="avatar" style={{ '--h': user?.avatar_hue ?? 200, '--size': `${size}px` }} aria-hidden="true">
      {name[0]}
    </span>
  );
}
