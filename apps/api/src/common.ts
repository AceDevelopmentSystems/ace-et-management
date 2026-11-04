import {
  BadRequestException, CanActivate, ConflictException, ExecutionContext, ForbiddenException, Inject, Injectable,
  NotFoundException, SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { z, ZodTypeAny } from 'zod';
import { Role, TokenClaims, verifyToken } from './auth';
import { Queryable, TenantContext } from './db';

export const DB = 'DB';
export const CONFIG = 'CONFIG';
export interface AppConfig { jwtSecret: string }

const ROLES_KEY = 'roles';
const PUBLIC_KEY = 'public';
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...r: Role[]) => SetMetadata(ROLES_KEY, r);

/** Roles that may read the register. `contractor` is deliberately absent until a contractor portal exists. */
export const READERS: Role[] = ['org_admin', 'asset_manager', 'assessor', 'client_viewer'];
export const WRITERS: Role[] = ['org_admin', 'asset_manager'];
export const ADMINS: Role[] = ['org_admin'];

export const Claims = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().claims as TokenClaims);
export const tenant = (c: TokenClaims): TenantContext => ({ orgId: c.org, clientIds: c.clients });

export function parse<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  return r.data;
}

/** Authenticates every route unless @Public(). Routes without @Roles default to READERS (deny by default). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private cfg: AppConfig, @Inject(Reflector) private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers.authorization ?? '';
    const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7), this.cfg.jwtSecret) : null;
    if (!claims) throw new UnauthorizedException();
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? READERS;
    if (!roles.includes(claims.role)) throw new ForbiddenException('Insufficient role');
    req.claims = claims;
    return true;
  }
}

/** Record a change in the same transaction as the change itself. */
export async function audit(
  q: Queryable, c: TokenClaims, action: 'create' | 'update' | 'delete', entity: string, entityId: string | null, clientId: string | null,
) {
  await q.query(
    'INSERT INTO audit_log (organisation_id, client_id, user_id, action, entity, entity_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [c.org, clientId, c.sub, action, entity, entityId],
  );
}

/**
 * Partial UPDATE of one row. `table` and the column names in `columns` are fixed by the caller (never user input);
 * only the values come from the request. Undefined values are skipped. Returns the updated row or throws 404.
 */
export async function patchRow<T = Record<string, any>>(
  q: Queryable, table: string, id: string, columns: Record<string, unknown>, returning: string,
): Promise<T> {
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new BadRequestException('No fields to update');
  const sets = entries.map(([col], i) => `${col} = $${i + 2}`).join(', ');
  const rows = (await q.query<T>(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING ${returning}`, [id, ...entries.map(([, v]) => v)])).rows;
  if (!rows.length) throw new NotFoundException(`${table} not found`);
  return rows[0]!;
}

/** DELETE one row; maps foreign-key and unique violations to 409. */
export async function deleteRow(q: Queryable, table: string, id: string): Promise<void> {
  try {
    const r = await q.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows.length) throw new NotFoundException(`${table} not found`);
  } catch (e: any) {
    if (e?.code === '23503') throw new ConflictException(`${table} is still referenced by other records`);
    throw e;
  }
}
