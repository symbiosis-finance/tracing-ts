import { readFileSync } from 'node:fs'
import os from 'node:os'
import {
    Attributes,
    AttributeValue,
    Context,
    Link,
    Span,
    SpanKind,
    SpanOptions,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api'
import {
    BatchSpanProcessor,
    ConsoleSpanExporter,
    NodeTracerProvider,
    ReadableSpan,
    SamplingDecision,
    SamplingResult,
    SimpleSpanProcessor,
    Span as SdkSpan,
    SpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { detectResources, resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import {
    ATTR_HOST_NAME,
    ATTR_K8S_NAMESPACE_NAME,
    ATTR_PROCESS_VPID,
} from '@opentelemetry/semantic-conventions/incubating'
import z from 'zod'
import { getLogger } from '@logtape/logtape'
import { serializeBigInts } from './serialize.ts'

const logger = getLogger('tracing')

/** Parsed tracing configuration. Obtain via {@linkcode tracingConfigSchema}. */
export interface TracingConfig {
    enableConsole: boolean
    processor: 'simple' | 'batch'
    http?: {
        url: string
        headers: Record<string, string>
        timeoutMillis?: number
        auth?: {
            username: string
            password: string
        }
    }
    resourceAttributes: Map<string, string>
    mutedSpans: string[]
}

interface TracingConfigInput {
    enableConsole?: boolean
    processor?: 'simple' | 'batch'
    http?: {
        url: string
        headers?: Record<string, string>
        timeoutMillis?: number
        auth?: {
            username: string
            password: string
        }
    }
    resourceAttributes?: Map<string, string>
    mutedSpans?: string[]
}

/** Zod schema that validates and provides defaults for {@linkcode TracingConfig}. */
export const tracingConfigSchema: z.ZodType<TracingConfig, TracingConfigInput> = z.object({
    enableConsole: z.boolean().default(false),
    processor: z.enum(['simple', 'batch']).default('batch'),
    http: z
        .object({
            url: z.url(),
            headers: z.record(z.string(), z.string()).default({}),
            timeoutMillis: z.number().optional(),
            auth: z
                .object({
                    username: z.string(),
                    password: z.string(),
                })
                .optional(),
        })
        .optional(),
    resourceAttributes: z.map(z.string(), z.string()).default(new Map()),
    mutedSpans: z.array(z.string()).default([]),
})
/** Predicate that decides whether a span should be sampled. Return `true` to mute. */
export type SpanFilter = (spanName: string) => boolean
/** Flushes pending spans and shuts down the tracer provider. */
export type ShutdownTracing = () => Promise<void>

/** Options for {@linkcode configureTracing}. */
export interface TracingInitOptions {
    serviceName: string
    serviceVersion?: string
    tracerName: string
    config: TracingConfig
    spanFilter?: SpanFilter
    /** Additional span processors injected by the caller (e.g. file exporter). */
    extraProcessors?: SpanProcessor[]
}

let _tracerName = 'uninitialized'

function getTracer() {
    return trace.getTracer(_tracerName)
}

class TraceIDLogger implements SpanProcessor {
    constructor(private upstream: SpanProcessor) {}
    forceFlush(): Promise<void> {
        return this.upstream.forceFlush()
    }
    onStart(span: SdkSpan, parentContext: Context): void {
        if (span.parentSpanContext === undefined) {
            const traceid = span.spanContext().traceId
            logger.info('trace started', { traceid, rootSpan: span.name })
        }
        this.upstream.onStart(span, parentContext)
    }
    onEnd(span: ReadableSpan): void {
        if (span.parentSpanContext === undefined) {
            const traceid = span.spanContext().traceId
            if (span.events.length === 0 || span.events[0].name !== 'exception')
                logger.info('trace ended', { traceid, rootSpan: span.name })
            else logger.warning('trace error', { traceid, rootSpan: span.name, attributes: span.events[0].attributes })
        }
        this.upstream.onEnd(span)
    }
    shutdown(): Promise<void> {
        return this.upstream.shutdown()
    }
}

/** Initialise OpenTelemetry tracing. Returns a shutdown function that flushes and tears down the provider. */
export async function configureTracing(options: TracingInitOptions): Promise<ShutdownTracing> {
    _tracerName = options.tracerName
    const config = options.config
    let spanFilter = options.spanFilter
    const spanProcessors = [] as SpanProcessor[]
    if (config.enableConsole) spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()))
    if (config.http) {
        const headers = { ...config.http.headers }
        if (config.http.auth) {
            const auth = btoa(`${config.http.auth.username}:${config.http.auth.password}`)
            headers['Authorization'] = `Basic ${auth}`
        }
        const exporter = new OTLPTraceExporter({
            url: config.http.url,
            headers,
            timeoutMillis: config.http.timeoutMillis,
            keepAlive: false, // Required for tests — the HTTP agent's connection pool leaks TCP sockets past shutdown().
        })
        const proc =
            config.processor === 'simple' ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)
        spanProcessors.push(new TraceIDLogger(proc))
    }
    if (options.extraProcessors) spanProcessors.push(...options.extraProcessors)
    const resource = detectResources({ detectors: [] })
    if (resource.waitForAsyncAttributes) await resource.waitForAsyncAttributes()
    const mutedSpans = new Set(config.mutedSpans)
    spanFilter = spanFilter ?? ((spanName: string) => mutedSpans.has(spanName))
    const sampler = {
        shouldSample: (
            context: Context,
            traceId: string,
            spanName: string,
            spanKind: SpanKind,
            attributes: Attributes,
            links: Link[],
        ): SamplingResult => {
            return {
                decision: spanFilter(spanName) ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED,
            }
        },
    }
    const res = resource.merge(
        resourceFromAttributes({
            [ATTR_SERVICE_NAME]: options.serviceName,
            [ATTR_SERVICE_VERSION]: options.serviceVersion ?? getVersion(),
            [ATTR_K8S_NAMESPACE_NAME]: getK8sNamespace(), // TODO: use OTEL Kubernetes Controller instead.
            [ATTR_PROCESS_VPID]: process.pid,
            [ATTR_HOST_NAME]: tryHostname(),
            ...Object.fromEntries(config.resourceAttributes),
        }),
    )
    const provider = new NodeTracerProvider({
        sampler,
        spanProcessors,
        resource: res,
    })
    provider.register()
    logger.info('tracing initialized', { config, resource: res.attributes })
    return async () => {
        await provider.forceFlush()
        await provider.shutdown()
    }
}

/** Execute a synchronous function inside a new span. */
export function withSpanSync<R>(name: string, options: SpanOptions, fn: (span: Span) => R): R {
    const tracer = getTracer()
    return tracer.startActiveSpan(name, options, (span: Span) => {
        try {
            const result = fn(span)
            span.setStatus({ code: SpanStatusCode.OK })
            return result
        } catch (err) {
            recordException(span, err)
            throw err
        } finally {
            span.end()
        }
    })
}

/** Execute an async function inside a new root span (no parent). */
export function withRootSpan<R>(name: string, attributes: Attributes, fn: (span: Span) => Promise<R>): Promise<R> {
    return withSpanImpl(name, { attributes, root: true }, fn)
}

/** Execute an async function inside a new span with optional success attributes. */
export function withSpan<R>(
    name: string,
    attributes: AttributesLike,
    fn: (span: Span) => Promise<R>,
    successAttrs?: (r: R) => AttributesLike,
): Promise<R> {
    return withSpanImpl(name, { attributes: convertAttributes(attributes) }, fn, successAttrs)
}

function recordException(span: Span, err: Exclude<unknown, undefined>) {
    span.setStatus({ code: SpanStatusCode.ERROR })
    // TODO: record all exception attributes too.
    if (err instanceof Error) span.recordException(err)
}

/** Wrap an async generator in a span, yielding values through. */
export async function* withYieldSpan<R>(
    name: string,
    attributes: AttributesLike,
    fn: (span: Span) => AsyncGenerator<R>,
    successAttrs?: () => AttributesLike,
): AsyncGenerator<R> {
    const tracer = getTracer()
    const span = tracer.startSpan(name, { attributes: convertAttributes(attributes) })
    try {
        yield* fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        if (successAttrs) span.setAttributes(convertAttributes(successAttrs()))
    } catch (err) {
        recordException(span, err)
        throw err
    } finally {
        span.end()
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** Shorthand for an arbitrary argument list. */
export type AnyArgs = any[]
/** An async method signature used by {@linkcode withTracing}. */
export type AsyncMethod<This, Args extends AnyArgs, Return> = (this: This, ...args: Args) => Promise<Return>
/** A method signature used by {@linkcode withTracingGenerator}. */
export type Method<This, Args extends AnyArgs, Return> = (this: This, ...args: Args) => Return
/** An attribute value that also accepts `bigint` (serialised to string). */
export type AttributeLike = AttributeValue | bigint | undefined

/** A record of span attributes that accepts `bigint` values. */
export interface AttributesLike {
    [attributeKey: string]: AttributeLike
}

/** Options for the {@linkcode withTracing} and {@linkcode withTracingGenerator} decorators. */
export interface DecoratorOptions<This extends NonNullable<any>, Args extends AnyArgs, Return = void> {
    name?: string | ((this: This, ...args: Args) => string)
    onCall?: (this: This, ...args: Args) => AttributesLike
    onReturn?: (this: This, result: Return) => AttributesLike
}

function convertAttributes(attrs: AttributesLike): Attributes {
    return serializeBigInts(attrs)
}

interface HasConstructor {
    constructor: {
        name: string
    }
}

function getSpanName<This extends HasConstructor>(owner: This, context: ClassMethodDecoratorContext<This>): string {
    return `${owner.constructor.name}.${String(context.name)}`
}

function resolveSpanName<This extends HasConstructor, Args extends AnyArgs>(
    options: DecoratorOptions<This, Args, any> | undefined,
    owner: This,
    context: ClassMethodDecoratorContext<This>,
    args: Args,
): string {
    if (options?.name === undefined) return getSpanName(owner, context)
    if (typeof options.name === 'function') return options.name.apply(owner, args)
    return options.name
}

/** Class method decorator that wraps an async method in a span. */
export function withTracing<This extends HasConstructor, Args extends AnyArgs, Return>(
    options?: DecoratorOptions<This, Args, Return>,
): (
    originalMethod: AsyncMethod<This, Args, Return> | undefined,
    context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Return>>,
) => AsyncMethod<This, Args, Return> | undefined {
    return function (
        originalMethod: AsyncMethod<This, Args, Return> | undefined,
        context: ClassMethodDecoratorContext<This, AsyncMethod<This, Args, Return>>,
    ) {
        return (
            originalMethod &&
            (async function (this: This, ...args: Args): Promise<Return> {
                return await withSpan(
                    resolveSpanName(options, this, context, args),
                    options?.onCall ? options.onCall.apply(this, args) : {},
                    () => originalMethod.apply(this, args),
                    options?.onReturn ? options.onReturn.bind(this) : undefined,
                )
            } as AsyncMethod<This, Args, Return>)
        )
    }
}

/** Class method decorator that wraps an async generator method in a span. */
export function withTracingGenerator<This extends HasConstructor, Args extends AnyArgs, YieldT>(
    options?: DecoratorOptions<This, Args>,
): (
    originalMethod: Method<This, Args, AsyncGenerator<YieldT>> | undefined,
    context: ClassMethodDecoratorContext<This, Method<This, Args, AsyncGenerator<YieldT>>>,
) => Method<This, Args, AsyncGenerator<YieldT>> | undefined {
    return function (
        originalMethod: Method<This, Args, AsyncGenerator<YieldT>> | undefined,
        context: ClassMethodDecoratorContext<This, Method<This, Args, AsyncGenerator<YieldT>>>,
    ) {
        return (
            originalMethod &&
            (async function* (this: This, ...args: Args): AsyncGenerator<YieldT> {
                return yield* withYieldSpan(
                    resolveSpanName(options, this, context, args),
                    options?.onCall ? options.onCall.apply(this, args) : {},
                    () => originalMethod.apply(this, args),
                    options?.onReturn ? options.onReturn.bind(this) : undefined,
                )
            } as Method<This, Args, AsyncGenerator<YieldT>>)
        )
    }
}

function withSpanImpl<R>(
    name: string,
    options: SpanOptions,
    fn: (span: Span) => Promise<R>,
    successAttrs?: (result: R) => AttributesLike,
): Promise<R> {
    const tracer = getTracer()
    return tracer.startActiveSpan(name, options, async (span: Span) => {
        try {
            const result = await fn(span)
            span.setStatus({ code: SpanStatusCode.OK })
            if (successAttrs) span.setAttributes(convertAttributes(successAttrs(result)))
            return result
        } catch (err) {
            recordException(span, err)
            throw err
        } finally {
            span.end()
        }
    })
}

/** Read the service version from a `./version` file, or `undefined` if absent. */
export function getVersion(): string | undefined {
    try {
        return readFileSync('./version', 'utf8').split(/\r?\n/)[0]
    } catch {}
}

function tryHostname(): string | undefined {
    try {
        return os.hostname()
    } catch {}
}

function getK8sNamespace(): string | undefined {
    try {
        return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim()
    } catch {}
}
