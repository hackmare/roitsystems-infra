FROM node:18-alpine

WORKDIR /app

# ImageMagick plus its JPEG and WebP coders (Alpine packages each format separately).
# No SVG coder: SVG output is built in index.js, and SVG input is not accepted.
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application
COPY index.js .

# Start service
CMD ["npm", "start"]
