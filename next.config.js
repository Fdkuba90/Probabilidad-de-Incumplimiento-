/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "pdf-parse",
      "formidable",
      "@napi-rs/canvas",
      "@tesseract.js/worker"
    ]
  }
};

module.exports = nextConfig;
