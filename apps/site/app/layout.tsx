import type { Metadata, Viewport } from "next";
import { Eczar, Instrument_Sans, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import { SITE_URL } from "@/features/install/install";
import "./globals.css";

const instrument = Instrument_Sans({ variable: "--font-instrument", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });
// Headlines. Eczar is drawn for both Latin and Devanagari; only the Latin subset loads here.
const eczar = Eczar({ variable: "--font-eczar", subsets: ["latin"], weight: ["500", "600"] });
// "मेघ" alone, cut from Eczar 600 (1 KB) so the page doesn't load the 88 KB Devanagari subset for three
// letters. Regenerate with fonts.googleapis.com/css2?family=Eczar:wght@600&text=मेघ. License: fonts/Eczar-OFL.txt.
const megha = localFont({
  src: "./fonts/eczar-megha.woff2",
  variable: "--font-eczar-deva",
  weight: "600",
  display: "swap",
  preload: false,
});

const title = "megha: run T3 Code threads on Codex Cloud and Claude Code on the web";
const description =
  "An open-source ACP agent that runs T3 Code and Zed threads on Codex Cloud and Claude Code on the web, using your existing codex and claude logins.";

// Canonical and og:image URLs are built from NEXT_PUBLIC_SITE_URL (set in Vercel), else the production URL.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? SITE_URL;

// og:image and twitter:image come from app/opengraph-image.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  alternates: { canonical: "/" },
  openGraph: { type: "website", url: "/", siteName: "megha", title, description, locale: "en_US" },
  twitter: { card: "summary_large_image", title, description },
};

// The sky's top color in each scheme, so the browser chrome continues the page.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#c0d3eb" },
    { media: "(prefers-color-scheme: dark)", color: "#060611" },
  ],
};

// Plain props type instead of the generated LayoutProps, so `tsc --noEmit` passes before `next build`
// has generated route types.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrument.variable} ${jetbrains.variable} ${eczar.variable} ${megha.variable}`}
    >
      <body className="min-h-dvh bg-bg font-sans text-base text-ink">{children}</body>
    </html>
  );
}
