# Playwright's official image ships Chromium + deps. We build our TS on top.
FROM mcr.microsoft.com/playwright:v1.48.0-noble

WORKDIR /app
COPY package.json package-lock.json* ./
# Full install: typescript (a devDependency) is needed to compile.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
