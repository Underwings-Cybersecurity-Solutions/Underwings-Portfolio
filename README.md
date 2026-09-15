# Underwings Cybersecurity Solutions - Dockerized Stack

Full-stack dockerized solution with Astro frontend, self-hosted Supabase, and custom admin dashboard.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      YOUR SERVER (Docker)                        │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │  FRONTEND   │  │  SUPABASE   │  │   ADMIN     │             │
│  │   (Astro)   │  │   STUDIO    │  │  Dashboard  │             │
│  │   :4321     │  │   :3000     │  │   :5173     │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          │                                       │
│  ┌───────────────────────┴───────────────────────────────────┐  │
│  │                    SUPABASE STACK                          │  │
│  │  PostgreSQL │ Auth │ REST API │ Storage │ Realtime        │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Prerequisites

- Docker & Docker Compose installed
- Domain with DNS configured (or use localhost for testing)
- SSL certificates (use Let's Encrypt or self-signed for testing)

### 2. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Generate secure keys
./scripts/generate-keys.sh

# Edit .env with your values
nano .env
```

### 3. Generate JWT Keys

Run this to generate secure keys for Supabase:

```bash
# Generate JWT secret (min 32 characters)
openssl rand -base64 32

# Generate anon and service role keys using the JWT secret
# Use https://supabase.com/docs/guides/self-hosting#api-keys
# Or use the provided script:
./scripts/generate-keys.sh
```

### 4. SSL Certificates

For production, use Let's Encrypt:

```bash
# Install certbot
apt install certbot

# Generate certificates
certbot certonly --standalone -d yourdomain.com -d api.yourdomain.com -d admin.yourdomain.com -d studio.yourdomain.com

# Copy to nginx/ssl
cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem nginx/ssl/
cp /etc/letsencrypt/live/yourdomain.com/privkey.pem nginx/ssl/
```

For local testing, generate self-signed:

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/privkey.pem \
  -out nginx/ssl/fullchain.pem \
  -subj "/CN=localhost"
```

### 5. Start Services

```bash
# Build and start all services
docker-compose up -d --build

# View logs
docker-compose logs -f

# Check status
docker-compose ps
```

### 6. Create Admin User

```bash
# Access Supabase Studio
open https://studio.yourdomain.com

# Or use SQL to create admin user:
docker exec -it underwings-db psql -U postgres -d underwings -c "
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, role)
VALUES (
  gen_random_uuid(),
  'admin@yourdomain.com',
  crypt('your-secure-password', gen_salt('bf')),
  NOW(),
  'authenticated'
);
"
```

## Services

| Service | URL | Description |
|---------|-----|-------------|
| Frontend | https://yourdomain.com | Main website |
| API | https://api.yourdomain.com | Supabase API |
| Admin | https://admin.yourdomain.com | Custom dashboard |
| Studio | https://studio.yourdomain.com | Supabase Studio |

## Project Structure

```
.                           # repo root (the former dockerized/ duplicate tree was removed 2026-09)
├── docker-compose.yml      # Main orchestration
├── .env                    # Environment variables
├── frontend/               # Astro frontend
│   ├── Dockerfile
│   ├── src/
│   │   ├── layouts/
│   │   ├── pages/
│   │   ├── components/
│   │   └── lib/supabase.js
│   └── public/
├── admin/                  # Custom admin dashboard
│   ├── Dockerfile
│   └── src/
├── supabase/               # Supabase configuration
│   ├── init.sql            # Database schema
│   ├── kong.yml            # API gateway config
│   └── volumes/            # Persistent data
└── nginx/                  # Reverse proxy
    ├── nginx.conf
    └── ssl/
```

## Database Schema

### Tables

- **blog_posts** - Blog articles with title, content, SEO fields
- **blog_categories** - Post categories
- **form_submissions** - Contact form submissions
- **subscribers** - Newsletter subscribers
- **site_settings** - Site configuration
- **audit_log** - Admin action logging

### Row Level Security

- Public can read published posts
- Public can submit forms
- Only authenticated users can manage content

## Common Commands

```bash
# Rebuild specific service
docker-compose up -d --build frontend

# View logs
docker-compose logs -f frontend

# Access database
docker exec -it underwings-db psql -U postgres -d underwings

# Backup database
docker exec underwings-db pg_dump -U postgres underwings > backup.sql

# Restore database
cat backup.sql | docker exec -i underwings-db psql -U postgres -d underwings

# Stop all services
docker-compose down

# Stop and remove volumes (CAUTION: deletes data)
docker-compose down -v
```

## Updating

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose up -d --build
```

## Troubleshooting

### Services not starting

```bash
# Check logs
docker-compose logs [service-name]

# Check container status
docker-compose ps

# Restart specific service
docker-compose restart [service-name]
```

### Database connection issues

```bash
# Check if database is healthy
docker exec underwings-db pg_isready -U postgres

# View database logs
docker-compose logs db
```

### SSL certificate issues

- Ensure certificates are in `nginx/ssl/`
- Check certificate permissions: `chmod 644 fullchain.pem && chmod 600 privkey.pem`
- Verify certificate validity: `openssl x509 -in nginx/ssl/fullchain.pem -text -noout`

## Security Checklist

- [ ] Change default passwords in `.env`
- [ ] Use strong JWT secret (min 32 characters)
- [ ] Enable SSL/HTTPS
- [ ] Configure firewall rules
- [ ] Set up automated backups
- [ ] Enable rate limiting
- [ ] Review RLS policies
- [ ] Restrict Studio access by IP

## License

Proprietary - Underwings Cybersecurity Solutions
# CI/CD test
