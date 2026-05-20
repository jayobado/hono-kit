/**
 * @module
 * Typed route descriptors for API apps. Pair defineRoute() declarations into
 * arrays, then compose into a mountable Hono sub-app with defineRoutes().
 *
 *   const routes = defineRoutes([
 *     defineRoute({ method: 'POST', path: '/orders', input: { body: orderSchema },
 *                   guards: [auth.require()], handler: (c, input) => ... }),
 *   ])
 *   app.route('/api', routes)
 */

import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { StandardSchemaV1 } from '@standard-schema/spec'

// ─── Types ───────────────────────────────────────────────────────────────────

export type HttpMethod =
	| 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'

type Schema = StandardSchemaV1
type Infer<S> = S extends StandardSchemaV1<unknown, infer Out> ? Out : never

/** Where a validation issue originated. */
export type IssueSource = 'body' | 'query' | 'params'

export interface ValidationIssue {
	path: (string | number)[]
	message: string
	source: IssueSource
}

interface RouteInput<B extends Schema | undefined, Q extends Schema | undefined, P extends Schema | undefined> {
	body?: B
	query?: Q
	params?: P
}

interface ParsedInput<B, Q, P> {
	body: B extends Schema ? Infer<B> : undefined
	query: Q extends Schema ? Infer<Q> : undefined
	params: P extends Schema ? Infer<P> : undefined
}

export type RouteHandler<B, Q, P> = (c: Context, input: ParsedInput<B, Q, P>) => Response | Promise<Response>

export interface RouteDescriptor {
	method: HttpMethod
	path: string
	input?: { body?: Schema; query?: Schema; params?: Schema }
	guards?: MiddlewareHandler[]
	handler: RouteHandler<Schema | undefined, Schema | undefined, Schema | undefined>
	meta?: Record<string, unknown>
}

export interface DefineRoutesOptions {
	/** Override the default 400 response on validation failure. */
	onValidationError?: (c: Context, issues: ValidationIssue[]) => Response
}

// ─── defineRoute ─────────────────────────────────────────────────────────────

export function defineRoute
	<B extends Schema | undefined = undefined,
	Q extends Schema | undefined = undefined,
		P extends Schema | undefined = undefined,
> (opts: {
	method: HttpMethod
	path: string
	input ?: RouteInput<B, Q, P>
	guards ?: MiddlewareHandler[]
	handler: RouteHandler<B, Q, P>
	meta ?: Record<string, unknown>
}): RouteDescriptor {
	return {
		method: opts.method,
		path: opts.path,
		input: opts.input as RouteDescriptor['input'],
		guards: opts.guards,
		handler: opts.handler as RouteDescriptor['handler'],
		meta: opts.meta,
	}
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validate(
	schema: Schema,
	value: unknown,
	source: IssueSource,
): Promise<{ ok: true; value: unknown } | { ok: false; issues: ValidationIssue[] }> {
	let result = schema['~standard'].validate(value)
	if (result instanceof Promise) result = await result

	if ('issues' in result && result.issues) {
		return {
			ok: false,
			issues: result.issues.map(i => ({
				path: (i.path ?? []).map(p =>
					typeof p === 'object' && p !== null && 'key' in p
						? (p as { key: string | number }).key
						: p as string | number,
				),
				message: i.message,
				source,
			})),
		}
	}
	return { ok: true, value: (result as { value: unknown }).value }
}

function defaultValidationError(c: Context, issues: ValidationIssue[]): Response {
	return c.json({
		message: 'Validation failed',
		code: 400,
		issues,
	}, 400)
}

// ─── defineRoutes ────────────────────────────────────────────────────────────

export function defineRoutes(
	descriptors: RouteDescriptor[],
	opts: DefineRoutesOptions = {},
): Hono {
	const app = new Hono()
	const onValidationError = opts.onValidationError ?? defaultValidationError

	for (const route of descriptors) {
		const method = route.method.toLowerCase() as Lowercase<HttpMethod>
		const guards = route.guards ?? []

		const composed = async (c: Context) => {
			const parsed: { body?: unknown; query?: unknown; params?: unknown } = {
				body: undefined,
				query: undefined,
				params: undefined,
			}

			const issues: ValidationIssue[] = []

			if (route.input?.body) {
				let raw: unknown
				try {
					raw = await c.req.json()
				} catch {
					raw = undefined
				}
				const result = await validate(route.input.body, raw, 'body')
				if (result.ok) parsed.body = result.value
				else issues.push(...result.issues)
			}

			if (route.input?.query) {
				const raw = c.req.query()
				const result = await validate(route.input.query, raw, 'query')
				if (result.ok) parsed.query = result.value
				else issues.push(...result.issues)
			}

			if (route.input?.params) {
				const raw = c.req.param()
				const result = await validate(route.input.params, raw, 'params')
				if (result.ok) parsed.params = result.value
				else issues.push(...result.issues)
			}

			if (issues.length) return onValidationError(c, issues)

			return route.handler(
				c,
				parsed as ParsedInput<Schema, Schema, Schema>,
			)
		}

		// Hono's chained-middleware signature: app[method](path, mw1, mw2, ..., handler)
		// deno-lint-ignore no-explicit-any
		const m = (app as any)[method].bind(app)
		if (guards.length) {
			m(route.path, ...guards, composed)
		} else {
			m(route.path, composed)
		}
	}

	return app
}