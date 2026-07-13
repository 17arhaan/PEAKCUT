import type { Metadata } from "next";
import { Geist, Geist_Mono, Archivo, IBM_Plex_Mono, Inter } from "next/font/google";
import "@/lib/env";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Landing-page-only type system: Archivo (display), IBM Plex Mono (data /
// evidence readouts), Inter (body). Loaded globally like the Geist fonts
// above so the class name is stable, but only referenced by app/page.tsx.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["700", "800"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://peakcut.app"),
  title: {
    default: "Peakcut — long video in, clips with receipts out",
    template: "%s · Peakcut",
  },
  description: "Long video in. Viral clips out — with receipts.",
  openGraph: {
    title: "Peakcut — long video in, clips with receipts out",
    description:
      "An agent crew scores every moment against measured signals and ships each clip with the evidence behind its score.",
    url: "/",
    siteName: "Peakcut",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Peakcut" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Peakcut — long video in, clips with receipts out",
    description: "Every clip ships with its receipts.",
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // Tells Next.js our smooth scroll is intentional for anchor jumps but
      // should be suppressed during route transitions (no animated scroll-to-top
      // on navigation).
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable} ${archivo.variable} ${plexMono.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
