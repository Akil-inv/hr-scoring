/** @type {import('next').NextConfig} */

/**
 * Where the NestJS API lives during local development.
 * Not used in production — see the rewrites note below.
 */
const DEV_API_ORIGIN = process.env.DEV_API_ORIGIN || 'http://localhost:4000';

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },

  /**
   * Development-only proxy for the API's REST routes.
   *
   * Pages call these with relative paths — `fetch('/api/import/teams')`,
   * `fetch('/api/notify/send')`, `/api/export/...`. In production nginx routes
   * /api/* to the api container, so relative paths are correct there.
   *
   * Locally there is no nginx, so those requests hit the Next dev server on
   * :3000, which has no such route and returns its 404 HTML page. Code then
   * tries to JSON.parse it and fails with:
   *
   *     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
   *
   * This rewrite forwards them to the API instead. It is gated on NODE_ENV so
   * the production build has no rewrites at all and nginx keeps full control.
   *
   * Note this does NOT cover /graphql — the urql client already reads
   * NEXT_PUBLIC_API_URL for that and points straight at the API.
   */
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') return [];

    return [
      {
        source: '/api/:path*',
        destination: `${DEV_API_ORIGIN}/api/:path*`,
      },
      {
        // The schedule page fetches /graphql directly rather than going
        // through the urql client, so it needs the same treatment.
        source: '/graphql',
        destination: `${DEV_API_ORIGIN}/graphql`,
      },
    ];
  },
};

module.exports = nextConfig;
