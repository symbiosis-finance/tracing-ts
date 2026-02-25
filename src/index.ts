/**
 * OpenTelemetry tracing wrapper for Deno/TypeScript.
 *
 * Provides one-call setup via {@linkcode configureTracing}, span helpers
 * ({@linkcode withSpan}, {@linkcode withSpanSync}, {@linkcode withRootSpan},
 * {@linkcode withYieldSpan}), and class method decorators
 * ({@linkcode withTracing}, {@linkcode withTracingGenerator}) with automatic
 * error recording and BigInt serialisation.
 *
 * @example
 * ```ts
 * import { configureTracing, withSpan, tracingConfigSchema } from "@symbiosis-finance/tracing";
 *
 * const shutdown = await configureTracing({
 *   serviceName: "my-service",
 *   tracerName: "my-service",
 *   config: tracingConfigSchema.parse({ http: { url: "http://localhost:4318/v1/traces" } }),
 * });
 *
 * const result = await withSpan("my-operation", { key: "value" }, async () => {
 *   return 42;
 * });
 * ```
 *
 * @module
 */
export {
    configureTracing,
    getVersion,
    tracingConfigSchema,
    withRootSpan,
    withSpan,
    withSpanSync,
    withTracing,
    withTracingGenerator,
    withYieldSpan,
} from './tracing.ts'

export type {
    AnyArgs,
    AsyncMethod,
    AttributeLike,
    AttributesLike,
    DecoratorOptions,
    Method,
    ShutdownTracing,
    SpanFilter,
    TracingConfig,
    TracingInitOptions,
} from './tracing.ts'

export { serializeBigInts } from './serialize.ts'
export type { SerializedBigInt } from './serialize.ts'
