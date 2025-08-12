/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // por si Next intenta empacar dependencias nativas en serverless
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "formidable"]
  }
};
module.exports = nextConfig;
