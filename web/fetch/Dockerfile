FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
