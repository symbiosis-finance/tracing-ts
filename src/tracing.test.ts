/// <reference lib="deno.ns" />
// `async () => value` stubs intentionally have no await — they satisfy the `() => Promise<R>` signature.
// deno-lint-ignore-file require-await
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd'
import { assertSnapshot } from '@std/testing/snapshot'
import { FakeTime } from '@std/testing/time'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { setTimeout as delaySetTimeout } from 'node:timers'
import { trace } from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-node'
import {
    configureTracing,
    type ShutdownTracing,
    type TracingConfig,
    tracingConfigSchema,
    withRootSpan,
    withRootTracing,
    withSpan,
    withSpanSync,
    withTracing,
    withTracingGenerator,
    withYieldSpan,
} from './index.ts'

// ─── OTLP/HTTP JSON shapes ────────────────────────────────────────────────────
// Minimal subset of the OTLP/HTTP traces export shape that tests inspect.

interface OtlpAttribute {
    key: string
    value: { stringValue?: string; intValue?: string | number; boolValue?: boolean }
}
interface OtlpSpanEvent {
    name: string
    attributes?: OtlpAttribute[]
}
interface OtlpSpan {
    name: string
    kind?: number
    traceId: string
    spanId: string
    parentSpanId?: string
    attributes?: OtlpAttribute[]
    status?: { code?: number }
    events?: OtlpSpanEvent[]
    links?: Array<{ traceId: string; spanId: string }>
}
interface OtlpScopeSpans {
    scope?: { name?: string }
    spans?: OtlpSpan[]
}
interface OtlpResourceSpans {
    resource?: { attributes?: OtlpAttribute[] }
    scopeSpans?: OtlpScopeSpans[]
}
interface OtlpBody {
    resourceSpans?: OtlpResourceSpans[]
}

// ─── Mock OTLP Collector ──────────────────────────────────────────────────────

interface CapturedExport {
    method: string
    path: string
    contentType: string
    headers: Record<string, string>
    body: unknown
}

function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') out[k.toLowerCase()] = v
    }
    return out
}

class MockCollector {
    exports: CapturedExport[] = []
    #server: Server | null = null
    url = ''

    async start(handler?: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
        const defaultHandler = (req: IncomingMessage, res: ServerResponse) => {
            const chunks: Buffer[] = []
            req.on('data', (c: Buffer) => chunks.push(c))
            req.on('end', () => {
                const body = Buffer.concat(chunks)
                const contentType = String(req.headers['content-type'] ?? '')
                let parsed: unknown
                try {
                    parsed = JSON.parse(body.toString('utf-8'))
                } catch {
                    parsed = { _raw: true, contentType, size: body.length }
                }
                this.exports.push({
                    method: req.method!,
                    path: req.url!,
                    contentType,
                    headers: normalizeHeaders(req.headers),
                    body: parsed,
                })
                res.writeHead(200)
                res.end()
            })
        }
        const inner = handler ?? defaultHandler
        await new Promise<void>((resolve) => {
            this.#server = createServer((req, res) => {
                // Prevent HTTP keep-alive so Deno's sanitizer doesn't flag leaked TCP connections.
                res.setHeader('Connection', 'close')
                inner(req, res)
            })
            this.#server.listen(0, '127.0.0.1', () => {
                const { port } = this.#server!.address() as { port: number }
                this.url = `http://127.0.0.1:${port}`
                resolve()
            })
        })
    }

    async stop(): Promise<void> {
        if (!this.#server) return
        const srv = this.#server as Server & { closeAllConnections?: () => void }
        srv.closeAllConnections?.()
        await new Promise<void>((resolve, reject) => {
            this.#server!.close((err) => (err ? reject(err) : resolve()))
        })
        this.#server = null
    }

    reset() {
        this.exports = []
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(httpUrl?: string, timeoutMillis?: number): TracingConfig {
    return tracingConfigSchema.parse({
        processor: 'simple',
        ...(httpUrl ? { http: { url: httpUrl, timeoutMillis } } : {}),
    })
}

async function initTracing(url: string, timeoutMillis = 500): Promise<ShutdownTracing> {
    return configureTracing({
        serviceName: 'test-service',
        serviceVersion: '0.0.0-test',
        tracerName: 'test',
        config: makeConfig(url, timeoutMillis),
    })
}

async function teardownTracing(shutdown: ShutdownTracing): Promise<void> {
    try {
        await shutdown()
    } catch {
        // Ignore shutdown errors — expected with broken endpoints
    }
    trace.disable()
}

async function collectAsyncGen<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const results: T[] = []
    for await (const v of gen) results.push(v)
    return results
}

async function getUnusedPort(): Promise<number> {
    return new Promise((resolve) => {
        const server = createServer()
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number }
            server.close(() => resolve(port))
        })
    })
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────
// Strip dynamic fields (IDs, timestamps, host info) for deterministic snapshots.

const DYNAMIC_ATTR_KEYS = new Set(['host.name', 'process.pid', 'process.vpid'])

function sanitize(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj
    if (typeof obj !== 'object') return obj
    if (Array.isArray(obj)) return obj.map(sanitize)

    const record = obj as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
        // Replace IDs and timestamps with placeholders
        if (['traceId', 'spanId', 'parentSpanId'].includes(key) && typeof value === 'string' && value.length > 0) {
            out[key] = '[id]'
        } else if (['startTimeUnixNano', 'endTimeUnixNano', 'timeUnixNano'].includes(key)) {
            out[key] = '[timestamp]'
        } // Strip dynamic resource attributes
        else if (key === 'key' && DYNAMIC_ATTR_KEYS.has(value as string)) {
            return null // signal to parent array to drop this entry
        } else {
            out[key] = sanitize(value)
        }
    }
    return out
}

function sanitizeExport(exp: CapturedExport): unknown {
    return {
        method: exp.method,
        path: exp.path,
        contentType: exp.contentType,
        body: sanitizeBody(exp.body),
    }
}

function sanitizeBody(body: unknown): unknown {
    if (typeof body !== 'object' || body === null) return body
    if (!('resourceSpans' in body)) return sanitize(body)
    const otlp = body as OtlpBody
    return {
        resourceSpans: (otlp.resourceSpans ?? []).map((rs) => ({
            resource: { attributes: sanitizeAttributes(rs.resource?.attributes ?? []) },
            scopeSpans: (rs.scopeSpans ?? []).map((ss) => ({
                scope: { name: ss.scope?.name },
                spans: (ss.spans ?? []).map(sanitizeSpan),
            })),
        })),
    }
}

function sanitizeSpan(span: OtlpSpan): unknown {
    return {
        name: span.name,
        kind: span.kind,
        attributes: span.attributes ?? [],
        status: span.status,
        events: (span.events ?? []).map((e) => ({
            name: e.name,
            attributes: (e.attributes ?? []).map((a) => {
                // Strip stacktraces — they contain absolute paths
                if (a.key === 'exception.stacktrace') {
                    return { key: a.key, value: { stringValue: '[stacktrace]' } }
                }
                return a
            }),
        })),
    }
}

function sanitizeAttributes(attrs: OtlpAttribute[]): unknown[] {
    return attrs.filter((a) => !DYNAMIC_ATTR_KEYS.has(a.key)).map(sanitize).filter(Boolean)
}

// ─── Span extraction helpers ─────────────────────────────────────────────────

function getAllSpans(collector: MockCollector): OtlpSpan[] {
    return collector.exports.flatMap((exp) => {
        const body = exp.body as OtlpBody | null
        return (body?.resourceSpans ?? []).flatMap((rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []))
    })
}

function getSpanNames(collector: MockCollector): string[] {
    return getAllSpans(collector).map((s) => s.name)
}

async function flushTracer(): Promise<void> {
    const provider = trace.getTracerProvider() as { getDelegate?: () => { forceFlush?: () => Promise<void> } }
    await provider.getDelegate?.().forceFlush?.()
}

// ─── Resilience assertion suite ───────────────────────────────────────────────

async function assertTracingIsTransparent(): Promise<void> {
    const asyncResult = await withSpan('test.async', { attrs: { key: 'value' } }, async () => 42)
    assert.equal(asyncResult, 42)

    const syncResult = withSpanSync('test.sync', {}, () => 42)
    assert.equal(syncResult, 42)

    const rootResult = await withRootSpan('test.root', {}, async () => 42)
    assert.equal(rootResult, 42)

    const genResults = await collectAsyncGen(
        withYieldSpan('test.gen', {}, async function* () {
            yield 1
            yield 2
            yield 3
        }),
    )
    assert.deepEqual(genResults, [1, 2, 3])

    await assert.rejects(
        () =>
            withSpan('test.err', {}, async () => {
                throw new Error('expected')
            }),
        { message: 'expected' },
    )

    assert.throws(
        () =>
            withSpanSync('test.err-sync', {}, () => {
                throw new Error('expected-sync')
            }),
        { message: 'expected-sync' },
    )

    const bigintResult = await withSpan('test.bigint', { attrs: { amount: 1000000000000000000n } }, async () => 'ok')
    assert.equal(bigintResult, 'ok')

    class Svc {
        @withTracing()
        async work(): Promise<string> {
            return 'decorated'
        }

        @withTracingGenerator()
        async *items(): AsyncGenerator<number> {
            yield 10
        }
    }
    const svc = new Svc()
    assert.equal(await svc.work(), 'decorated')
    assert.deepEqual(await collectAsyncGen(svc.items()), [10])
}

// ─── Smoke tests ──────────────────────────────────────────────────────────────

describe('smoke tests', () => {
    const collector = new MockCollector()
    let shutdown: ShutdownTracing

    beforeAll(async () => {
        await collector.start()
        shutdown = await initTracing(collector.url)
    })

    afterAll(async () => {
        await teardownTracing(shutdown)
        await collector.stop()
    })

    it('configureTracing returns a shutdown function', () => {
        assert.equal(typeof shutdown, 'function')
    })

    it('withSpan wraps async functions', async () => {
        const result = await withSpan('smoke.async', {}, async () => 42)
        assert.equal(result, 42)
    })

    it('withSpanSync wraps sync functions', () => {
        const result = withSpanSync('smoke.sync', {}, () => 42)
        assert.equal(result, 42)
    })

    it('withRootSpan creates root spans', async () => {
        const result = await withRootSpan('smoke.root', {}, async () => 42)
        assert.equal(result, 42)
    })

    it('withYieldSpan wraps generators', async () => {
        const results = await collectAsyncGen(
            withYieldSpan('smoke.gen', {}, async function* () {
                yield 1
                yield 2
                yield 3
            }),
        )
        assert.deepEqual(results, [1, 2, 3])
    })

    it('withSpan propagates errors', async () => {
        await assert.rejects(
            () =>
                withSpan('smoke.err', {}, async () => {
                    throw new Error('boom')
                }),
            { message: 'boom' },
        )
    })

    it('withSpanSync propagates errors', () => {
        assert.throws(
            () =>
                withSpanSync('smoke.err-sync', {}, () => {
                    throw new Error('boom')
                }),
            { message: 'boom' },
        )
    })

    it('withSpan supports success attributes via onReturn', async () => {
        const result = await withSpan(
            'smoke.attrs',
            { attrs: { input: 'x' }, onReturn: (r) => ({ out: r }) },
            async () => 42,
        )
        assert.equal(result, 42)
    })

    it('withSpan handles bigint attributes', async () => {
        const result = await withSpan('smoke.bigint', { attrs: { amount: 10n } }, async () => 'ok')
        assert.equal(result, 'ok')
    })

    it('withTracing decorator wraps class methods', async () => {
        class Svc {
            @withTracing()
            async work(): Promise<string> {
                return 'done'
            }
        }
        assert.equal(await new Svc().work(), 'done')
    })

    it('withTracing decorator passes onCall/onReturn attributes', async () => {
        class Svc {
            @withTracing<Svc, [number], number>({
                onCall(_x: number) {
                    return { input: _x }
                },
                onReturn(_r: number) {
                    return { output: _r }
                },
            })
            async compute(x: number): Promise<number> {
                return x * 2
            }
        }
        assert.equal(await new Svc().compute(21), 42)
    })

    it('withTracingGenerator decorator wraps generator methods', async () => {
        class Svc {
            @withTracingGenerator()
            async *items(): AsyncGenerator<number> {
                yield 1
                yield 2
            }
        }
        assert.deepEqual(await collectAsyncGen(new Svc().items()), [1, 2])
    })

    it('works without HTTP endpoint configured', async () => {
        const noHttpShutdown = await configureTracing({
            serviceName: 'test-noop',
            serviceVersion: '0.0.0',
            tracerName: 'test-noop',
            config: tracingConfigSchema.parse({}),
        })
        const result = await withSpan('noop.test', {}, async () => 42)
        assert.equal(result, 42)
        await noHttpShutdown()
    })

    it('tracingConfigSchema validates config', () => {
        const config = tracingConfigSchema.parse({
            enableConsole: true,
            processor: 'batch',
            http: {
                url: 'http://localhost:4318/v1/traces',
                headers: { 'X-Token': 'abc' },
                auth: { username: 'user', password: 'pass' },
            },
            mutedSpans: ['health.check'],
        })
        assert.equal(config.enableConsole, true)
        assert.equal(config.processor, 'batch')
        assert.deepEqual(config.mutedSpans, ['health.check'])
        assert.equal(config.minSpanDurationUs, 0)
    })

    it('exports spans to collector as JSON', async (t) => {
        collector.reset()

        await withSpan('snapshot.test', { attrs: { myAttr: 'hello' } }, async () => 'ok')
        await flushTracer()

        assert.ok(collector.exports.length > 0, 'Expected at least one export')
        assert.equal(collector.exports[0].contentType, 'application/json')
        assert.equal(collector.exports[0].method, 'POST')

        await assertSnapshot(t, collector.exports.map(sanitizeExport))
    })
})

// ─── Dynamic span name tests ──────────────────────────────────────────────

describe('decorator dynamic span name', () => {
    const collector = new MockCollector()
    let shutdown: ShutdownTracing

    beforeAll(async () => {
        await collector.start()
        shutdown = await initTracing(collector.url)
    })

    afterAll(async () => {
        await teardownTracing(shutdown)
        await collector.stop()
    })

    it('withTracing uses ClassName.method when name is omitted', async () => {
        collector.reset()
        class MyService {
            @withTracing()
            async doWork(): Promise<string> {
                return 'ok'
            }
        }
        assert.equal(await new MyService().doWork(), 'ok')
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('MyService.doWork'))
    })

    it('withTracing uses static string name', async () => {
        collector.reset()
        class MyService {
            @withTracing({ name: 'custom.static.name' })
            async doWork(): Promise<string> {
                return 'ok'
            }
        }
        assert.equal(await new MyService().doWork(), 'ok')
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('custom.static.name'))
    })

    it('withTracing uses function name with args', async () => {
        collector.reset()
        class MyService {
            @withTracing<MyService, [string, number], string>({
                name(_id: string, _n: number) {
                    return `process:${_id}:${_n}`
                },
            })
            async process(id: string, n: number): Promise<string> {
                return `${id}-${n}`
            }
        }
        const svc = new MyService()
        assert.equal(await svc.process('abc', 42), 'abc-42')
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('process:abc:42'))
    })

    it('withTracing name function receives correct this', async () => {
        collector.reset()
        class MyService {
            tag = 'mytag'
            @withTracing<MyService, [string], string>({
                name(id: string) {
                    return `${this.tag}:${id}`
                },
            })
            async process(id: string): Promise<string> {
                return id
            }
        }
        assert.equal(await new MyService().process('x'), 'x')
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('mytag:x'))
    })

    it('withTracingGenerator uses function name with args', async () => {
        collector.reset()
        class MyService {
            @withTracingGenerator<MyService, [string], number>({
                name(prefix: string) {
                    return `gen:${prefix}`
                },
            })
            async *items(prefix: string): AsyncGenerator<number> {
                void prefix
                yield 1
                yield 2
            }
        }
        assert.deepEqual(await collectAsyncGen(new MyService().items('test')), [1, 2])
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('gen:test'))
    })

    it('withTracingGenerator uses static string name', async () => {
        collector.reset()
        class MyService {
            @withTracingGenerator({ name: 'gen.static' })
            async *items(): AsyncGenerator<number> {
                yield 1
            }
        }
        assert.deepEqual(await collectAsyncGen(new MyService().items()), [1])
        await flushTracer()
        assert.ok(getSpanNames(collector).includes('gen.static'))
    })
})

// ─── withTracingGenerator span hierarchy tests ──────────────────────────────

describe('withTracingGenerator span hierarchy', () => {
    const collector = new MockCollector()
    let shutdown: ShutdownTracing

    beforeAll(async () => {
        await collector.start()
        shutdown = await initTracing(collector.url)
    })

    afterAll(async () => {
        await teardownTracing(shutdown)
        await collector.stop()
    })

    it('creates parent span, iteration child spans, and nests inner spans under iterations', async () => {
        collector.reset()

        class Svc {
            @withTracingGenerator()
            async *items(): AsyncGenerator<number> {
                await withSpan('inner.work.0', {}, async () => 'a')
                yield 1
                await withSpan('inner.work.1', {}, async () => 'b')
                yield 2
            }
        }

        assert.deepEqual(await collectAsyncGen(new Svc().items()), [1, 2])
        await flushTracer()

        const spans = getAllSpans(collector)

        // Find the parent span for the whole generator
        const parent = spans.find((s) => s.name === 'Svc.items')
        assert.ok(parent, 'Expected parent span "Svc.items"')

        // Find iteration spans
        const iter0 = spans.find((s) => s.name === 'Svc.items[0]')
        const iter1 = spans.find((s) => s.name === 'Svc.items[1]')
        assert.ok(iter0, 'Expected iteration span "Svc.items[0]"')
        assert.ok(iter1, 'Expected iteration span "Svc.items[1]"')

        // Iteration spans are children of the parent
        assert.equal(iter0.parentSpanId, parent.spanId)
        assert.equal(iter1.parentSpanId, parent.spanId)

        // All spans share the same trace
        assert.equal(iter0.traceId, parent.traceId)
        assert.equal(iter1.traceId, parent.traceId)

        // Inner spans created inside the generator are children of their iteration span
        const inner0 = spans.find((s) => s.name === 'inner.work.0')
        const inner1 = spans.find((s) => s.name === 'inner.work.1')
        assert.ok(inner0, 'Expected inner span "inner.work.0"')
        assert.ok(inner1, 'Expected inner span "inner.work.1"')

        assert.equal(inner0.parentSpanId, iter0.spanId, 'inner.work.0 should be child of iteration [0]')
        assert.equal(inner1.parentSpanId, iter1.spanId, 'inner.work.1 should be child of iteration [1]')

        assert.equal(inner0.traceId, parent.traceId)
        assert.equal(inner1.traceId, parent.traceId)
    })

    it('creates an iteration span for the final completion call', async () => {
        collector.reset()

        class Svc {
            @withTracingGenerator()
            async *single(): AsyncGenerator<string> {
                yield 'only'
            }
        }

        assert.deepEqual(await collectAsyncGen(new Svc().single()), ['only'])
        await flushTracer()

        const spans = getAllSpans(collector)
        const parent = spans.find((s) => s.name === 'Svc.single')
        assert.ok(parent)

        // iteration [0] yields 'only', iteration [1] completes the generator
        const iter0 = spans.find((s) => s.name === 'Svc.single[0]')
        const iter1 = spans.find((s) => s.name === 'Svc.single[1]')
        assert.ok(iter0, 'Expected iteration span [0]')
        assert.ok(iter1, 'Expected final iteration span [1]')
        assert.equal(iter0.parentSpanId, parent.spanId)
        assert.equal(iter1.parentSpanId, parent.spanId)
    })

    it('records error on iteration span and parent when generator throws', async () => {
        collector.reset()

        class Svc {
            @withTracingGenerator()
            async *failing(): AsyncGenerator<number> {
                yield 1
                throw new Error('generator failed')
            }
        }

        await assert.rejects(
            () => collectAsyncGen(new Svc().failing()),
            { message: 'generator failed' },
        )
        await flushTracer()

        const spans = getAllSpans(collector)
        const parent = spans.find((s) => s.name === 'Svc.failing')
        assert.ok(parent)
        assert.equal(parent.status?.code, 2, 'Parent span should have ERROR status')

        // The iteration that threw should also have error status
        const errorIter = spans.find(
            (s) => s.name.startsWith('Svc.failing[') && s.status?.code === 2,
        )
        assert.ok(errorIter, 'Expected an iteration span with ERROR status')
    })

    it('adds links from generator iteration spans to the active caller span', async () => {
        collector.reset()

        class Svc {
            @withTracingGenerator()
            async *items(): AsyncGenerator<number> {
                yield 1
                yield 2
            }
        }

        await withSpan('outer.caller', {}, async () => {
            const gen = new Svc().items()
            assert.equal((await gen.next()).value, 1)
            assert.equal((await gen.next()).value, 2)
            assert.equal((await gen.next()).done, true)
        })
        await flushTracer()

        const spans = getAllSpans(collector)
        const outer = spans.find((s) => s.name === 'outer.caller')
        assert.ok(outer, 'Expected outer caller span')

        const iter0 = spans.find((s) => s.name === 'Svc.items[0]')
        const iter1 = spans.find((s) => s.name === 'Svc.items[1]')
        assert.ok(iter0, 'Expected iteration span "Svc.items[0]"')
        assert.ok(iter1, 'Expected iteration span "Svc.items[1]"')

        const hasOuterLink = (span: OtlpSpan) =>
            (span.links ?? []).some((l) => l.traceId === outer.traceId && l.spanId === outer.spanId)

        assert.ok(hasOuterLink(iter0), 'Expected iteration [0] to link to outer caller span')
        assert.ok(hasOuterLink(iter1), 'Expected iteration [1] to link to outer caller span')
    })
})

// ─── Resilience tests ─────────────────────────────────────────────────────────

interface ResilienceScenario {
    name: string
    setup(): Promise<{ url: string; teardown(): Promise<void> }>
}

const scenarios: ResilienceScenario[] = [
    {
        name: 'endpoint returns 400 Bad Request',
        async setup() {
            const collector = new MockCollector()
            await collector.start((_req, res) => {
                res.writeHead(400)
                res.end('Bad Request')
            })
            return { url: collector.url, teardown: () => collector.stop() }
        },
    },
    {
        name: 'endpoint returns 500 Internal Server Error',
        async setup() {
            const collector = new MockCollector()
            await collector.start((_req, res) => {
                res.writeHead(500)
                res.end('Internal Server Error')
            })
            return { url: collector.url, teardown: () => collector.stop() }
        },
    },
    {
        name: 'endpoint returns 429 Too Many Requests',
        async setup() {
            const collector = new MockCollector()
            await collector.start((_req, res) => {
                res.writeHead(429)
                res.end('Too Many Requests')
            })
            return { url: collector.url, teardown: () => collector.stop() }
        },
    },
    {
        name: 'connection refused (nothing listening)',
        async setup() {
            const port = await getUnusedPort()
            return { url: `http://127.0.0.1:${port}`, teardown: async () => {} }
        },
    },
    {
        name: 'DNS does not resolve',
        async setup() {
            return { url: 'http://nonexistent.invalid:4318', teardown: async () => {} }
        },
    },
    {
        name: 'endpoint is unresponsive (never replies)',
        async setup() {
            const pending: ServerResponse[] = []
            const collector = new MockCollector()
            await collector.start((_req, res) => {
                pending.push(res)
                // Never respond
            })
            return {
                url: collector.url,
                async teardown() {
                    for (const res of pending) {
                        try {
                            res.end()
                        } catch { /* socket may already be closed by the client */ }
                    }
                    await collector.stop()
                },
            }
        },
    },
]

for (const scenario of scenarios) {
    describe(`resilience: ${scenario.name}`, () => {
        let shutdown: ShutdownTracing
        let teardown: () => Promise<void>

        beforeAll(async () => {
            const ctx = await scenario.setup()
            shutdown = await initTracing(ctx.url)
            teardown = ctx.teardown
        })

        afterAll(async () => {
            await teardownTracing(shutdown)
            await teardown()
        })

        it('does not affect execution', assertTracingIsTransparent)
    })
}

// Extra: verify instrumented code doesn't block waiting for slow exports
describe('resilience: slow endpoint does not add latency', () => {
    let shutdown: ShutdownTracing
    const pending: ServerResponse[] = []
    const collector = new MockCollector()

    beforeAll(async () => {
        await collector.start((_req, res) => {
            pending.push(res)
            // Never respond
        })
        shutdown = await initTracing(collector.url)
    })

    afterAll(async () => {
        for (const res of pending) {
            try {
                res.end()
            } catch { /* socket may already be closed by the client */ }
        }
        await teardownTracing(shutdown)
        await collector.stop()
    })

    it('withSpan completes without waiting for export', async () => {
        const start = performance.now()
        const result = await withSpan('timing.async', {}, async () => 42)
        const elapsed = performance.now() - start

        assert.equal(result, 42)
        assert.ok(elapsed < 1000, `Expected <1s but took ${elapsed.toFixed(0)}ms`)
    })

    it('withSpanSync completes without waiting for export', () => {
        const start = performance.now()
        const result = withSpanSync('timing.sync', {}, () => 42)
        const elapsed = performance.now() - start

        assert.equal(result, 42)
        assert.ok(elapsed < 1000, `Expected <1s but took ${elapsed.toFixed(0)}ms`)
    })
})

// ─── Sampler / muting tests ──────────────────────────────────────────────────

describe('sampling', () => {
    const collector = new MockCollector()
    let shutdown: ShutdownTracing

    afterAll(async () => {
        await teardownTracing(shutdown)
        await collector.stop()
    })

    it('mutedSpans config drops spans by name; unmuted spans pass through', async () => {
        await collector.start()
        shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: { url: collector.url, timeoutMillis: 500 },
                mutedSpans: ['health.check'],
            }),
        })

        await withSpan('health.check', {}, async () => 1)
        await withSpan('real.work', {}, async () => 2)
        await flushTracer()

        const names = getSpanNames(collector)
        assert.ok(!names.includes('health.check'), 'muted span should be dropped')
        assert.ok(names.includes('real.work'), 'unmuted span should be exported')
    })
})

describe('custom spanFilter', () => {
    it('overrides mutedSpans entirely and decides per-name', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: { url: collector.url, timeoutMillis: 500 },
                mutedSpans: ['health.check'], // should be ignored when spanFilter is provided
            }),
            spanFilter: (name) => name.startsWith('drop.'),
        })
        try {
            await withSpan('health.check', {}, async () => 1) // not dropped — spanFilter overrides mutedSpans
            await withSpan('drop.this', {}, async () => 2)
            await withSpan('keep.this', {}, async () => 3)
            await flushTracer()

            const names = getSpanNames(collector)
            assert.ok(names.includes('health.check'), 'mutedSpans is bypassed when spanFilter is set')
            assert.ok(!names.includes('drop.this'), 'spans matching spanFilter are dropped')
            assert.ok(names.includes('keep.this'))
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── HTTP exporter wiring tests ──────────────────────────────────────────────

describe('http exporter', () => {
    it('applies Basic auth header from config.http.auth', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: {
                    url: collector.url,
                    timeoutMillis: 500,
                    auth: { username: 'alice', password: 's3cret' },
                },
            }),
        })
        try {
            await withSpan('auth.test', {}, async () => 1)
            await flushTracer()

            assert.ok(collector.exports.length > 0, 'expected at least one export')
            const expected = `Basic ${btoa('alice:s3cret')}`
            assert.equal(collector.exports[0].headers.authorization, expected)
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })

    it('forwards custom config.http.headers to the exporter', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: {
                    url: collector.url,
                    timeoutMillis: 500,
                    headers: { 'X-Tenant-Id': 'tenant-42' },
                },
            }),
        })
        try {
            await withSpan('hdr.test', {}, async () => 1)
            await flushTracer()

            assert.ok(collector.exports.length > 0)
            assert.equal(collector.exports[0].headers['x-tenant-id'], 'tenant-42')
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── extraProcessors injection ───────────────────────────────────────────────

describe('extraProcessors', () => {
    it('invokes caller-supplied processors on span lifecycle', async () => {
        const started: string[] = []
        const ended: string[] = []
        const probe: SpanProcessor = {
            onStart(span) {
                started.push(span.name)
            },
            onEnd(span) {
                ended.push(span.name)
            },
            forceFlush: () => Promise.resolve(),
            shutdown: () => Promise.resolve(),
        }
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({}), // no http endpoint — probe is the only sink
            extraProcessors: [probe],
        })
        try {
            await withSpan('probe.outer', {}, async () => {
                await withSpan('probe.inner', {}, async () => 1)
            })

            assert.deepEqual(started, ['probe.outer', 'probe.inner'])
            assert.deepEqual(ended, ['probe.inner', 'probe.outer'])
        } finally {
            await teardownTracing(shutdown)
        }
    })
})

// ─── resourceAttributes ──────────────────────────────────────────────────────

describe('resourceAttributes', () => {
    it('merges caller-supplied attributes into the OTLP Resource', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: { url: collector.url, timeoutMillis: 500 },
                resourceAttributes: new Map([['deployment.environment', 'staging'], ['team', 'core']]),
            }),
        })
        try {
            await withSpan('res.test', {}, async () => 1)
            await flushTracer()

            const body = collector.exports[0].body as OtlpBody
            const attrs = body.resourceSpans?.[0].resource?.attributes ?? []
            const env = attrs.find((a) => a.key === 'deployment.environment')
            const team = attrs.find((a) => a.key === 'team')
            assert.equal(env?.value.stringValue, 'staging')
            assert.equal(team?.value.stringValue, 'core')
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── onReturn / error semantics ──────────────────────────────────────────────

describe('onReturn semantics', () => {
    it('does NOT call onReturn when fn throws', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await initTracing(collector.url)
        try {
            let onReturnCalls = 0
            await assert.rejects(
                () =>
                    withSpan(
                        'fail.with.onReturn',
                        {
                            onReturn: () => {
                                onReturnCalls++
                                return { result: 'should-not-appear' }
                            },
                        },
                        async () => {
                            throw new Error('boom')
                        },
                    ),
                { message: 'boom' },
            )
            assert.equal(onReturnCalls, 0, 'onReturn must not run on throw')

            await flushTracer()
            const span = getAllSpans(collector).find((s) => s.name === 'fail.with.onReturn')
            assert.ok(span)
            const resultAttr = (span.attributes ?? []).find((a) => a.key === 'result')
            assert.equal(resultAttr, undefined, 'onReturn-derived attribute must not be present')
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })

    it('records ERROR status without an exception event when a non-Error value is thrown', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await initTracing(collector.url)
        try {
            await assert.rejects(
                () =>
                    withSpan('throw.string', {}, async () => {
                        throw 'not-an-error'
                    }),
                (e) => e === 'not-an-error',
            )
            await flushTracer()
            const span = getAllSpans(collector).find((s) => s.name === 'throw.string')
            assert.ok(span)
            assert.equal(span.status?.code, 2, 'status should be ERROR')
            assert.equal(
                (span.events ?? []).some((e) => e.name === 'exception'),
                false,
                'no exception event when non-Error is thrown',
            )
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── bigint end-to-end ───────────────────────────────────────────────────────

describe('bigint attribute serialization', () => {
    it('reaches the collector as a string value', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await initTracing(collector.url)
        try {
            await withSpan('bigint.e2e', { attrs: { amount: 1_000_000_000_000_000_000n } }, async () => 'ok')
            await flushTracer()

            const span = getAllSpans(collector).find((s) => s.name === 'bigint.e2e')
            assert.ok(span)
            const amount = (span.attributes ?? []).find((a) => a.key === 'amount')
            assert.equal(amount?.value.stringValue, '1000000000000000000')
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── withRootTracing decorator ───────────────────────────────────────────────

describe('withRootTracing decorator', () => {
    it('produces a root span even when invoked inside an active parent span', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await initTracing(collector.url)
        try {
            class Svc {
                @withRootTracing<Svc, [number], number>({
                    onCall(x) {
                        return { input: x }
                    },
                    onReturn(r) {
                        return { output: r }
                    },
                })
                async compute(x: number): Promise<number> {
                    return x * 2
                }
            }

            await withSpan('caller.span', {}, async () => {
                assert.equal(await new Svc().compute(21), 42)
            })
            await flushTracer()

            const spans = getAllSpans(collector)
            const caller = spans.find((s) => s.name === 'caller.span')
            const decorated = spans.find((s) => s.name === 'Svc.compute')
            assert.ok(caller)
            assert.ok(decorated)

            assert.equal(decorated.parentSpanId, undefined, 'root span must have no parent')
            assert.notEqual(decorated.traceId, caller.traceId, 'root span must start a new trace')

            const input = (decorated.attributes ?? []).find((a) => a.key === 'input')
            const output = (decorated.attributes ?? []).find((a) => a.key === 'output')
            assert.equal(input?.value.intValue?.toString(), '21')
            assert.equal(output?.value.intValue?.toString(), '42')
        } finally {
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

describe('minSpanDurationUs filtering', () => {
    it('filters short spans when minSpanDurationUs is set', async () => {
        const collector = new MockCollector()
        await collector.start()
        const shutdown = await configureTracing({
            serviceName: 'test-service',
            serviceVersion: '0.0.0-test',
            tracerName: 'test',
            config: tracingConfigSchema.parse({
                processor: 'simple',
                http: { url: collector.url, timeoutMillis: 500 },
                minSpanDurationUs: 100_000,
            }),
        })

        const time = new FakeTime()
        try {
            await withSpan('short.span', {}, async () => {})
            await withSpan('long.span', {}, async () => {
                const sleep = new Promise<void>((resolve) => delaySetTimeout(resolve, 150))
                await time.tickAsync(150)
                await sleep
            })
            await flushTracer()

            const spanNames = getSpanNames(collector)
            assert.ok(spanNames.includes('long.span'))
            assert.ok(!spanNames.includes('short.span'))
        } finally {
            time.restore()
            await teardownTracing(shutdown)
            await collector.stop()
        }
    })
})

// ─── Permission tests ────────────────────────────────────────────────────────

Deno.test({
    name: 'configureTracing works without sys permission (no hostname)',
    permissions: { sys: [], read: true, env: true, net: true },
    async fn() {
        const shutdown = await configureTracing({
            serviceName: 'test-no-sys',
            serviceVersion: '0.0.0',
            tracerName: 'test-no-sys',
            config: tracingConfigSchema.parse({}),
        })
        const result = await withSpan('no-sys.test', {}, async () => 42)
        assert.equal(result, 42)
        await shutdown()
        trace.disable()
    },
})
