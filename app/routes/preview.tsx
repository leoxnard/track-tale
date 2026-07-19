import { data } from "react-router";
import { TripView, type ViewerTrip } from "./t.$slug";
import fixture from "../fixtures/preview-trip.json";

/** Dev-only design preview with fixture data — no database required. */
export function loader() {
  if (import.meta.env.PROD) throw data("Not found", { status: 404 });
  return null;
}

export default function Preview() {
  return <TripView trip={fixture as unknown as ViewerTrip} />;
}
