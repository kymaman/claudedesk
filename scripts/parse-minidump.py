#!/usr/bin/env python3
"""Minimal Windows minidump parser for ClaudeDesk crash triage.

Extracts: exception code/address + faulting thread, module ranges, and which
native module the exception address and the pointers in the dump fall into.
Recipe documented in docs/wiki/crash-conpty-heap-corruption.md.
Usage: python scripts/parse-minidump.py <path-to.dmp>
"""
import struct, sys, collections

path = sys.argv[1]
data = open(path, 'rb').read()
print(f"file: {path}  size: {len(data):,}")

sig, ver, nstreams, dir_rva = struct.unpack_from('<IIII', data, 0)
assert sig == 0x504D444D, f"not a minidump (sig={sig:#x})"  # 'MDMP'

streams = {}
off = dir_rva
for _ in range(nstreams):
    stype, dsize, rva = struct.unpack_from('<III', data, off)
    streams.setdefault(stype, (dsize, rva))
    off += 12

# --- Module list (type 4) ---
modules = []  # (name, base, size)
if 4 in streams:
    _, rva = streams[4]
    count = struct.unpack_from('<I', data, rva)[0]
    moff = rva + 4
    for _ in range(count):
        base, size, _chk, _ts, name_rva = struct.unpack_from('<QIIII', data, moff)
        nlen = struct.unpack_from('<I', data, name_rva)[0]
        name = data[name_rva+4:name_rva+4+nlen].decode('utf-16-le', 'replace')
        modules.append((name.split('\\')[-1], base, size))
        moff += 108

def mod_of(addr):
    for name, base, size in modules:
        if base <= addr < base + size:
            return name
    return None

# --- Exception (type 6) ---
exc_code = exc_addr = faulting_tid = None
if 6 in streams:
    _, rva = streams[6]
    faulting_tid, _align = struct.unpack_from('<II', data, rva)
    exc_code, exc_flags, _erec, exc_addr = struct.unpack_from('<IIQQ', data, rva + 8)
    print(f"\n=== EXCEPTION ===")
    print(f"code: {exc_code:#010x}  flags: {exc_flags:#x}  thread: {faulting_tid}")
    print(f"address: {exc_addr:#x}  -> module: {mod_of(exc_addr)}")
    names = {0xC0000374: 'HEAP CORRUPTION', 0xC0000005: 'ACCESS VIOLATION',
             0x80000003: 'BREAKPOINT', 0xC00000FD: 'STACK OVERFLOW'}
    print(f"meaning: {names.get(exc_code, 'other')}")

# --- Native module pointer scan (whole dump) ---
# Build ranges for .node addons + ntdll + the electron exe.
interesting = [(n, b, s) for (n, b, s) in modules
               if n.lower().endswith('.node') or n.lower() in ('ntdll.dll',)]
print(f"\n=== native addon modules present ===")
for n, b, s in [(n, b, s) for (n, b, s) in modules if n.lower().endswith('.node')]:
    print(f"  {n}: {b:#x}+{s:#x}")

# Count 8-byte aligned pointers landing in each interesting module range.
hits = collections.Counter()
mv = memoryview(data)
step = 8
for n, b, s in interesting:
    lo, hi = b, b + s
    cnt = 0
    # scan all u64 LE values; coarse but decisive (conpty.node vs sqlite)
    for i in range(0, len(data) - 8, step):
        v = int.from_bytes(mv[i:i+8], 'little')
        if lo <= v < hi:
            cnt += 1
    hits[n] = cnt
print(f"\n=== pointer-into-module counts (whole dump, 8-byte aligned) ===")
for n, c in hits.most_common():
    print(f"  {n}: {c}")
