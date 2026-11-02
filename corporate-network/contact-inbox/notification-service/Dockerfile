FROM node:24.22.2-alpine3.24

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application
COPY index.js .

# Start service
CMD ["npm", "start"]
