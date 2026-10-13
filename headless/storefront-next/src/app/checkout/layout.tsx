import { CheckoutHeader } from '@/components/SiteHeader.tsx';

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CheckoutHeader storeName={process.env.STORE_NAME || 'Cedar & Stone'} backHref="/cart" />
      <main id="main" tabIndex={-1} className="wrap">{children}</main>
    </>
  );
}
