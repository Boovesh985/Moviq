const I = (d, props = {}) => (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} {...p}>
    {d}
  </svg>
);

export const Play = I(<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />);
export const Info = I(<><circle cx="12" cy="12" r="9.5" /><path d="M12 11v6M12 7.5v.5" /></>);
export const Plus = I(<path d="M12 5v14M5 12h14" />);
export const Check = I(<path d="M5 12.5l4.5 4.5L19 7.5" />);
export const Heart = I(<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z" />);
export const HeartFill = I(<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z" fill="currentColor" />);
export const Search = I(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
export const Chevron = I(<path d="M9 5l7 7-7 7" />);
export const Back = I(<path d="M15 5l-7 7 7 7" />);
export const Eye = I(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>);
export const Shield = I(<><path d="M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></>);
export const Flag = I(<><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>);
export const Pencil = I(<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />);
export const Clock = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const Users = I(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5" /><circle cx="17" cy="9" r="2.5" /><path d="M16.5 14.5c2.6 0 4.5 1.7 5 4.5" /></>);
export const X = I(<path d="M6 6l12 12M18 6L6 18" />);
export const Menu = I(<path d="M4 7h16M4 12h16M4 17h16" />);
export const Shuffle = I(<path d="M4 7h3.5c3 0 4 10 7 10H20M17 14l3 3-3 3M4 17h3.5c1.2 0 2-1.5 2.8-3.4M14.5 7H20M17 4l3 3-3 3" />);
export const Star = I(<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L12 16.9l-5.3 2.7 1-5.8L3.5 9.7l5.9-.9z" fill="currentColor" stroke="none" />);
export const Tv = I(<><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 21h8" /></>);
export const Logo = () => (
  <svg viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0l10 6-10 6z" fill="currentColor" /></svg>
);
