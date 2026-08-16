import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("t/:slug", "routes/t.$slug.tsx"),
  route("t/:slug/downloads", "routes/t.$slug.downloads.tsx"),
  route("t/:slug/download/:file", "routes/t.$slug.download.$file.ts"),
  route("t/:slug/packing", "routes/t.$slug.packing.tsx"),
  route("traveler/:slug", "routes/traveler.$slug.tsx"),
  route("lang", "routes/lang.ts"),
  route("api/telegram", "routes/api.telegram.ts"),
  route("api/cron", "routes/api.cron.ts"),
  route("api/inbound-email", "routes/api.inbound-email.ts"),
  route("preview", "routes/preview.tsx"),
] satisfies RouteConfig;
