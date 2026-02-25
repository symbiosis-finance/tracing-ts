import { describe, it } from 'jsr:@std/testing/bdd'
import assert from 'node:assert/strict'
import { serializeBigInts } from './serialize.ts'

describe('serializeBigInts', () => {
    it('converts bigint to string', () => {
        assert.equal(serializeBigInts(42n), '42')
        assert.equal(serializeBigInts(0n), '0')
        assert.equal(serializeBigInts(-1n), '-1')
        assert.equal(serializeBigInts(1000000000000000000n), '1000000000000000000')
    })

    it('preserves primitives', () => {
        assert.equal(serializeBigInts('hello'), 'hello')
        assert.equal(serializeBigInts(42), 42)
        assert.equal(serializeBigInts(true), true)
        assert.equal(serializeBigInts(false), false)
        assert.equal(serializeBigInts(null), null)
        assert.equal(serializeBigInts(undefined), undefined)
    })

    it('converts bigints in arrays', () => {
        assert.deepEqual(serializeBigInts([1n, 2n, 3n]), ['1', '2', '3'])
    })

    it('handles mixed arrays', () => {
        assert.deepEqual(serializeBigInts([1n, 'two', 3, null]), ['1', 'two', 3, null])
    })

    it('converts bigints in objects', () => {
        assert.deepEqual(
            serializeBigInts({ amount: 1000000000000000000n, name: 'ETH' }),
            { amount: '1000000000000000000', name: 'ETH' },
        )
    })

    it('handles nested structures', () => {
        assert.deepEqual(
            serializeBigInts({ outer: { inner: 42n }, list: [1n, { nested: 2n }] }),
            { outer: { inner: '42' }, list: ['1', { nested: '2' }] },
        )
    })

    it('calls toJSON if present', () => {
        const obj = { toJSON: () => ({ value: 42n }) }
        assert.deepEqual(serializeBigInts(obj), { value: '42' })
    })

    it('handles empty structures', () => {
        assert.deepEqual(serializeBigInts({}), {})
        assert.deepEqual(serializeBigInts([]), [])
    })
})
