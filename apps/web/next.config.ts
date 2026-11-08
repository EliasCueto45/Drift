import type { NextConfig } from "next";

// The Python API (or the synthetic mock) listens on :3000. Forwarding /api/* keeps
// browser and API on one origin, which the API's Origin check (DRIFT_APP_ORIGIN) needs.
const apiOrigin = process.env.DRIFT_API_ORIGIN ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The dev badge sits over the sky's bottom-left control during demos.
  devIndicators: false,
  // Phones reach the dev server through a tunnel or the LAN IP.
  allowedDevOrigins: ["*.trycloudflare.com", "192.168.*.*", "10.*.*.*"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Camera and sensors are used by this origin only; frames never leave the device.
          { key: "Permissions-Policy", value: "camera=(self), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
