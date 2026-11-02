FROM node:26.13.0-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94

WORKDIR /app

# ImageMagick plus its JPEG and WebP coders (Alpine packages each format separately).
# No SVG coder: SVG output is built in index.js, and SVG input is not accepted.
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp

# Restrictive ImageMagick policy: only the coders above, resource limits.
COPY policy.xml /etc/ImageMagick-7/policy.xml

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application
COPY index.js .

USER node

# Start service
CMD ["npm", "start"]
