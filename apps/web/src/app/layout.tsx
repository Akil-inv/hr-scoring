import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hackathon Judging Platform',
  description: 'Command centre for multi-panel hackathon judging.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
