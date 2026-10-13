import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import { copy } from '@/shared/copy.ts';
import './globals.css';

// next/font downloads the fonts at build time and serves them from this app, so no page calls a font host.
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

const storeName = process.env.STORE_NAME || 'Cedar & Stone';

export const metadata: Metadata = {
  title: { default: storeName, template: `%s | ${storeName}` },
  description: copy.home.heroBody,
  icons: { icon: '/images/favicon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${fraunces.variable} ${inter.variable}`}>
      <body>
        <a className="skip-link" href="#main">{copy.skipLink}</a>
        <div className="test-banner" data-testid="sf-test-banner"><strong>{copy.testBannerLabel}</strong> {copy.testBanner}</div>
        {children}
        <footer className="site-footer">
          <div className="wrap footer-row">
            <div>
              <p className="footer-brand">{storeName}</p>
              <p>{copy.footer.note}</p>
            </div>
            <div>
              <p>{copy.footer.emailNote}</p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
