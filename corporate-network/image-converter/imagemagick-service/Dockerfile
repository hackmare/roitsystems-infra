FROM node:26.13.0-alpine3.24

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

# Start service
CMD ["npm", "start"]
