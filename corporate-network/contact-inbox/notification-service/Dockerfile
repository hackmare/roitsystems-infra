FROM node:26.13.0-alpine3.24

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application
COPY index.js .

# Start service
CMD ["npm", "start"]
