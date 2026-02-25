/**
 * A recursive type that transforms all bigint properties to strings.
 */
export type SerializedBigInt<T> = T extends bigint ? string
  : T extends Array<infer U> ? Array<SerializedBigInt<U>>
  : T extends object ? { [K in keyof T]: SerializedBigInt<T[K]> }
  : T

/**
 * Recursively converts all BigInt values in an object to strings.
 * Useful for preparing data for JSON.stringify.
 */
export function serializeBigInts<T>(obj: T): SerializedBigInt<T> {
  // 1. Handle BigInt directly
  if (typeof obj === "bigint") {
    return obj.toString() as SerializedBigInt<T>
  }

  // 2. Handle Arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => serializeBigInts(item)) as SerializedBigInt<T>
  }

  // 3. Handle Objects (and not null)
  if (typeof obj === "object" && obj !== null) {
    const toJSON = (obj as { toJSON?: () => unknown }).toJSON
    if (typeof toJSON === "function") {
      return serializeBigInts(toJSON.call(obj)) as SerializedBigInt<T>
    }
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, serializeBigInts(value)]),
    ) as SerializedBigInt<T>
  }

  // 4. Return primitives as-is (string, number, boolean, etc.)
  return obj as SerializedBigInt<T>
}
