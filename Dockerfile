FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY scripts/keepalive.mjs scripts/siaa.mjs scripts/ui.html scripts/
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/keepalive.mjs"]
