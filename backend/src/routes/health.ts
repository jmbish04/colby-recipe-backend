/**
 * Health API Routes
 *
 * Endpoints:
 * - GET /api/health/latest - Get the latest health check result
 * - GET /api/health/history - Get health check history
 * - POST /api/health/run - Trigger an on-demand health check
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types';
import {
  runHealthCheck,
  getLatestHealthCheck,
  getHealthCheckHistory,
} from '../services/health';

const health = new Hono<HonoEnv>();

/**
 * GET /api/health/latest
 * Returns the most recent health check result
 */
health.get('/latest', async (c) => {
  try {
    const latest = await getLatestHealthCheck(c.env);

    if (!latest) {
      return c.json({
        success: true,
        data: null,
        message: 'No health checks recorded yet',
      });
    }

    return c.json({
      success: true,
      data: latest,
    });
  } catch (error) {
    console.error('Failed to get latest health check:', error);
    return c.json(
      {
        success: false,
        error: 'Failed to retrieve health status',
      },
      500
    );
  }
});

/**
 * GET /api/health/history
 * Returns health check history (default: last 24 checks)
 */
health.get('/history', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '24', 10);
    const history = await getHealthCheckHistory(c.env, limit);

    return c.json({
      success: true,
      data: history,
      meta: {
        count: history.length,
        limit,
      },
    });
  } catch (error) {
    console.error('Failed to get health history:', error);
    return c.json(
      {
        success: false,
        error: 'Failed to retrieve health history',
      },
      500
    );
  }
});

/**
 * POST /api/health/run
 * Triggers an on-demand health check
 */
health.post('/run', async (c) => {
  try {
    const startTime = Date.now();
    const result = await runHealthCheck(c.env, 'manual');

    return c.json({
      success: true,
      data: result,
      meta: {
        timestamp: new Date().toISOString(),
        latencyMs: Date.now() - startTime,
      },
    });
  } catch (error) {
    console.error('Health check failed:', error);
    return c.json(
      {
        success: false,
        error: 'Health check failed',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      500
    );
  }
});

export { health };
