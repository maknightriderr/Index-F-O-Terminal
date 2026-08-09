import type { Metadata } from "next";
import "./globals.css";

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
