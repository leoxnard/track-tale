import { redirect } from "react-router";
import type { Route } from "./+types/lang";
import { DEFAULT_LOCALE, isLocale, langCookie } from "../lib/i18n";

/** Only ever bounce back to a path on this site, never to whatever was posted. */
function safePath(value: unknown): string {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/";
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const wanted = form.get("lang");
  const locale = isLocale(wanted) ? wanted : DEFAULT_LOCALE;

  return redirect(safePath(form.get("to")), {
    headers: { "Set-Cookie": langCookie(locale) },
  });
}

/** Nothing to see here — the language is set by posting to this route. */
export function loader() {
  return redirect("/");
}
