import { Form, useLocation } from "react-router";
import { LOCALES, LOCALE_NAMES } from "../lib/i18n";
import { useLocale, useMessages } from "../lib/locale";

/**
 * Two words in the footer. A plain form post so it works before hydration and
 * lands back on the same page with the choice stored in a cookie.
 */
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const locale = useLocale();
  const m = useMessages();
  const { pathname, search } = useLocation();

  return (
    <Form method="post" action="/lang" className={`flex items-center gap-2 ${className}`}>
      <input type="hidden" name="to" value={pathname + search} />
      <span className="sr-only">{m.language.label}</span>
      {LOCALES.map((option) => {
        const current = option === locale;
        return (
          <button
            key={option}
            type="submit"
            name="lang"
            value={option}
            aria-current={current ? "true" : undefined}
            className={
              current
                ? "font-bold text-pine"
                : "underline underline-offset-2 hover:text-pine focus-visible:outline-2 focus-visible:outline-pine"
            }
          >
            {LOCALE_NAMES[option]}
          </button>
        );
      })}
    </Form>
  );
}
