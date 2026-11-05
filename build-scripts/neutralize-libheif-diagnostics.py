#!/usr/bin/env python3
"""Strip libheif's diagnostic printers from the WASM build (see build-wasm.sh).

The dump/get_debug_info/debug_dump* family is debug-only but virtual, so the
vtable pins it, and its std::stringstream bodies drag libc++ iostream+locale
into the module (~118 KB raw on 1.23.7). This stubs their bodies and drops
the one live std::cerr (heif_image.cc). Error codes survive; streamed detail
text becomes empty — build-scripts/libheif-no-streams.h covers the remaining
stringstream sites.

Idempotent. Fails closed on a libheif bump that reshapes the diagnostics:
stub-count floor + box.cc sanity here, link-map guard in build-wasm.sh.
"""
import os
import re
import sys

ROOTS = [
    'build-wasm/src/libheif',
    'libheif',
    'src/libheif',
]

MIN_STUBS = 100  # 114 on v1.23.7; far below this means upstream reorganized
                 # the diagnostics — refuse instead of shipping a half-patch
SANITY_FILE = 'libheif/box.cc'  # must contribute at least one stub


def find_root():
    for root in ROOTS:
        if os.path.exists(os.path.join(root, SANITY_FILE)):
            return root
    print('Error: libheif source not found under any of:', file=sys.stderr)
    for root in ROOTS:
        print(f'  - {root}', file=sys.stderr)
    print("Fix: run 'git submodule update --init --recursive'.", file=sys.stderr)
    sys.exit(1)


HEADER = re.compile(
    r'^\s*(?P<ret>const std::string|std::string|void)\s+'
    r'(?P<qname>[A-Za-z_][A-Za-z0-9_:<>~* ]*::)?'
    r'(?P<name>dump(?:_children|_to_string)?|get_debug_info|get_debug_message|debug_dump\w*)'
    r'\s*\((?P<args>[^)]*)\)\s*(?P<qual>const\s*)?(?P<noexcept>noexcept\s*)?(override\s*)?$',
    re.M,
)


def match_body(text, open_idx):
    """Index just past the '}' matching the '{' at open_idx.

    Skips string/char literals and comments so braces inside them cannot
    throw the depth count off.
    """
    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        c = text[i]
        if c in '"\'':
            q, i = c, i + 1
            while i < n and text[i] != q:
                i += 2 if text[i] == '\\' else 1
            i += 1
            continue
        if c == '/' and text[i + 1:i + 2] == '/':
            i = text.find('\n', i)
            i = n if i < 0 else i
            continue
        if c == '/' and text[i + 1:i + 2] == '*':
            i = text.find('*/', i + 2)
            i = n if i < 0 else i + 2
            continue
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def write_if_changed(path, text):
    if os.path.exists(path) and open(path).read() == text:
        return False
    with open(path, 'w') as f:
        f.write(text)
    return True


def neutralize(root):
    total = 0
    box_cc_stubs = 0
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.endswith(('.cc', '.hh', '.h')):
                continue
            path = os.path.join(dirpath, fn)
            text = open(path).read()
            n = 0
            # Right-to-left so earlier match offsets stay valid after replacement.
            for m in reversed(list(HEADER.finditer(text))):
                open_idx = text.find('{', m.end())
                if open_idx < 0:
                    print(f'Error: {path}: definition without a body: {m.group(0)!r}',
                          file=sys.stderr)
                    sys.exit(1)
                # Between signature end and body '{' only whitespace is allowed —
                # anything else ('= 0;', ';') is a declaration, not a definition.
                if text[m.end():open_idx].strip() != '':
                    continue
                end = match_body(text, open_idx)
                if end is None:
                    print(f'Error: {path}: unbalanced body at: {m.group(0)!r}',
                          file=sys.stderr)
                    sys.exit(1)
                # Start the replacement AT '{' (text[:open_idx] ends on the
                # preceding newline) or every run adds a blank line.
                body = '{\n}' if m.group('ret') == 'void' else '{\n  return "";\n}'
                text = text[:open_idx] + body + text[end:]
                n += 1
            if n and write_if_changed(path, text):
                print(f'  stubbed {n:3} diagnostics in {os.path.relpath(path, root)}')
            total += n
            if path.endswith(SANITY_FILE):
                box_cc_stubs = n
    return total, box_cc_stubs


def drop_live_cerr(root):
    """Remove the std::cerr deprecation warning in heif_image.cc (live path)."""
    path = os.path.join(root, 'libheif', 'api', 'libheif', 'heif_image.cc')
    if not os.path.exists(path):
        print('Error: api/libheif/heif_image.cc not found; the tree layout '
              'changed and the live-path std::cerr statement may now be '
              'somewhere else — it pins iostream if left in.', file=sys.stderr)
        sys.exit(1)
    text = open(path).read()
    cut = re.sub(r'std::cerr\s*<<[^;]*;', ';', text)
    return write_if_changed(path, cut)


def main():
    root = find_root()
    print(f'Neutralizing libheif diagnostics under {root}/ ...')
    total, sanity = neutralize(root)
    if sanity == 0:
        print(f'Error: {SANITY_FILE} contributed no stubs — upstream renamed or '
              'reshaped the diagnostic printers; update this script.', file=sys.stderr)
        sys.exit(1)
    if total < MIN_STUBS:
        print(f'Error: only {total} diagnostics stubbed (floor {MIN_STUBS}) — the '
              'tree does not look like a patched-and-verified libheif; refusing '
              'to build a bloated or half-patched pair.', file=sys.stderr)
        sys.exit(1)
    if drop_live_cerr(root):
        print('  dropped live-path std::cerr statement in heif_image.cc')
    print(f'OK: {total} diagnostic definitions neutralized.')


if __name__ == '__main__':
    main()
