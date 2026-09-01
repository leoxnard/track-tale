import { useEffect } from "react";
import { useLocation } from "react-router";

import {
  trackPageView,
  UMAMI_DOMAINS,
  UMAMI_SRC,
  UMAMI_WEBSITE_ID,
} from "~/lib/analytics";

/**
 * Loads the Umami tracker and reports page views by hand.
 *
 * `data-auto-track="false"` is the load-bearing part: left on, Umami hooks the
 * History API itself and sends the full URL — the secret trip slug with it.
 * Counting here means only the `scrubUrl`-ed path ever goes out.
 */
export function Analytics() {
  const location = useLocation();

  useEffect(() => {
    trackPageView(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <script
      defer
      src={UMAMI_SRC}
      data-website-id={UMAMI_WEBSITE_ID}
      data-domains={UMAMI_DOMAINS}
      data-auto-track="false"
    />
  );
}
