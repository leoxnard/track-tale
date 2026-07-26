import { useRouteLoaderData } from "react-router";
import { DEFAULT_LOCALE, isLocale, messages, type Locale, type Messages } from "./i18n";

/**
 * The language the root loader settled on. Read through the route data rather
 * than a context provider so it is available in the error boundary and in the
 * dev-only preview route, neither of which sits under an app-level provider.
 */
export function useLocale(): Locale {
  const data = useRouteLoaderData("root") as { locale?: unknown } | undefined;
  return isLocale(data?.locale) ? data.locale : DEFAULT_LOCALE;
}

export function useMessages(): Messages {
  return messages(useLocale());
}
