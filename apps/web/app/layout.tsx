import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "sys4sys — backend operations",
  description:
    "ポート・ログ・監視・AI レポートをまとめるバックエンド運用管理システム",
};

const themeScript = `
  (() => {
    const key = "sys4sys.theme";
    try {
      const stored = window.localStorage.getItem(key);
      const theme =
        stored === "light" || stored === "dark"
          ? stored
          : window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark";
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    } catch {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
    }
  })();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
