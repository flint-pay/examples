// Small inline icons. Decorative unless a label is given.

type IconProps = { label?: string; className?: string };

function Svg({ label, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {children}
    </svg>
  );
}

export const LockIcon = (props: IconProps) => <Svg {...props}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>;
export const CheckIcon = (props: IconProps) => <Svg {...props}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const TruckIcon = (props: IconProps) => <Svg {...props}><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="17.5" r="1.8" /><circle cx="17.5" cy="17.5" r="1.8" /></Svg>;
export const StoreIcon = (props: IconProps) => <Svg {...props}><path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10h18M9 20v-6h6v6" /></Svg>;
export const ChevronDownIcon = (props: IconProps) => <Svg {...props}><path d="M6 9l6 6 6-6" /></Svg>;
export const InfoIcon = (props: IconProps) => <Svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>;
export const AlertIcon = (props: IconProps) => <Svg {...props}><path d="M12 3l9.5 17h-19z" /><path d="M12 10v4M12 17h.01" /></Svg>;
export const BagIcon = (props: IconProps) => <Svg {...props}><path d="M5 8h14l-1 12H6z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></Svg>;
export const LeafIcon = (props: IconProps) => <Svg {...props}><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z" /><path d="M5 19l7-7" /></Svg>;
export const ClockIcon = (props: IconProps) => <Svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const ReturnIcon = (props: IconProps) => <Svg {...props}><path d="M9 14l-5-5 5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></Svg>;
export const MailIcon = (props: IconProps) => <Svg {...props}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></Svg>;
export const BankIcon = (props: IconProps) => <Svg {...props}><path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18" /></Svg>;

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="14" fill="#1f5a3d" />
      <path d="M40 20a16 16 0 1 0 0 24" fill="none" stroke="#f6f1e8" strokeWidth="6" strokeLinecap="round" />
      <circle cx="44" cy="32" r="3.5" fill="#f3c98b" />
    </svg>
  );
}
