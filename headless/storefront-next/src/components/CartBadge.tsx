'use client';

import { useEffect, useRef, useState } from 'react';

/** The header cart count. It pulses when the count goes up so the buyer sees an add land. */
export function CartBadge({ count }: { count: number }) {
  const previous = useRef(count);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (count > previous.current) {
      setBump(true);
      const timer = window.setTimeout(() => setBump(false), 500);
      previous.current = count;
      return () => window.clearTimeout(timer);
    }
    previous.current = count;
  }, [count]);
  return (
    <span className="cart-count" data-testid="sf-cart-count" data-count={count} data-bump={bump} aria-hidden="true">
      {count}
    </span>
  );
}
