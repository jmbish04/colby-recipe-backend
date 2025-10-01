import { Context } from 'hono';

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  R2_IMAGES: R2Bucket;
  AI: Ai;
  BROWSER: Fetcher;
  EMBED_MODEL: string;
  CHAT_MODEL: string;
}

export async function resolveUser(c: Context<{ Bindings: Env }>): Promise<string> {
  const env = c.env;
  
  // Check for Cloudflare Access JWT
  // NOTE: This implementation trusts the JWT when the application is behind Cloudflare Access.
  // For a low-risk recipe app, this is acceptable since:
  // 1. Cloudflare Access validates the JWT before forwarding the request
  // 2. The Cf-Access-Jwt-Assertion header is only set by Cloudflare Access
  // 3. Direct access to the worker should be blocked via Access policies
  // 
  // For higher security requirements, implement JWT signature verification using the
  // public keys from your team's JWKS endpoint at:
  // https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/certs
  const cfAccessJwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (cfAccessJwt) {
    try {
      const parts = cfAccessJwt.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        const userId = payload.sub || payload.email;
        const email = payload.email;
        const name = payload.name;
        const picture = payload.picture;
        
        // Upsert user
        await env.DB.prepare(
          `INSERT INTO users (id, email, name, picture_url, updated_at) 
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) 
           ON CONFLICT(id) DO UPDATE SET 
             email = excluded.email,
             name = excluded.name,
             picture_url = excluded.picture_url,
             updated_at = CURRENT_TIMESTAMP`
        ).bind(userId, email, name, picture).run();
        
        return userId;
      }
    } catch (e) {
      console.error('Error parsing CF Access JWT:', e);
    }
  }
  
  // Check for dev token
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const sessionKey = `kv:sess:${token}`;
    const session = await env.KV.get(sessionKey, 'json') as { user_id: string; expires: number } | null;
    
    if (session && session.expires > Date.now()) {
      return session.user_id;
    }
  }
  
  return 'anon';
}

export function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
