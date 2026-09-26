FROM node:20-alpine

WORKDIR /app

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application code
COPY . .

# Cloud standard port
EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "server.js"]
