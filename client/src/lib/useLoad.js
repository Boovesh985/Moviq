import { useEffect, useState } from 'react';

/**
 * Loads data for the current inputs (`deps`). A response that arrives after the inputs changed
 * (say, a slow search for the previous query) is dropped, so it can't replace the newer one.
 */
export function useLoad(load, deps) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: '' });
    load()
      .then((data) => live && setState({ data, error: '' }))
      .catch((e) => live && setState({ data: null, error: e.message }));
    return () => { live = false; };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}
