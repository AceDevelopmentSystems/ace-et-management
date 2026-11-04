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
  q: Queryable, c: TokenClaims, action: 'create' | 'update' | 'delete' | 'restore', entity: string, entityId: string | null, clientId: string | null,
  details?: Record<string, unknown>,
) {
  await q.query(
    'INSERT INTO audit_log (organisation_id, client_id, user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [c.org, clientId, c.sub, action, entity, entityId, details ?? null],
  );
}

/**
 * A reference (region, asset type, parent asset...) must point at a LIVE row of the same client. Foreign keys cannot
 * check this: they ignore row level security, so they would accept a soft-deleted target.
 */
export async function requireLive(q: Queryable, table: 'region' | 'asset_type' | 'asset' | 'site', id: string | null | undefined, clientId: string, field: string) {
  if (!id) return;
  const r = await q.query(`SELECT 1 FROM ${table} WHERE id = $1 AND client_id = $2`, [id, clientId]);
  if (!r.rows.length) throw new BadRequestException(`${field} does not exist for this client`);
}

/** Contractors belong to the organisation, not a client; row level security already limits this to the caller's own. */
export async function requireLiveContractor(q: Queryable, id: string | null | undefined, field = 'contractorId') {
  if (!id) return;
  if (!(await q.query('SELECT 1 FROM contractor WHERE id = $1', [id])).rows.length) throw new BadRequestException(`${field} does not exist`);
}

/** Translate known Postgres errors raised by a write into 4xx responses. */
export async function guarded<T>(fn: () => Promise<T>, messages: { unique?: string; fk?: string }): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code === '23505') throw new ConflictException(messages.unique ?? 'Duplicate value');
    if (e?.code === '23503') throw new BadRequestException(messages.fk ?? 'Referenced record does not exist');
    if (e?.code === '23514') throw new BadRequestException('Value violates a constraint');
    throw e;
  }
}

/** Client a row belongs to, for the audit trail. */
export async function clientOf(q: Queryable, table: string, id: string): Promise<string | null> {
  const col = table === 'client' ? 'id' : 'client_id';
  return (await q.query<{ c: string }>(`SELECT ${col} AS c FROM ${table} WHERE id = $1`, [id])).rows[0]?.c ?? null;
}

export type Changes = Record<string, { from: unknown; to: unknown }>;

/** Record an update with what changed (old -> new). Nothing is written when no field actually changed. */
export async function auditUpdate(q: Queryable, c: TokenClaims, entity: string, entityId: string, clientId: string | null, changes: Changes) {
  if (Object.keys(changes).length > 0) await audit(q, c, 'update', entity, entityId, clientId, { changes });
}

/** Loose equality for values as the driver returns them (numeric columns come back as strings, jsonb as objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== 'boolean' && typeof b !== 'boolean') return na === nb;
  return String(a) === String(b);
}

/**
 * Partial UPDATE of one row. `table` and the column names in `columns` are fixed by the caller (never user input);
 * only the values come from the request. Undefined values are skipped. Soft-deleted rows are invisible (404).
 * Returns the updated row and what actually changed (old -> new) for the audit trail.
 */
export async function patchRow<T = Record<string, any>>(
  q: Queryable, table: string, id: string, columns: Record<string, unknown>, returning: string,
): Promise<{ row: T; changes: Changes }> {
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw new BadRequestException('No fields to update');
  const before = (await q.query<Record<string, unknown>>(`SELECT ${entries.map(([c]) => c).join(', ')} FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw new NotFoundException(`${table} not found`);
  const sets = entries.map(([col], i) => `${col} = $${i + 2}`).join(', ');
  const row = (await q.query<T>(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING ${returning}`, [id, ...entries.map(([, v]) => v)])).rows[0]!;
  const changes: Changes = {};
  for (const [col, to] of entries) if (!sameValue(before[col], to)) changes[col] = { from: before[col], to };
  return { row, changes };
}
