import type { Metadata, Viewport } from "next";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

const title = "megha: run T3 Code threads on Codex Cloud and Claude Code on the web";
const description =
  "An open-source ACP agent that runs T3 Code and Zed threads on Codex Cloud and Claude Code on the web, using your existing codex and claude logins.";

// The production URL isn't decided yet. Set NEXT_PUBLIC_SITE_URL in Vercel once it is; canonical and
// og:image URLs are built from it.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://megha-ten.vercel.app";

// og:image and twitter:image come from app/opengraph-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: "megha", title, description, locale: "en_US" },
  twitter: { card: "summary_large_image", title, description },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f9fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#141b26" },
  ],
};

// Plain props type instead of the generated LayoutProps, so `tsc --noEmit` passes before `next build`
// has generated route types.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh bg-bg font-sans text-base text-ink">{children}</body>
    </html>
  );
}
