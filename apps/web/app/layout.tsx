import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "sys4sys — backend operations",
  description:
    "ポート・ログ・監視・AI レポートをまとめるバックエンド運用管理システム",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
