import { z } from 'zod';

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

const CommandExecutableSchema = CommandArgumentSchema.refine((value) => !/[\r\n]/u.test(value), {
  message: 'Command executables cannot contain line breaks.',
});

export const CommandConfigurationSchema = z
  .object({
    executable: CommandExecutableSchema.default(''),
    arguments: z.array(CommandArgumentSchema).max(512).default([]),
  })
  .strict();
export type CommandConfiguration = z.infer<typeof CommandConfigurationSchema>;
