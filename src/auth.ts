import { Env } from './env';
import { jsonResponse } from './utils';

export function extractApiKey(request: Request): string | null {
  const headerKey = request.headers.get('X-API-Key');
  if (headerKey) return headerKey.trim();
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function unauthorized(): Response {
  return jsonResponse(
    { error: 'Unauthorized' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="worker"',
      },
    }
  );
}

export function requireApiKey(request: Request, env: Env): Response | null {
  const token = extractApiKey(request);
  if (!token || token !== env.WORKER_API_KEY) {
    return unauthorized();
  }
  return null;
}
