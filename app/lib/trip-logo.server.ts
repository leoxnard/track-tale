/**
 * The trip logo as bytes. The shape of it is in `trip-logo.ts`; this is only
 * the rasteriser, kept apart because `@resvg/resvg-js` is a native module and
 * would drag the drawing out of the tests with it.
 */

import { Resvg } from "@resvg/resvg-js";
import { resvgFont } from "./fonts.server";
import { tripLogoSvg, type IconSize } from "./trip-logo";

export function tripLogoPng(name: string, size: IconSize): Buffer {
  return new Resvg(tripLogoSvg(name, size), {
    font: resvgFont(),
    fitTo: { mode: "width", value: size },
  })
    .render()
    .asPng();
}
