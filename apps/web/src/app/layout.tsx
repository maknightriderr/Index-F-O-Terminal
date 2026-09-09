import type { Metadata, Viewport } from "next";
import "./globals.css";

// There was no viewport meta at all, which is the single biggest reason the
// terminal was unusable on a phone: with none declared, mobile browsers
// assume a ~980px desktop viewport and then scale the whole page down to
// fit, so every 10-11px label became genuinely unreadable regardless of how
// the layout was written. `width=device-width` is what makes the CSS
// breakpoints (sm:/md:/lg:) mean anything on a real device.
//
// maximumScale/userScalable are deliberately NOT restricted — pinch-zoom is
// an accessibility affordance, and on a data-dense terminal it's a
// legitimate way to read a table.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "F&O Terminal — Index & Derivatives Intelligence",
  description: "Professional Indian Market Index & F&O Derivatives Intelligence Terminal. Real-time option chains, OI analysis, Greeks, IV intelligence, market bias, strategy scanner, and AI-powered market analysis.",
  keywords: "F&O, options, futures, NIFTY, BANKNIFTY, option chain, OI, Greeks, IV, PCR, max pain, trading terminal, NSE, BSE",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
