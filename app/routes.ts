import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("t/:slug", "routes/t.$slug.tsx"),
  route("api/telegram", "routes/api.telegram.ts"),
  route("api/cron", "routes/api.cron.ts"),
  route("preview", "routes/preview.tsx"),
] satisfies RouteConfig;
