import { z } from 'zod';

import { OptionalMachineSpecificValueSchema } from '../settings/values.js';

const MAX_COMMAND_VALUE_BYTES = 32_768;

const CommandArgumentSchema = z
  .string()
  .max(MAX_COMMAND_VALUE_BYTES)
  .refine(
    (value) =>
      !value.includes('\0') &&
      new TextEncoder().encode(value).byteLength <= MAX_COMMAND_VALUE_BYTES,
    { message: 'Command arguments cannot contain NUL bytes or exceed 32 KiB.' },
  );

const CommandExecutableSchema = CommandArgumentSchema.and(OptionalMachineSpecificValueSchema);

export const CommandConfigurationSchema = z
  .object({
    executable: CommandExecutableSchema.default(''),
    arguments: z.array(CommandArgumentSchema).max(512).default([]),
  })
  .strict();
export type CommandConfiguration = z.infer<typeof CommandConfigurationSchema>;
