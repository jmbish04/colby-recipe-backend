# MenuForge Deployment Guide

This guide walks through deploying MenuForge to Cloudflare Workers.

## Prerequisites

- Cloudflare account (free tier works)
- Node.js 18+ installed
- Git repository cloned
- Terminal/command line access

## Step 1: Install Wrangler

Wrangler is already included in package.json, but ensure it's installed:

```bash
npm install
```

## Step 2: Authenticate with Cloudflare

```bash
npx wrangler login
```

This will open a browser window for you to authorize Wrangler with your Cloudflare account.

## Step 3: Create D1 Database

```bash
npx wrangler d1 create menuforge-db
```

You'll get output like:

```
✅ Successfully created DB 'menuforge-db'!

[[d1_databases]]
binding = "DB"
database_name = "menuforge-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Action**: Copy the `database_id` value and update `wrangler.toml`.

## Step 4: Initialize Database Schema

```bash
npx wrangler d1 execute menuforge-db --file=./src/sql/schema.sql
```

## Step 5: Create KV Namespace

```bash
npx wrangler kv:namespace create KV
```

**Action**: Update `wrangler.toml` with the returned KV namespace ID.

## Step 6: Create R2 Buckets

```bash
npx wrangler r2 bucket create menuforge-snapshots
npx wrangler r2 bucket create menuforge-images
```

## Step 7: Deploy

```bash
npm run deploy
```

Your worker will be available at `https://menuforge.your-subdomain.workers.dev`

## Monitoring

View real-time logs:

```bash
npx wrangler tail
```

## Troubleshooting

See full deployment guide for common issues and solutions.
