import { BRAND } from '@/lib/brand';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: BRAND.title,
  description: 'Interview scheduling, panel assessment and decisions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">{children}</body>
    </html>
  );
}
