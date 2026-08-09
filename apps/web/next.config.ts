import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Transpile workspace packages
  transpilePackages: ['@fno/shared', '@fno/analytics'],

  // Monorepo root — there's no git repo here for Turbopack to infer it from,
  // so it must be told explicitly (see next.config docs: turbopack#root-directory).
  turbopack: {
    root: path.join(__dirname, '..', '..'),
  },

  // Allow external API connections
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/api/:path*`,
      },
    ];
  },

  // Optimize for trading terminal
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
