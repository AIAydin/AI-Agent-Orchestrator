import { z } from 'zod';

const ProviderSessionIdSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => value.trim() === value && !value.includes('\0') && !/[\r\n]/u.test(value));

export type TestAgentCliCommand =
  | { readonly kind: 'run'; readonly providerSessionId?: string }
  | { readonly kind: 'version' }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

export function parseTestAgentCliArguments(arguments_: readonly string[]): TestAgentCliCommand {
  if (arguments_.length === 0) return { kind: 'run' };
  if (arguments_.length === 1 && (arguments_[0] === '--version' || arguments_[0] === '-v')) {
    return { kind: 'version' };
  }
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return { kind: 'help' };
  }
  if (arguments_[0] === '--resume-session') {
    const parsed = ProviderSessionIdSchema.safeParse(arguments_[1]);
    if (!parsed.success || arguments_.length !== 2) {
      return {
        kind: 'error',
        message: '--resume-session requires exactly one valid provider session ID.',
      };
    }
    return { kind: 'run', providerSessionId: parsed.data };
  }
  return { kind: 'error', message: `Unknown arguments: ${arguments_.join(' ')}` };
}
