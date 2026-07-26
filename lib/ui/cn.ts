import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Junta classes resolvendo conflitos do Tailwind (a última ganha). */
export function cn(...classes: ClassValue[]): string {
  return twMerge(clsx(classes))
}
