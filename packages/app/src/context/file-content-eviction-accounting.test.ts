import { afterEach, describe, expect, test } from "bun:test"
import {
  canAdmitContentBytes,
  canAdmitFileContent,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"

describe("file content eviction accounting", () => {
  afterEach(() => {
    resetFileContentLru()
  })

  test("updates byte totals incrementally for set, overwrite, remove, and reset", () => {
    setFileContentBytes("a", 10)
    setFileContentBytes("b", 15)
    expect(getFileContentBytesTotal()).toBe(25)
    expect(getFileContentEntryCount()).toBe(2)

    setFileContentBytes("a", 5)
    expect(getFileContentBytesTotal()).toBe(20)
    expect(getFileContentEntryCount()).toBe(2)

    touchFileContent("a")
    expect(getFileContentBytesTotal()).toBe(20)

    removeFileContentBytes("b")
    expect(getFileContentBytesTotal()).toBe(5)
    expect(getFileContentEntryCount()).toBe(1)

    resetFileContentLru()
    expect(getFileContentBytesTotal()).toBe(0)
    expect(getFileContentEntryCount()).toBe(0)
  })

  test("evicts by entry cap using LRU order", () => {
    for (const i of Array.from({ length: 41 }, (_, n) => n)) {
      setFileContentBytes(`f-${i}`, 1)
    }

    const evicted: string[] = []
    evictContentLru(undefined, (path) => evicted.push(path))

    expect(evicted).toEqual(["f-0"])
    expect(getFileContentEntryCount()).toBe(40)
    expect(getFileContentBytesTotal()).toBe(40)
  })

  test("admits only entries that fit the remaining byte budget", () => {
    const chunk = 8 * 1024 * 1024
    setFileContentBytes("a", chunk)
    setFileContentBytes("b", chunk)

    expect(canAdmitFileContent("c", 3 * 1024 * 1024)).toBe(true)
    expect(canAdmitFileContent("c", 5 * 1024 * 1024)).toBe(false)
    expect(canAdmitFileContent("a", chunk)).toBe(true)
    expect(canAdmitContentBytes(3 * 1024 * 1024)).toBe(true)
    expect(canAdmitContentBytes(chunk)).toBe(false)
  })

  test("entry cap denies new paths but allows cached replacement", () => {
    for (let index = 0; index < 40; index += 1) setFileContentBytes(`e-${index}`, 1)

    expect(getFileContentEntryCount()).toBe(40)
    expect(canAdmitContentBytes(1)).toBe(true)
    expect(canAdmitFileContent("e-0", 1)).toBe(true)
    expect(canAdmitFileContent("new", 1)).toBe(false)
  })

  test("evicts by byte cap while preserving protected entries", () => {
    const chunk = 8 * 1024 * 1024
    setFileContentBytes("a", chunk)
    setFileContentBytes("b", chunk)
    setFileContentBytes("c", chunk)

    const evicted: string[] = []
    evictContentLru(new Set(["a"]), (path) => evicted.push(path))

    expect(evicted).toEqual(["b"])
    expect(getFileContentEntryCount()).toBe(2)
    expect(getFileContentBytesTotal()).toBe(chunk * 2)
  })
})
