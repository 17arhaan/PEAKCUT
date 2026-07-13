"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";

// Sticky landing header. Transparent while pinned to the very top; once the
// page scrolls it fades in a blurred, panel-tinted background + hairline so the
// nav stays legible over content without ever feeling heavy. (Anchor targets
// get scroll-margin-top in globals.css so #how-it-works / #pricing clear it.)
export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-40 border-b transition-colors duration-300 ${
        scrolled
          ? "border-[var(--line)] bg-[color-mix(in_oklab,var(--ink)_72%,transparent)] backdrop-blur-md"
          : "border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" aria-label="Peakcut" className="flex items-center">
          <Image src="/peakcut-logo.png" alt="Peakcut" width={1481} height={267} priority className="h-6 w-auto" />
        </Link>
        <nav className="hidden items-center gap-6 font-mono-data text-xs text-[var(--muted)] sm:flex">
          <a href="#how-it-works" className="transition-colors hover:text-[var(--text)]">
            How it works
          </a>
          <a href="#pricing" className="transition-colors hover:text-[var(--text)]">
            Pricing
          </a>
        </nav>
        <Button
          size="sm"
          render={<Link href="/signin" />}
          className="border border-[var(--line)] bg-transparent text-[var(--text)] hover:bg-[var(--panel)]"
        >
          Sign in
        </Button>
      </div>
    </header>
  );
}
