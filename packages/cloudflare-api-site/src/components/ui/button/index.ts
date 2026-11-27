// From cloudflare-docs src/components/ui/button/variants.ts (MIT).
const base =
  'group inline-flex w-max shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap no-underline shadow-xs transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2';

const variants = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
  secondary: 'bg-card text-foreground ring ring-border hover:bg-accent hover:ring-border-strong',
};

const sizes = {
  base: 'h-9 gap-1.5 px-3 text-sm',
  lg: 'h-10 gap-2 px-4 text-sm',
};

export function buttonClass(variant: keyof typeof variants, size: keyof typeof sizes = 'lg'): string {
  return `${base} ${variants[variant]} ${sizes[size]}`;
}
