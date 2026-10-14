import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 类名合并：clsx 组合 + tailwind-merge 去重，与原 @/lib/utils 的 cn 完全一致 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
