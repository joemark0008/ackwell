import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

export function zodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export function validationError(error: z.ZodError): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    issues: zodIssues(error),
  });
}

/** Validates and transforms a request part with a Zod schema; 400 with issues on failure. */
export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) throw validationError(r.error);
    return r.data;
  }
}

/** Zod schema → OpenAPI schema object for @ApiBody / @ApiResponse. */
export function openApi(schema: ZodType, io: 'input' | 'output' = 'input'): Record<string, any> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  return rest;
}
