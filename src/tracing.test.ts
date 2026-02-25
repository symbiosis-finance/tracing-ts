import { describe, it, beforeAll, afterAll } from 'jsr:@std/testing/bdd'
import { assertSnapshot } from 'jsr:@std/testing/snapshot'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { trace } from '@opentelemetry/api'
import {
    configureTracing,
    withSpan,
    withSpanSync,
    withRootSpan,
    withYieldSpan,
    withTracing,
    withTracingGenerator,
    tracingConfigSchema,
    type TracingConfig,
    type ShutdownTracing,
} from './index.ts'


// ─── Mock OTLP Collector ──────────────────────────────────────────────────────

interface CapturedExport {
    method: string
    path: string
    contentType: string
    body: unknown
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
        ;(this.#server as any).closeAllConnections?.()
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
        }
        // Strip dynamic resource attributes
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
    const b = body as Record<string, unknown>
    if ('resourceSpans' in b) {
        return {
            resourceSpans: (b.resourceSpans as unknown[]).map((rs: any) => ({
                resource: {
                    attributes: sanitizeAttributes(rs.resource?.attributes ?? []),
                },
                scopeSpans: (rs.scopeSpans ?? []).map((ss: any) => ({
                    scope: { name: ss.scope?.name },
                    spans: (ss.spans ?? []).map(sanitizeSpan),
                })),
            })),
        }
    }
    return sanitize(body)
}

function sanitizeSpan(span: any): unknown {
    return {
        name: span.name,
        kind: span.kind,
        attributes: span.attributes ?? [],
        status: span.status,
        events: (span.events ?? []).map((e: any) => ({
            name: e.name,
            attributes: (e.attributes ?? []).map((a: any) => {
                // Strip stacktraces — they contain absolute paths
                if (a.key === 'exception.stacktrace') {
                    return { key: a.key, value: { stringValue: '[stacktrace]' } }
                }
                return a
            }),
        })),
    }
}

function sanitizeAttributes(attrs: any[]): unknown[] {
    return attrs.filter((a: any) => !DYNAMIC_ATTR_KEYS.has(a.key)).map(sanitize).filter(Boolean)
}

// ─── Resilience assertion suite ───────────────────────────────────────────────

async function assertTracingIsTransparent(): Promise<void> {
    const asyncResult = await withSpan('test.async', { key: 'value' }, async () => 42)
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

    const bigintResult = await withSpan('test.bigint', { amount: 1000000000000000000n }, async () => 'ok')
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

    it('withSpan supports success attributes', async () => {
        const result = await withSpan('smoke.attrs', { input: 'x' }, async () => 42, (r) => ({ out: r }))
        assert.equal(result, 42)
    })

    it('withSpan handles bigint attributes', async () => {
        const result = await withSpan('smoke.bigint', { amount: 10n }, async () => 'ok')
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
    })

    it('exports spans to collector as JSON', async (t) => {
        collector.reset()

        await withSpan('snapshot.test', { myAttr: 'hello' }, async () => 'ok')
        // Flush pending exports so the mock server receives them before we assert.
        // deno-lint-ignore no-explicit-any
        await (trace.getTracerProvider() as any).getDelegate?.().forceFlush?.()

        assert.ok(collector.exports.length > 0, 'Expected at least one export')
        assert.equal(collector.exports[0].contentType, 'application/json')
        assert.equal(collector.exports[0].method, 'POST')

        await assertSnapshot(t, collector.exports.map(sanitizeExport))
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
                        try { res.end() } catch {}
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
            try { res.end() } catch {}
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
