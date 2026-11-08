import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Next } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Designed for legibility; holds up in glare and at small caption sizes over the sky.
// Next has no metric overrides for this newer face, so no size-adjusted fallback is generated.
const ui = Atkinson_Hyperlegible_Next({ subsets: ["latin"], variable: "--font-ui", display: "swap", adjustFontFallback: false });

export const metadata: Metadata = {
  title: "Drift",
  description: "Leave a message on a real cloud. Let the sky carry it.",
  applicationName: "Drift",
  icons: {
    icon: [{ url: "/brand/drift-logo.png", type: "image/png" }],
    apple: [{ url: "/brand/drift-logo.png", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "Drift", statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d1a2e",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={ui.variable}>
      <body>{children}</body>
    </html>
  );
}
