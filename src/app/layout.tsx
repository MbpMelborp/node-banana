import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toast } from "@/components/Toast";
import { GenerationToaster } from "@/components/GenerationToast";

/**
 * The site's two faces, self-hosted at build time. Space Grotesk carries
 * dialog headings and buttons, JetBrains Mono the small uppercase labels;
 * body copy stays on the system stack (globals.css).
 */
// Local copies of Google's latin variable files: next/font/google downloads them at build time and Turbopack fails when Google answers with an extensionless /l/font?kit= URL (vercel/next.js#99114).
const spaceGrotesk = localFont({ src: "./fonts/SpaceGrotesk-latin.woff2", weight: "500 700", variable: "--font-space-grotesk", display: "swap" });
const jetbrainsMono = localFont({ src: "./fonts/JetBrainsMono-latin.woff2", weight: "400 500", variable: "--font-jetbrains-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Creativo Melborp",
  description: "Flujos de generación creativa de Melborp",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Electron's preload adds a platform styling attribute before hydration.
    // The font variables sit on <html>: the theme's --font-display and
    // --font-mono are defined on :root and resolve var() there, so a
    // variable declared further down (on body) would not be seen.
    <html lang="en" className={`dark ${spaceGrotesk.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="antialiased">
        {children}
        <Toast />
        <GenerationToaster />
      </body>
    </html>
  );
}
