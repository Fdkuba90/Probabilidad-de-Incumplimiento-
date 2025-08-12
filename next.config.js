/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "pdf-parse",
      "formidable",
      "@napi-rs/canvas",
      "tesseract.js",
      "pdfjs-dist"         // <-- añade esto
    ]
  }
};
module.exports = nextConfig;
