FROM node:18-alpine

WORKDIR /app

# Install ImageMagick via apk (much faster than Homebrew)
RUN apk add --no-cache imagemagick

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application
COPY index.js .

# Start service
CMD ["npm", "start"]
