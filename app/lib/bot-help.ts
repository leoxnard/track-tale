import { env } from "./env.server";

/**
 * What /help and /start say, and the notice that stands in for the parts of
 * it that are switched off.
 */

/** Told to anyone reaching for live tracking while `LIVE_TRACKING` is off. */
export const LIVE_OFF_NOTICE =
  "⚫️ Live tracking is switched off on this server, so a LiveTrack link would " +
  "light up a banner nobody can see. Everything else — tracks, photos, notes — " +
  "works as usual.";

const LIVE_HELP = `*Live*
🔴 Paste a Garmin LiveTrack link → live banner for 24h
/live — what the family page is showing right now
/live off — take the banner down

`;

const HELP = `🚴 *TrackTale* — your trip journal

_Most of these open a keyboard — /trip is the hub, and every screen carries the next step as a button._

*Trip setup*
/newtrip Name | 2026-08-01 — end date optional, add it with | 2026-08-10
/trip — status, and buttons for everything below
/trips — tap a trip to switch to it (a finished one reopens)
/day — pick the day uploads land on, from every day the trip has
/day 3, /day3, /nextday, /previousday — same, without the picker

*Changing a trip*
/renametrip New name
/dates 2026-08-01 | 2026-08-12
/reminders — on or off, per trip
/regeneratelink — new family link, old one dies
/endtrip — mark it finished; pages stay, uploads stop
/deletetrip — pick one and confirm; erases it and its photos, forever

*During the trip* (everything lands on the current /day)
• Komoot share link → route imported
• GPX or FIT file → route imported (several merge into one day)
• Photos with captions → day gallery, pinned on the map
• Send a photo *as a file* (Telegram: "…" → Send as File) and its own GPS is
  used, so photos uploaded in the evening still land where you took them
• Send an edited version as a file later and I recognise the shot: it replaces
  the one already on the trip, on its own day, no /replace needed
• Live Photo? Send the still, then the video it came with, and the page plays
  the motion behind the picture — hover, scroll past it, or hold it open
• If I can't tell which photo a video belongs to, I keep it and hand you a
  button to pick the day and the photo yourself — /livephoto finds it later
• Any other text → journal entry

*Oops*
Every confirmation carries a 🗑 button — one tap takes that thing back off
/undo — remove the last thing added
Reply /delete to one of my messages — removes that one
/manage — browse the trip and delete anything on it, however old: notes,
photos, tracks, and guestbook messages the family left
/livephoto — place a Live Photo's video by hand when I couldn't work out which
  photo it belongs to, or take one off a photo it doesn't belong to
/replace — swap the picture behind a photo: pick it, send the new one. Caption,
map pin and place in the day all stay — handy after running a filter over them
/clearday — pick a day and empty it: every note, photo and track on it

${LIVE_HELP}*Plan*
• A *planned* Komoot tour link → grey plan line + progress
• GPX with caption "plan" → same
/route — cut the next 130 km of plan from where you are and send it as a GPX,
  starting at your position so it leads back to the route. Buttons under it
  change the length; /route 150 asks for one directly; send me a location
  (📎 → Location) and you get the same file with no command at all
/supermarkt — supermarkets and corner shops on the road ahead, in the order you
  reach them, with how far along and how far off the route each one is.
  /supermarkt 25 looks 25 km ahead; the 🛒 button under a /route file does the
  same from the position that file was cut from
/refreshplan — re-sync plan links after editing in Komoot
/refreshweather — fill in weather for older days
/refreshphotos — put photos on the map that arrived before their track
/compressphotos — shrink oversized photos uploaded before compression existed

*Tools*
/merge "Tour Name" url1 url2 ... — fetch Komoot tours, merge by time, send GPX
/mergegpx "Tour Name" — merge your recent GPX uploads (last hour) into one GPX

*Looking back*
/mypage — your permanent page with every trip on it
/archive — download this trip as a self-contained file

/invite — invite code for a friend (valid 7 days)
/diag — buttons not responding? this says whether Telegram is delivering taps

_Add me to a group and everyone travelling can contribute — photos and notes are credited by name._
_Invited friends run their own trips in their own chats — you don't need to be there._`;

/** A help text that lists a switched-off feature teaches the wrong thing. */
export function helpText(): string {
  return env.liveTracking ? HELP : HELP.replace(LIVE_HELP, "");
}
