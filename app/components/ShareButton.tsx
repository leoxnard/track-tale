import { useEffect, useRef, useState } from "react";
import { useMessages } from "../lib/locale";

/**
 * One icon, no words. The whole point of a trip page is that it gets passed on
 * — but the link people need is the one in the address bar, which on a phone is
 * fiddly to select and often hidden entirely.
 *
 * On a phone this opens the system share sheet, which is where the messenger
 * the link is heading to already lives. Everywhere else it copies the URL and
 * says so for a moment, because a button that appears to do nothing reads as
 * broken.
 */

/** How long the "copied" tick stays up before the icon returns. */
const CONFIRM_MS = 1800;

/** Last resort for browsers without the async clipboard (or on plain http). */
function copyByExecCommand(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  // Off-screen but still focusable — a hidden element can't be selected.
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:-9999px;opacity:0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function ShareButton({ title, className = "" }: { title: string; className?: string }) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const confirm = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
  };

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (err) {
        // Dismissing the sheet is a decision, not a failure — don't then go
        // and copy the link behind their back.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      confirm();
    } catch {
      if (copyByExecCommand(url)) confirm();
    }
  };

  return (
    <button
      type="button"
      onClick={share}
      // The label carries the meaning; nothing on screen but the glyph.
      aria-label={m.share.label}
      title={m.share.label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-trail text-pine transition hover:border-pine-soft hover:bg-trail/30 focus-visible:outline-2 focus-visible:outline-pine ${className}`}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4.5 12.5 5 5 10-11" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="m8.6 10.6 6.8-4 M8.6 13.4l6.8 4" />
        </svg>
      )}
      {/* Spoken, not shown — the tick is the visible half of the same answer. */}
      <span role="status" className="sr-only">
        {copied ? m.share.copied : ""}
      </span>
    </button>
  );
}
