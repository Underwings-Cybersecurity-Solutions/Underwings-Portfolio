# ===========================================
# CRM DASHBOARD DOCKERFILE
# ===========================================

FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production with nginx
FROM nginx:alpine AS runner

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint-crm.sh
RUN chmod +x /docker-entrypoint-crm.sh

EXPOSE 5173

ENTRYPOINT ["/docker-entrypoint-crm.sh"]
CMD ["nginx", "-g", "daemon off;"]
