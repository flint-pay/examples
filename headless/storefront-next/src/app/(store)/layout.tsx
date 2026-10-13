import { SiteHeader } from '@/components/SiteHeader.tsx';
import { visitor } from '@/server/session.ts';

export default async function StoreLayout({ children }: { children: React.ReactNode }) {
  const found = await visitor({ mutating: false });
  const cart = found ? found.rt.carts.current(found.session, found.user) : undefined;
  const cartCount = found && cart ? found.rt.carts.lines(cart).reduce((sum, line) => sum + line.quantity, 0) : 0;
  const config = found?.rt.config;
  return (
    <>
      <SiteHeader
        storeName={config?.storeName ?? 'Cedar & Stone'}
        user={found?.user ? { name: found.user.name, email: found.user.email } : null}
        cartCount={cartCount}
        accountOrigin={config?.accountOrigin ?? null}
      />
      <main id="main" tabIndex={-1} className="wrap">
        {children}
      </main>
    </>
  );
}
