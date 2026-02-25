# @symbiosis-finance/tracing

OpenTelemetry tracing wrapper for Deno/TypeScript. Provides one-call setup, span helpers, and class method decorators with automatic error recording and BigInt serialization.

## Install

```sh
deno add jsr:@symbiosis-finance/tracing
```

Or add to your import map:

```jsonc
{
  "imports": {
    "@symbiosis-finance/tracing": "jsr:@symbiosis-finance/tracing"
  }
}
```

## Usage

### Initialize tracing

```ts
import { configureTracing, tracingConfigSchema } from "@symbiosis-finance/tracing";

const config = tracingConfigSchema.parse({
  http: { url: "https://tempo.example.com/v1/traces" },
});

const shutdown = await configureTracing({
  serviceName: "my-service",
  tracerName: "my-service",
  config,
});

// On process exit:
await shutdown();
```

### Wrap async functions

```ts
import { withSpan } from "@symbiosis-finance/tracing";

const result = await withSpan("fetch-user", { userId: "123" }, async (span) => {
  return await db.getUser("123");
});
```

### Class method decorators

```ts
import { withTracing } from "@symbiosis-finance/tracing";

class UserService {
  @withTracing({ onCall: (id: string) => ({ userId: id }) })
  async getUser(id: string) {
    return await db.getUser(id);
  }
}
```

### Generator support

```ts
import { withYieldSpan, withTracingGenerator } from "@symbiosis-finance/tracing";

// Standalone
async function* fetchPages() {
  yield* withYieldSpan("fetch-pages", {}, async function* (span) {
    for await (const page of paginate()) yield page;
  });
}

// Decorator
class Streamer {
  @withTracingGenerator()
  async *streamData() {
    // automatically traced
  }
}
```

## Config

The `tracingConfigSchema` (Zod) accepts:

| Field               | Type                        | Default   | Description                        |
|---------------------|-----------------------------|-----------|------------------------------------|
| `http`              | `{ url, headers?, auth? }`  | —         | OTLP HTTP exporter endpoint        |
| `http.timeoutMillis`| `number`                    | —         | Export timeout                     |
| `enableConsole`     | `boolean`                   | `false`   | Also log spans to console          |
| `processor`         | `"simple" \| "batch"`       | `"batch"` | Span processor type                |
| `resourceAttributes`| `Map<string, string>`       | `{}`      | Extra OTEL resource attributes     |
| `mutedSpans`        | `string[]`                  | `[]`      | Span names to drop via sampler     |

## Test

```sh
deno task test
```

## License

MIT
