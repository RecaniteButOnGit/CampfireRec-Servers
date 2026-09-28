import { resolve } from 'node:path'

import { FileAssets } from './assets-adapter'
import { SQLiteD1 } from './d1-adapter'
import { RedisKV } from './kv-adapter'
import { NodeNotificationsHub } from './notifications-adapter'
import { S3Bucket } from './r2-adapter'

const repo = resolve(import.meta.dirname, '../../..')
const secret = (value: string | undefined) => ({ get: async () => value ?? '' })

function bucket(prefix: 'CDN' | 'IMG'): S3Bucket | undefined {
  const name = process.env[`${prefix}_BUCKET`]
  const endpoint = process.env[`${prefix}_S3_ENDPOINT`]
  const accessKeyId = process.env[`${prefix}_S3_ACCESS_KEY_ID`]
  const secretAccessKey = process.env[`${prefix}_S3_SECRET_ACCESS_KEY`]
  const region = process.env[`${prefix}_S3_REGION`]
  return name && endpoint && accessKeyId && secretAccessKey && region
    ? new S3Bucket(name, { endpoint, accessKeyId, secretAccessKey, region }) : undefined
}

export function buildEnvironment(db: SQLiteD1) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required')
  const redis = new RedisKV(process.env.REDIS_URL, 'player-settings')
  const cdn = bucket('CDN')
  const img = bucket('IMG')
  const base = {
    DB: db as unknown as D1Database,
    JWT_SECRET: secret(process.env.JWT_SECRET), META_APP_SECRET: secret(process.env.META_APP_SECRET),
    OPENAIKEY: process.env.OPENAIKEY ? secret(process.env.OPENAIKEY) : undefined,
    OPENAI_REALTIME_MODEL: process.env.OPENAI_REALTIME_MODEL,
    TURNSTILE_SITE_KEY: secret(process.env.TURNSTILE_SITE_KEY), TURNSTILE_SECRET_KEY: secret(process.env.TURNSTILE_SECRET_KEY),
    DISCORD_CLIENT_ID: secret(process.env.DISCORD_CLIENT_ID), DISCORD_CLIENT_SECRET: secret(process.env.DISCORD_CLIENT_SECRET),
    REDIS_URL: process.env.REDIS_URL,
    RECFLARE_PLAYER_SETTINGS: redis,
    CDN_ASSETS: cdn, IMAGES: img,
    DOMAIN: process.env.DOMAIN || 'localhost', SUBDOMAINS: process.env.SUBDOMAINS || '{}',
    NAME: 'railway', ENVIRONMENT: process.env.NODE_ENV || 'production', SENTRY_RELEASE: process.env.SENTRY_RELEASE || 'unknown',
    AUTH: undefined as undefined | { fetch: (request: Request) => Promise<Response> },
    RECFLARE_MAX_API_UPLOAD_BYTES: process.env.RECFLARE_MAX_API_UPLOAD_BYTES || process.env.MAX_API_UPLOAD_BYTES,
    ...Object.fromEntries([
      'PHOTON_REALTIME_APP_ID', 'PHOTON_VOICE_APP_ID', 'PHOTON_CHAT_APP_ID', 'PHOTON_REGION',
      'TACHYON_HOST_PORT', 'TACHYON_HOST_PORT_SANDBOX', 'STARTING_TOKENS', 'ROOM_REDIRECTS',
      'MAX_UPLOAD_BYTES', 'MAX_ACCOUNTS_PER_PLATFORM_ID', 'MAX_ACCOUNTS_PER_IP', 'MAX_ROOMS_PER_ACCOUNT',
      'MAX_CLUBS_PER_ACCOUNT', 'MAX_TOKEN_GIFT', 'MAX_XP_GIFT', 'BAN_EVASION_MATCH',
      'DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_BENEFITS_ROLE_IDS', 'DISCORD_ROLE_TOKENS',
      'IMG_SIGNING_KEY', 'IMG_SIGNING_ENABLED',
    ].map(name => [name, process.env[name]])),
  }
  const hub = new NodeNotificationsHub(`${db.path}.notifications.sqlite`, base)
  const assets: Record<string, FileAssets> = {
    cdn: new FileAssets(resolve(repo, 'apps/cdn/static')),
    discovery: new FileAssets(resolve(repo, 'apps/discovery/static')),
    econ: new FileAssets(resolve(repo, 'apps/econ/static/storefronts')),
    img: new FileAssets(resolve(repo, 'apps/img/static')),
    www: new FileAssets(resolve(repo, 'apps/www/dist/client'), true),
  }
  return { base: { ...base, RECFLARE_NOTIFICATIONS_HUB: hub.namespace }, redis, cdn, img, hub, assets }
}

export type RailwayEnvironment = ReturnType<typeof buildEnvironment>
