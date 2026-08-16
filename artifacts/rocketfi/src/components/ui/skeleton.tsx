import { cn } from '@/lib/utils';

/**
 * Skeleton — dark glassmorphism shimmer block.
 *
 * Uses a CSS pseudo-element sweep (translateX -100% → 100%) so the
 * shimmer works on any background without a separate keyframe per color.
 * The `shimmer` keyframe is defined in index.css.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        // Base: slightly more visible than pure transparent
        'relative overflow-hidden rounded-md bg-zinc-800/70',
        // Shimmer sweep via ::before
        'before:absolute before:inset-0',
        'before:-translate-x-full',
        'before:animate-[shimmer_1.6s_ease-in-out_infinite]',
        'before:bg-gradient-to-r',
        'before:from-transparent',
        'before:via-white/[0.07]',
        'before:to-transparent',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
