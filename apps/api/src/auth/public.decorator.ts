import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'ackwell:isPublic';
/** Skips the session guard (health checks, API-key endpoints that do their own auth). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
