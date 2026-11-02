FROM node:22.23.4-alpine3.24
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js .
CMD ["node", "index.js"]
