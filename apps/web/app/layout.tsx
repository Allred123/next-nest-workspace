import "./globals.css";
import "streamdown/styles.css";
import "./components/StreamdownText.css";
import "./components/ToolPanels.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Next + Nest Workspace",
  description: "Monorepo demo",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
