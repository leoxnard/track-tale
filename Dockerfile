FROM node:24-alpine AS development-dependencies-env
COPY . /app
WORKDIR /app
RUN npm ci

FROM node:24-alpine AS production-dependencies-env
COPY ./package.json package-lock.json /app/
WORKDIR /app
RUN npm ci --omit=dev

FROM node:24-alpine AS build-env
# The analytics vars have to be declared in THIS stage — the one that runs the
# build. Vite bakes `import.meta.env.VITE_*` into the bundle at build time, so a
# value that arrives only at runtime arrives too late; and `ARG` is scoped per
# stage, so a declaration in an earlier stage would not reach this one. An
# undeclared build-arg is dropped by Docker with nothing but a "one or more
# build-args were not consumed" warning — the image then builds fine and simply
# counts nothing, which is exactly the failure this comment exists to prevent.
#
# Only ever public values here: `VITE_*` ends up in the JavaScript we serve, so
# it is public by definition. A secret must not be passed this way — `ENV`
# writes it permanently into an image layer, readable by anyone with the image.
# Secrets stay runtime-only variables.
ARG VITE_UMAMI_SRC
ARG VITE_UMAMI_WEBSITE_ID
ARG VITE_UMAMI_DOMAINS
ENV VITE_UMAMI_SRC=$VITE_UMAMI_SRC
ENV VITE_UMAMI_WEBSITE_ID=$VITE_UMAMI_WEBSITE_ID
ENV VITE_UMAMI_DOMAINS=$VITE_UMAMI_DOMAINS
COPY . /app/
COPY --from=development-dependencies-env /app/node_modules /app/node_modules
WORKDIR /app
RUN npm run build

FROM node:24-alpine
COPY ./package.json package-lock.json /app/
COPY --from=production-dependencies-env /app/node_modules /app/node_modules
COPY --from=build-env /app/build /app/build
WORKDIR /app
CMD ["npm", "run", "start"]
