import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Necessário para o estágio `prod` do Dockerfile: gera .next/standalone.
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // `pg` roda só no servidor; não empacotar no bundle do cliente.
    serverActions: { bodySizeLimit: '8mb' },
  },
  serverExternalPackages: ['pg'],
}

export default nextConfig
